// Очередь регистраций: если дневной лимит писем подтверждения (mailQuota, MAIL_REG_DAILY) исчерпан, аккаунт
// создаётся «в очереди» без письма. Как только лимит откроется (новые сутки по UTC), письма уходят по порядку
// очереди; ссылка в таком письме живёт QUEUED_TTL_H (8) часов — не успел, значит регистрация отменится.
// В очереди запись ждёт не дольше QUEUE_HOLD_DAYS (3) дней (её удаляет тот же TTL-индекс verifyExpires).
// Проверка — раз в 5 минут в процессе сайта (start() зовёт server.js; админ-сервер очередь не трогает).
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const mailQuota = require('./mailQuota');
const { sendVerifyEmail, maskEmail } = require('./mailer');

const QUEUED_TTL_H = Number(process.env.VERIFY_QUEUED_TTL_H) > 0 ? Number(process.env.VERIFY_QUEUED_TTL_H) : 8;
const QUEUE_HOLD_DAYS = 3;
const TICK_MS = 5 * 60 * 1000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// письмо подтверждения (и для обычной регистрации, и для очереди): ссылка с токеном во фрагменте #t=
function sendVerification(user, token, lang, ttlMinutes) {
  const link = `${config.publicUrl.replace(/\/$/, '')}/verify-email.html#t=${token}`;
  return sendVerifyEmail(user.email, user.username, link, ttlMinutes, lang);
}

// поля «в очереди»: письма нет, запись ждёт до 3 дней
const queueFields = (now = Date.now()) => ({
  verifyQueued: true,
  verifyQueuedAt: new Date(now),
  verifyExpires: new Date(now + QUEUE_HOLD_DAYS * 86400000),
});

// номер в очереди (1 — следующий)
function position(user) {
  return User.countDocuments({ verifyPending: true, verifyQueued: true, verifyQueuedAt: { $lte: user.verifyQueuedAt } });
}

// письмо не ушло из-за лимита уже после того, как аккаунт создан, — ставим в очередь
async function requeue(userId) {
  const f = queueFields();
  await User.updateOne({ _id: userId, verifyPending: true }, { $set: f });
  return f;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const left = await mailQuota.regLeft();
    if (!left) return;
    const list = await User.find({ verifyPending: true, verifyQueued: true })
      .sort({ verifyQueuedAt: 1 })
      .limit(Math.min(left, 25))
      .select('username email verifyLang verifyQueuedAt verifyExpires')
      .lean();
    for (const u of list) {
      if (!(await mailQuota.take('reg'))) break;
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      const r = await User.updateOne(
        { _id: u._id, verifyPending: true, verifyQueued: true },
        {
          $set: { verifyTokenHash: hash(token), verifySentAt: new Date(now), verifyExpires: new Date(now + QUEUED_TTL_H * 3600000) },
          $unset: { verifyQueued: 1, verifyQueuedAt: 1 },
        },
      );
      if (!r.modifiedCount) { await mailQuota.giveBack('reg'); continue; } // уже подтвердил или удалён
      try {
        await sendVerification(u, token, u.verifyLang || 'ru', QUEUED_TTL_H * 60);
        console.log(`[reg-queue] письмо из очереди → ${maskEmail(u.email)} (ссылка на ${QUEUED_TTL_H} ч)`);
      } catch (e) {
        // на прежнее место в очереди; лимит почтового сервиса — до завтра (mailer уже отметил), иначе место в лимите возвращаем
        await User.updateOne({ _id: u._id }, {
          $set: { verifyQueued: true, verifyQueuedAt: u.verifyQueuedAt, verifyExpires: u.verifyExpires },
          $unset: { verifyTokenHash: 1, verifySentAt: 1 },
        });
        if (mailQuota.isQuotaError(e)) break;
        await mailQuota.giveBack('reg');
        console.error('[reg-queue] письмо не отправлено:', e.message);
      }
    }
  } catch (e) {
    console.error('[reg-queue]', e.message);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 30000).unref();
  setInterval(tick, TICK_MS).unref();
}

module.exports = { start, tick, sendVerification, queueFields, position, requeue, QUEUED_TTL_H, QUEUE_HOLD_DAYS };
