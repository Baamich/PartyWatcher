const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { hasProfanity } = require('../services/profanity');
const router = express.Router();
const User = require('../models/User');
const config = require('../config');
const auth = require('../middleware/auth');
const { meOf } = require('../services/me');
const { TERMS_VERSION } = require('../services/terms');
const { clientIp, parseUA } = require('../services/clientInfo');
const { sendPasswordReset, sendEmailChange, isMailConfigured, maskEmail } = require('../services/mailer');
const SupportTicket = require('../models/SupportTicket');
const { createRequestTicket } = require('./support.routes');
const rateLimit = require('express-rate-limit');
const mailQuota = require('../services/mailQuota');
const regQueue = require('../services/regQueue');
const accountLog = require('../services/accountLog');
const sessions = require('../services/sessions');
const { signToken, setTokenCookie } = sessions;
const Session = require('../models/Session');
const accountDeletion = require('../services/accountDeletion');
const chatColor = require('../services/chatColor');
const notify = require('../services/notify');
const welcome = (user) => notify.send(user._id, 'system.welcome', {}, { link: notify.profileLink(user.username, 'notifications') });

// защита дневного лимита писем от спама регистрациями: с одного IP — не больше 3 регистраций за сутки
// и не больше 2 аккаунтов одновременно в очереди
const REG_PER_IP_DAY = 3;
const QUEUED_PER_IP = 2;
// ответ «ты в очереди №N»
async function queuedAnswer(req, user, key) {
  const n = await regQueue.position(user);
  return { pending: true, queued: true, position: n, message: req.t(key, { n, h: regQueue.QUEUED_TTL_H, d: regQueue.QUEUE_HOLD_DAYS }) };
}

const RESET_TTL_MIN = 30;
const VERIFY_TTL_MIN = 30; // столько живёт неподтверждённая регистрация (потом её удаляет TTL-индекс User)
const VERIFY_RESEND_MS = 2 * 60 * 1000;
const RESET_RESEND_MS = 2 * 60 * 1000; // одно письмо на аккаунт раз в 2 минуты
// сколько секунд до следующего письма (кнопки «Отправить ещё раз» показывают отсчёт)
const retryIn = (sentAt, gapMs) => (sentAt ? Math.max(0, Math.ceil((new Date(sentAt).getTime() + gapMs - Date.now()) / 1000)) : 0);

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyResets') }),
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
});

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyLogins') }),
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyRegs') }),
});
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
});
// для логинов, которых нет в базе: сравниваем с «пустышкой», чтобы время ответа не выдавало, что такого логина нет
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

// валидаторы возвращают ключ словаря ошибки (перевод — req.t) или null
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'server.auth.passShort';
  }
  if (!/^[A-Z]/.test(password)) {
    return 'server.auth.passUpper';
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'server.auth.passLetters';
  }
  if (!/\d/.test(password)) {
    return 'server.auth.passDigits';
  }
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return 'server.badEmail';
  const v = email.trim();
  if (!v) return 'server.auth.emailEmpty';
  if (v.includes(' ')) return 'server.auth.emailSpaces';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'server.auth.emailFormat';
  return null;
}

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
      return res.status(400).json({ error: req.t('server.auth.fillAll') });
    }
    if (req.body.acceptTerms !== true) {
      return res.status(400).json({ error: req.t('server.terms.mustAccept') });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: req.t('server.auth.usernameLen') });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: req.t('server.auth.usernameChars') });
    }
    if (hasProfanity(username)) return res.status(400).json({ error: req.t('server.auth.usernameBad') });

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: req.t(emailErr) });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: req.t(passErr) });

    const usernameLower = username.toLowerCase();
    let exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    // неподтверждённая регистрация, срок которой вышел (TTL-индекс удаляет с задержкой до минуты), — место свободно
    if (exists && isExpiredPending(exists)) {
      await User.deleteOne({ _id: exists._id, verifyPending: true });
      exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    }
    if (exists && exists.verifyPending) {
      return res.status(409).json({ error: req.t('server.auth.pendingExists', { n: VERIFY_TTL_MIN }) });
    }
    if (exists) {
      if (exists.usernameLower === usernameLower) {
        return res.status(409).json({ error: req.t('server.auth.usernameTaken') });
      }
      return res.status(409).json({ error: req.t('server.auth.emailTaken') });
    }

    // без настроенной почты (локальная разработка) подтверждать нечем — аккаунт сразу активен
    const needVerify = isMailConfigured();
    const ip = clientIp(req);
    if (needVerify && ip && (await User.countDocuments({ regIp: ip, createdAt: { $gt: new Date(Date.now() - 86400000) } })) >= REG_PER_IP_DAY) {
      return res.status(429).json({ error: req.t('server.auth.tooManyRegs') });
    }
    // дневной лимит писем регистрации исчерпан — аккаунт встаёт в очередь (письмо уйдёт, когда лимит откроется)
    const canSend = needVerify && (await mailQuota.take('reg'));
    if (needVerify && !canSend && ip && (await User.countDocuments({ regIp: ip, verifyPending: true, verifyQueued: true })) >= QUEUED_PER_IP) {
      return res.status(429).json({ error: req.t('server.auth.queueIpLimit') });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken = canSend ? crypto.randomBytes(32).toString('base64url') : null;
    // streamerName не передаём — pre('validate') скопирует username
    let user;
    try {
      user = await User.create({
        username, email, passwordHash,
        termsVersion: TERMS_VERSION, termsAt: new Date(),
        regIp: ip, regDevice: parseUA(req.headers).name,
        ...(needVerify ? { verifyPending: true, verifyLang: req.lang } : {}),
        ...(canSend
          ? { verifyTokenHash: hashResetToken(verifyToken), verifyExpires: new Date(Date.now() + VERIFY_TTL_MIN * 60000), verifySentAt: new Date() }
          : needVerify ? regQueue.queueFields() : {}),
      });
    } catch (e) {
      if (canSend) await mailQuota.giveBack('reg');
      throw e;
    }

    if (needVerify && !canSend) {
      const answer = await queuedAnswer(req, user, 'server.auth.regQueued');
      console.log(`[auth/register] лимит писем на сегодня — ${maskEmail(email)} в очереди №${answer.position}`);
      return res.status(201).json(answer);
    }
    if (needVerify) {
      sendVerify(user, verifyToken, req.lang).catch(async (e) => {
        console.error('[auth/register] письмо подтверждения не отправлено:', e.message);
        // лимит почтового сервиса — в очередь (письмо уйдёт завтра), иначе место в лимите возвращаем
        if (mailQuota.isQuotaError(e)) await regQueue.requeue(user._id);
        else await mailQuota.giveBack('reg');
      });
      // входа нет, пока не подтвердит почту: cookie не ставим
      return res.status(201).json({
        pending: true,
        retryIn: VERIFY_RESEND_MS / 1000,
        message: req.t('server.auth.verifySent', { email: maskEmail(email), n: VERIFY_TTL_MIN }),
      });
    }
    console.warn('[auth/register] SMTP не настроен — аккаунт активирован без подтверждения почты');
    await sessions.start(res, req, user, { main: true }); // устройство регистрации — главное
    welcome(user);
    res.status(201).json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/register]', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: req.t('server.auth.taken') });
    }
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const loginLower = String(req.body?.login ?? '').trim().toLowerCase(); // логин = username или email
    const password = req.body?.password;
    if (!loginLower || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: req.t('server.auth.loginEmpty') });
    }

    const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });
    if (user.verifyPending) {
      if (isExpiredPending(user)) {
        await User.deleteOne({ _id: user._id, verifyPending: true });
        return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }), code: 'verifyExpired' });
      }
      if (user.verifyQueued) {
        const n = await regQueue.position(user);
        return res.status(403).json({ error: req.t('server.auth.queued', { n }), code: 'queued', position: n });
      }
      return res.status(403).json({
        error: req.t('server.auth.unverified', { email: maskEmail(user.email) }), code: 'unverified',
        retryIn: retryIn(user.verifySentAt, VERIFY_RESEND_MS),
      });
    }
    // про бан говорим только тому, кто знает пароль
    if (user.banPerm) {
      return res.status(403).json({ error: banText(req, null, user.banReason), code: 'banned' });
    }
    if (user.banUntil && user.banUntil.getTime() > Date.now()) {
      return res.status(403).json({ error: banText(req, user.banUntil, user.banReason), code: 'banned' });
    }
    // аккаунт ждёт удаления: вход с паролем — только с явной отменой удаления (страница спросит)
    if (user.deleteAt) {
      if (req.body?.cancelDeletion !== true) {
        return res.status(403).json({
          error: req.t('server.account.deletionPending', { date: user.deleteAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }),
          code: 'deletionPending', deleteAt: user.deleteAt,
        });
      }
      await accountDeletion.cancel(req, user._id);
    }

    notify.login(req, user); // до записи сеанса не ждём: «новое ли устройство» смотрит историю заходов
    await sessions.start(res, req, user);
    res.json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

function isExpiredPending(u) {
  return !!u.verifyPending && (!u.verifyExpires || new Date(u.verifyExpires).getTime() <= Date.now());
}

// ссылка подтверждения: токен во фрагменте (#t=), как у сброса пароля — в логи и Referer не попадает
function sendVerify(user, token, lang) {
  return regQueue.sendVerification(user, token, lang, VERIFY_TTL_MIN);
}

// POST /auth/verify { token } — подтвердить почту по ссылке из письма: аккаунт активен, сразу входим
router.post('/verify', resetLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(400).json({ error: req.t('server.auth.verifyBadLink') });
  const user = await User.findOne({ verifyTokenHash: hashResetToken(token), verifyPending: true });
  if (!user) return res.status(400).json({ error: req.t('server.auth.verifyBadLink') });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  await User.updateOne({ _id: user._id }, { $unset: { verifyPending: 1, verifyTokenHash: 1, verifyExpires: 1, verifySentAt: 1 } });
  await sessions.start(res, req, user, { main: true }); // подтвердил почту с устройства регистрации — оно главное
  welcome(user);
  res.json({ ok: true, username: user.username });
});

// POST /auth/verify/resend { login, password } — письмо ещё раз (не чаще раза в 2 мин). С паролем: иначе по
// чужому логину можно было бы засыпать человека письмами. Срок 30 минут не продлевается
router.post('/verify/resend', resendLimiter, async (req, res) => {
  const loginLower = String(req.body?.login ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });
  if (!user.verifyPending) return res.json({ ok: true, already: true });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  if (user.verifyQueued) return res.json(await queuedAnswer(req, user, 'server.auth.queued'));
  if (user.verifySentAt && Date.now() - new Date(user.verifySentAt).getTime() < VERIFY_RESEND_MS) {
    return res.status(429).json({ error: req.t('server.auth.forgotWait'), retryIn: retryIn(user.verifySentAt, VERIFY_RESEND_MS) });
  }
  // лимит писем исчерпан — в очередь: письмо уйдёт, когда откроется (ссылка из прошлого письма пока работает)
  if (!(await mailQuota.take('reg'))) {
    Object.assign(user, await regQueue.requeue(user._id));
    return res.json(await queuedAnswer(req, user, 'server.auth.regQueued'));
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await User.updateOne({ _id: user._id }, { $set: { verifyTokenHash: hashResetToken(token), verifySentAt: new Date() } });
  try {
    await sendVerify(user, token, req.lang);
  } catch (e) {
    console.error('[auth/verify/resend] письмо не отправлено:', e.message);
    if (mailQuota.isQuotaError(e)) {
      Object.assign(user, await regQueue.requeue(user._id));
      return res.json(await queuedAnswer(req, user, 'server.auth.regQueued'));
    }
    await mailQuota.giveBack('reg');
    return res.status(502).json({ error: req.t('server.sendFailed') });
  }
  const left = Math.max(1, Math.ceil((new Date(user.verifyExpires).getTime() - Date.now()) / 60000));
  res.json({ ok: true, retryIn: VERIFY_RESEND_MS / 1000, message: req.t('server.auth.verifySent', { email: maskEmail(user.email), n: left }) });
});

// POST /auth/verify/change-email { login, password, email } — ошибся в почте при регистрации: новая почта, новое
// письмо, и 30 минут на подтверждение отсчитываются заново. Только для неподтверждённого аккаунта и с паролем
router.post('/verify/change-email', resendLimiter, async (req, res) => {
  const loginLower = String(req.body?.login ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });
  if (!user.verifyPending) return res.status(400).json({ error: req.t('server.auth.alreadyVerified') });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: req.t(emailErr) });
  if (email !== user.email) {
    const other = await User.findOne({ email, _id: { $ne: user._id } }).select('verifyPending verifyExpires').lean();
    if (other && isExpiredPending(other)) await User.deleteOne({ _id: other._id, verifyPending: true });
    else if (other) return res.status(409).json({ error: req.t('server.auth.emailTaken') });
  }
  // в очереди или лимит исчерпан — меняем только адрес, письмо уйдёт из очереди уже на новый
  if (user.verifyQueued) {
    await User.updateOne({ _id: user._id }, { $set: { email } });
    return res.json(await queuedAnswer(req, user, 'server.auth.queued'));
  }
  if (user.verifySentAt && Date.now() - new Date(user.verifySentAt).getTime() < VERIFY_RESEND_MS) {
    return res.status(429).json({ error: req.t('server.auth.forgotWait'), retryIn: retryIn(user.verifySentAt, VERIFY_RESEND_MS) });
  }
  if (!(await mailQuota.take('reg'))) {
    await User.updateOne({ _id: user._id }, { $set: { email } });
    Object.assign(user, await regQueue.requeue(user._id));
    return res.json(await queuedAnswer(req, user, 'server.auth.regQueued'));
  }
  const token = crypto.randomBytes(32).toString('base64url');
  user.email = email;
  await User.updateOne({ _id: user._id }, {
    $set: { email, verifyTokenHash: hashResetToken(token), verifySentAt: new Date(), verifyExpires: new Date(Date.now() + VERIFY_TTL_MIN * 60000) },
  });
  try {
    await sendVerify(user, token, req.lang);
  } catch (e) {
    console.error('[auth/verify/change-email] письмо не отправлено:', e.message);
    if (mailQuota.isQuotaError(e)) {
      Object.assign(user, await regQueue.requeue(user._id));
      return res.json(await queuedAnswer(req, user, 'server.auth.regQueued'));
    }
    await mailQuota.giveBack('reg');
    return res.status(502).json({ error: req.t('server.sendFailed') });
  }
  res.json({ ok: true, retryIn: VERIFY_RESEND_MS / 1000, message: req.t('server.auth.verifySent', { email: maskEmail(email), n: VERIFY_TTL_MIN }) });
});

// «Аккаунт заблокирован до 14.10.2026, 18:00. Причина: …» — дата в часовом поясе UTC (у сервера нет зоны человека)
function banText(req, until, reason) {
  const base = until
    ? req.t('server.ban.accountUntil', { until: until.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' })
    : req.t('server.ban.accountPerm');
  return reason ? base + ' ' + req.t('server.ban.reason', { reason }) : base;
}

// POST /auth/terms { accept: true } — принять текущие условия пользования (окно js/terms-gate.js)
router.post('/terms', auth, async (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: req.t('server.terms.mustAccept') });
  await User.updateOne({ _id: req.user.id }, { $set: { termsVersion: TERMS_VERSION, termsAt: new Date() } });
  auth.forgetUser(req.user.id);
  res.json({ ok: true, version: TERMS_VERSION });
});

// выход: сеанс этого устройства завершается (токен больше не примут, даже если его скопировали)
router.post('/logout', async (req, res) => {
  try {
    const payload = jwt.verify(req.cookies?.token || '', config.jwt.secret);
    if (payload.sid) await sessions.revokeWhere({ sid: payload.sid });
  } catch (_) {}
  sessions.clearTokenCookie(res);
  res.json({ status: 'ok' });
});

// POST /auth/forgot { email } — письмо со ссылкой сброса.
// Говорим прямо, если аккаунта с такой почтой нет или письмо уже ушло: регистрация и так сообщает «почта занята»,
// так что новой утечки нет, а человек сразу видит опечатку. От перебора — forgotLimiter (5 в час с IP)
router.post('/forgot', forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (validateEmail(email)) return res.status(400).json({ error: req.t('server.badEmail') });

  const okAnswer = { status: 'ok', retryIn: RESET_RESEND_MS / 1000, message: req.t('server.auth.forgotSent') };
  try {
    const user = await User.findOne({ email }).select('username email resetTokenExpires resetSentAt verifyPending').lean();
    // когда ушла прошлая ссылка: resetSentAt, у старых записей — по сроку ссылки (письмо живёт RESET_TTL_MIN)
    const resetSentAt = user?.resetSentAt ? new Date(user.resetSentAt).getTime()
      : user?.resetTokenExpires ? user.resetTokenExpires.getTime() - RESET_TTL_MIN * 60 * 1000 : 0;
    // повторный запрос раньше чем через 2 минуты не принимаем (защита ящика от флуда)
    const sentRecently = resetSentAt > Date.now() - RESET_RESEND_MS;
    if (!user) {
      console.log(`[auth/forgot] аккаунта с почтой ${maskEmail(email)} нет — письмо не отправлялось`);
      return res.status(404).json({ error: req.t('server.auth.forgotNoAccount') });
    }
    if (user.verifyPending) {
      return res.status(403).json({ error: req.t('server.auth.unverified', { email: maskEmail(email) }) });
    }
    if (sentRecently) {
      console.log(`[auth/forgot] ${maskEmail(email)}: письмо уже уходило меньше 2 мин назад — повтор пропущен`);
      return res.status(429).json({ error: req.t('server.auth.forgotWait'), retryIn: retryIn(resetSentAt, RESET_RESEND_MS) });
    }

    // дневной лимит писем сервера исчерпан (регистрации его не съедают — им оставлен свой остаток)
    if (!(await mailQuota.take('other'))) {
      console.warn(`[auth/forgot] ${maskEmail(email)}: дневной лимит писем исчерпан — письмо не отправлено`);
      return res.status(503).json({ error: req.t('server.auth.mailLimitReset') });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    // updateOne, а не save(): документ загружен не целиком, и pre('validate') стёр бы streamerNameLower
    await User.updateOne(
      { _id: user._id },
      { $set: { resetTokenHash: hashResetToken(token), resetTokenExpires: new Date(Date.now() + RESET_TTL_MIN * 60 * 1000), resetSentAt: new Date() } }
    );

    // токен во фрагменте (#): браузер не отправляет его на сервер, в логи Cloudflare/nginx и в Referer он не попадёт
    const link = `${config.publicUrl.replace(/\/$/, '')}/reset-password.html#t=${token}`;
    sendPasswordReset(user.email, user.username, link, RESET_TTL_MIN, req.lang).catch(async (e) => {
      console.error('[auth/forgot] письмо не отправлено:', e.message);
      if (!mailQuota.isQuotaError(e)) await mailQuota.giveBack('other');
    });
    res.json(okAnswer);
  } catch (err) {
    console.error('[auth/forgot]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /auth/reset { token, password } — задать новый пароль по ссылке из письма
router.post('/reset', resetLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    return res.status(400).json({ error: req.t('server.auth.badLink') });
  }
  const passErr = validatePassword(password);
  if (passErr) return res.status(400).json({ error: req.t(passErr) });

  try {
    const user = await User.findOne({
      resetTokenHash: hashResetToken(token),
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: req.t('server.auth.badLink') });

    user.passwordHash = await bcrypt.hash(password, 12);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // выкидываем все старые сессии
    user.passwordChangedAt = new Date();
    await user.save();
    auth.forgetUser(user._id);
    accountLog.record(user._id, 'password', { to: 'reset' }, req);
    // аккаунт ждал удаления: сброс пароля = вход с паролем, удаление отменяется (иначе удалился бы под живым человеком)
    if (user.deleteAt) await accountDeletion.cancel(req, user._id);
    await sessions.revokeWhere({ userId: user._id }); // все прежние входы — долой
    await sessions.start(res, req, user); // сразу входим с новым паролем
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[auth/reset]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// GET /auth/account — профиль → «Общее»: свои данные (почта целиком — страница сама прячет её под •••)
router.get('/account', auth, async (req, res) => {
  const u = await User.findById(req.user.id).select('username email createdAt streamerName passwordChangedAt regDevice pendingEmail emailChangeExpires emailChangeSentAt').lean();
  if (!u) return res.status(401).json({ error: req.t('server.userNotFound') });
  res.json({
    username: u.username,
    email: u.email,
    createdAt: u.createdAt,
    regDevice: u.regDevice || '',
    streamerName: u.streamerName || null,
    passwordChangedAt: u.passwordChangedAt || null,
    // письмо смены почты ушло и ссылка ещё жива
    pendingEmail: u.pendingEmail && u.emailChangeExpires > new Date() ? u.pendingEmail : null,
    emailRetryIn: retryIn(u.emailChangeSentAt, VERIFY_RESEND_MS),
    // «Вид чата»: свой цвет ника (не выбирал — закрепится случайный) и палитра
    chatColor: await chatColor.of(u._id),
    palette: chatColor.PALETTE,
    // пароль, почта и удаление — только с главного устройства (профиль покажет плашку)
    ...(await sessions.mainState(u._id, req.user.sid)),
  });
});

// POST /auth/chat-color { color } — цвет ника в чатах (только из палитры)
router.post('/chat-color', auth, async (req, res) => {
  if (!(await chatColor.set(req.user.id, req.body?.color))) return res.status(400).json({ error: req.t('server.account.badColor') });
  res.json({ ok: true, chatColor: String(req.body.color).toLowerCase() });
});

// POST /auth/password { current, password, confirm, agree: true } — смена пароля из профиля.
// Все сессии выходят (tokenVersion), текущая получает новый токен и остаётся
router.post('/password', auth, resetLimiter, sessions.requireMain, async (req, res) => {
  const current = String(req.body?.current || '');
  const password = String(req.body?.password || '');
  if (req.body?.agree !== true) return res.status(400).json({ error: req.t('server.account.mustAgree') });
  const passErr = validatePassword(password);
  if (passErr) return res.status(400).json({ error: req.t(passErr) });
  if (String(req.body?.confirm || '') !== password) return res.status(400).json({ error: req.t('server.account.passMismatch') });
  if (password === current) return res.status(400).json({ error: req.t('server.account.passSame') });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: req.t('server.userNotFound') });
    if (!current || !(await bcrypt.compare(current, user.passwordHash))) {
      return res.status(400).json({ error: req.t('server.account.badPassword'), code: 'badPassword' });
    }
    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordChangedAt = new Date();
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save(); // документ целиком — pre('validate') не сотрёт streamerNameLower
    auth.forgetUser(user._id);
    accountLog.record(user._id, 'password', { to: 'change' }, req);
    // остальные сеансы — долой; этот остаётся с новой tokenVersion
    const sid = req.user.sid;
    await sessions.revokeWhere(sid ? { userId: user._id, sid: { $ne: sid } } : { userId: user._id });
    if (sid) {
      await Session.updateOne({ sid }, { $set: { tv: user.tokenVersion } });
      setTokenCookie(res, signToken(user, sid));
    } else {
      await sessions.start(res, req, user);
    }
    console.log(`[auth/password] ${user.username}: пароль изменён, остальные сессии закрыты`);
    res.json({ ok: true, passwordChangedAt: user.passwordChangedAt });
  } catch (err) {
    console.error('[auth/password]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// ---------- смена почты из профиля ----------
// POST /auth/email { email, password } — письмо со ссылкой на новый адрес; почта меняется, только когда по ней перейдут.
// Лимит писем исчерпан — 503 code: 'mailLimit': профиль предложит заявку в поддержку (POST /auth/email/support)
async function checkNewEmail(req, user, email) {
  const err = validateEmail(email);
  if (err) return req.t(err);
  if (email === user.email) return req.t('server.account.emailSame');
  if (await User.exists({ email, _id: { $ne: user._id } })) return req.t('server.auth.emailTaken');
  return null;
}

router.post('/email', auth, resendLimiter, sessions.requireMain, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    const user = await User.findById(req.user.id).select('username email passwordHash emailChangeSentAt').lean();
    if (!user) return res.status(401).json({ error: req.t('server.userNotFound') });
    const bad = await checkNewEmail(req, user, email);
    if (bad) return res.status(400).json({ error: bad });
    if (!(await bcrypt.compare(String(req.body?.password || ''), user.passwordHash))) {
      return res.status(400).json({ error: req.t('server.account.badPassword'), code: 'badPassword' });
    }
    if (user.emailChangeSentAt && Date.now() - new Date(user.emailChangeSentAt).getTime() < VERIFY_RESEND_MS) {
      return res.status(429).json({ error: req.t('server.auth.forgotWait'), retryIn: retryIn(user.emailChangeSentAt, VERIFY_RESEND_MS) });
    }
    if (!(await mailQuota.take('other'))) {
      return res.status(503).json({ error: req.t('server.account.emailMailLimit'), code: 'mailLimit' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await User.updateOne({ _id: user._id }, {
      $set: { pendingEmail: email, emailChangeHash: hashResetToken(token), emailChangeExpires: new Date(Date.now() + VERIFY_TTL_MIN * 60000), emailChangeSentAt: new Date() },
    });
    const link = `${config.publicUrl.replace(/\/$/, '')}/verify-email.html#c=${token}`;
    try {
      await sendEmailChange(email, user.username, link, VERIFY_TTL_MIN, req.lang);
    } catch (e) {
      console.error('[auth/email] письмо не отправлено:', e.message);
      if (!mailQuota.isQuotaError(e)) await mailQuota.giveBack('other');
      await User.updateOne({ _id: user._id }, { $unset: { pendingEmail: 1, emailChangeHash: 1, emailChangeExpires: 1, emailChangeSentAt: 1 } });
      if (mailQuota.isQuotaError(e)) return res.status(503).json({ error: req.t('server.account.emailMailLimit'), code: 'mailLimit' });
      return res.status(502).json({ error: req.t('server.sendFailed') });
    }
    console.log(`[auth/email] ${user.username}: письмо смены почты → ${maskEmail(email)}`);
    notify.send(user._id, 'security.emailRequest', { to: maskEmail(email) }, { link: notify.profileLink(user.username, 'security') });
    res.json({ ok: true, pendingEmail: email, retryIn: VERIFY_RESEND_MS / 1000, message: req.t('server.account.emailSent', { email: maskEmail(email), n: VERIFY_TTL_MIN }) });
  } catch (err) {
    console.error('[auth/email]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /auth/email/confirm { token } — переход по ссылке из письма (вход не нужен: ссылку могут открыть в почтовом приложении)
router.post('/email/confirm', resetLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(400).json({ error: req.t('server.auth.badLink') });
  try {
    const user = await User.findOne({ emailChangeHash: hashResetToken(token), emailChangeExpires: { $gt: new Date() } })
      .select('username email pendingEmail').lean();
    if (!user || !user.pendingEmail) return res.status(400).json({ error: req.t('server.auth.badLink') });
    const unset = { pendingEmail: 1, emailChangeHash: 1, emailChangeExpires: 1, emailChangeSentAt: 1 };
    if (await User.exists({ email: user.pendingEmail, _id: { $ne: user._id } })) {
      await User.updateOne({ _id: user._id }, { $unset: unset });
      return res.status(409).json({ error: req.t('server.auth.emailTaken') });
    }
    await User.updateOne({ _id: user._id }, { $set: { email: user.pendingEmail }, $unset: unset });
    accountLog.record(user._id, 'email', { from: user.email, to: user.pendingEmail }, req);
    console.log(`[auth/email] ${user.username}: почта сменена → ${maskEmail(user.pendingEmail)}`);
    res.json({ ok: true, email: maskEmail(user.pendingEmail) });
  } catch (err) {
    console.error('[auth/email/confirm]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /auth/email/support { email, password } — лимит писем исчерпан: заявка в поддержку (админ сверит и сменит почту в карточке).
// Одна открытая заявка на аккаунт
// свой лимит: заявку пишут после неудачных попыток письма — общий resendLimiter к этому времени уже съеден
const emailSupportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
});
router.post('/email/support', auth, emailSupportLimiter, sessions.requireMain, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    const user = await User.findById(req.user.id).select('username email passwordHash').lean();
    if (!user) return res.status(401).json({ error: req.t('server.userNotFound') });
    const bad = await checkNewEmail(req, user, email);
    if (bad) return res.status(400).json({ error: bad });
    if (!(await bcrypt.compare(String(req.body?.password || ''), user.passwordHash))) {
      return res.status(400).json({ error: req.t('server.account.badPassword'), code: 'badPassword' });
    }
    if (await SupportTicket.exists({ userId: user._id, 'request.kind': 'emailChange', status: 'unread' })) {
      return res.status(409).json({ error: req.t('server.account.emailRequestOpen') });
    }
    const ticket = await createRequestTicket(req, user, { kind: 'emailChange', from: user.email, to: email },
      req.t('server.account.emailRequestText', { from: user.email, to: email }));
    res.json({ ok: true, number: ticket.number, message: req.t('server.account.emailRequestSent', { n: ticket.number }) });
  } catch (err) {
    console.error('[auth/email/support]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /auth/delete { password, agree: true } — запрос на удаление аккаунта: заморозка, через 3 дня удалится сам
// (services/accountDeletion.js); вход с паролем в эти дни отменяет. Владельца сайта так не удалить
router.post('/delete', auth, resetLimiter, sessions.requireMain, async (req, res) => {
  if (req.body?.agree !== true) return res.status(400).json({ error: req.t('server.account.deleteMustAgree') });
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(401).json({ error: req.t('server.userNotFound') });
    if (user.role === 'owner') return res.status(403).json({ error: req.t('server.account.ownerNoDelete') });
    if (!(await bcrypt.compare(String(req.body?.password || ''), user.passwordHash))) {
      return res.status(400).json({ error: req.t('server.account.badPassword'), code: 'badPassword' });
    }
    if (user.deleteAt) return res.json({ ok: true, deleteAt: user.deleteAt });
    const deleteAt = await accountDeletion.request(req, user, createRequestTicket);
    sessions.clearTokenCookie(res);
    res.json({ ok: true, deleteAt });
  } catch (err) {
    console.error('[auth/delete]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

router.get('/me', auth, async (req, res) => {
  const me = await meOf(req.user.id);
  if (!me) return res.status(401).json({ error: req.t('server.userNotFound') });
  res.json(me);
});

// 18+: { confirmed: true } — подтвердил возраст (отменить нельзя); { showAdult } — галочка «18+» в публичных комнатах.
// Показывать 18+ можно только после подтверждения возраста
router.patch('/adult', auth, async (req, res) => {
  const set = {};
  if (req.body?.confirmed === true) set.adultConfirmed = true;
  if (typeof req.body?.showAdult === 'boolean') set.showAdult = req.body.showAdult;
  if (!Object.keys(set).length) return res.status(400).json({ error: req.t('server.error') });
  const filter = { _id: req.user.id };
  if (set.showAdult === true && !set.adultConfirmed) filter.adultConfirmed = true;
  const r = await User.updateOne(filter, { $set: set });
  if (!r.matchedCount) return res.status(403).json({ error: req.t('server.adult.notConfirmed') });
  res.json({ ok: true });
});

module.exports = router;