//support.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const SupportFile = require('../models/SupportFile');
const Preset = require('../models/Preset');
const PresetLike = require('../models/PresetLike');
const PresetAdd = require('../models/PresetAdd');
const Counter = require('../models/Counter');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');
const i18n = require('../services/i18n');
const { sendSupportEmail, footer, subjectOf, ticketIdFromRefs } = require('../services/supportMail');
const notify = require('../services/notify');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUSES = ['unread', 'accepted', 'trivial', 'answered'];
const MAX_MESSAGES = 100; // переписка по одному обращению

const nextNumber = () => Counter.next('supportTicket');
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const REPORT_SOURCES = ['stream', 'preset']; // вкладка «🚩 Жалобы» в админке

// ---- скриншоты к обращению: до 5 картинок data:URL (браузер уже пережал), тип — по первым байтам ----
const MAX_FILES = 5;
const MAX_FILE_BYTES = 1024 * 1024;
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
// → [{ mime, data }] или ключ ошибки строкой
function parseFiles(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return 'server.support.badFile';
  if (raw.length > MAX_FILES) return 'server.support.tooManyFiles';
  const out = [];
  for (const f of raw) {
    const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(typeof f === 'string' ? f : '');
    if (!m || m[1].length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) return 'server.support.badFile';
    const data = Buffer.from(m[1], 'base64');
    const mime = sniffImage(data);
    if (!mime || data.length > MAX_FILE_BYTES) return 'server.support.badFile';
    out.push({ mime, data });
  }
  return out;
}
// сначала файлы (с заранее выданным _id обращения), потом само обращение; не создалось — файлы убираем
async function createWithFiles(doc, files) {
  const _id = new mongoose.Types.ObjectId();
  const saved = files.length ? await SupportFile.insertMany(files.map((f) => ({ ...f, ticketId: _id }))) : [];
  try {
    return await SupportTicket.create({ ...doc, _id, ...(saved.length ? { files: saved.map((f) => f._id) } : {}) });
  } catch (e) {
    if (saved.length) await SupportFile.deleteMany({ ticketId: _id }).catch(() => {});
    throw e;
  }
}
// язык писем для обращения с почты: есть кириллица — русский, иначе английский
const guessLang = (...texts) => (/[А-Яа-яЁё]/.test(texts.join(' ')) ? 'ru' : 'en');

// тема для человека (профиль, уведомления): своя тема, иначе первая строка описания
function topicOf(t) {
  const s = String(t.subject || '').trim() || String(t.description || '').split('\n').find((l) => l.trim()) || '';
  return s.trim().slice(0, 80);
}
const isReport = (t) => REPORT_SOURCES.includes(t.source);

// куда доставить ответ поддержки. Вошедшему — на сайт (уведомление + профиль → «Поддержка»), если он не выбрал
// «ответы на почту»; письмо — гостю, обращению из почты и тому, кто выбрал почту. { via: 'site'|'email'|'none', user, email }
async function deliveryOf(ticket) {
  const u = ticket.userId ? await User.findById(ticket.userId).select('username email supportByEmail').lean() : null;
  if (u && ticket.source !== 'email' && !u.supportByEmail) return { via: 'site', user: u };
  const email = ticket.email || (u && u.supportByEmail ? u.email : '');
  if (email) return { via: 'email', user: u, email };
  if (u) return { via: 'site', user: u };
  return { via: 'none', user: null };
}
// уведомление в колокольчик: ответ, «принято», «пустяк» (жалобе — «рассмотрена»); кнопка — в профиль на эту переписку
// fallback — почему на сайт, а не письмом (mailLimit | mailFailed): клиент допишет причину к тексту
function notifyUser(ticket, user, kind, fallback) {
  const type = kind === 'reply' ? 'support.reply' : isReport(ticket) ? 'support.report' : 'support.' + kind;
  return notify.send(user._id, type, { topic: topicOf(ticket), n: ticket.number, fb: fallback },
    { link: notify.profileLink(user.username, 'support') + ':' + ticket._id });
}

// гостей ограничиваем жёстче: обращение без входа — самый простой путь для спама
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => (req.user ? 20 : 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.support.tooMany') }),
});

// обращение может создать любой: вошедшему почта не нужна (ответим в аккаунте), гостю — обязательна
router.post('/', auth.optional, guestLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 12);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 100);
    const description = String(req.body.description || '').trim().slice(0, 1000);
    const subject = String(req.body.subject || '').replace(/\s+/g, ' ').trim().slice(0, 100); // тема (форма в профиле)

    if (!req.user && !email) {
      return res.status(400).json({ error: req.t('server.support.needEmail') });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: req.t('server.badEmail') });
    }
    if (!description) {
      return res.status(400).json({ error: req.t('server.support.describe') });
    }
    if (description.length < 5) {
      return res.status(400).json({ error: req.t('server.support.short') });
    }
    const files = parseFiles(req.body.files);
    if (typeof files === 'string') return res.status(400).json({ error: req.t(files) });

    const ticket = await createWithFiles({
      number: await nextNumber(),
      name,
      email,
      description,
      ...(subject ? { subject } : {}),
      lang: req.lang,
      userId: req.user ? req.user.id : null,
      username: req.user ? req.user.username || '' : '',
    }, files);

    await notifyAdmins(req, ticket);
    res.status(201).json({ ok: true, id: ticket._id, number: ticket.number });
  } catch (err) {
    console.error('[support/create]', err);
    res.status(500).json({ error: req.t('server.sendFailed') });
  }
});

// ---- профиль → «Поддержка»: свои обращения, переписка и ответ с сайта ----
function myBrief(t) {
  const sup = (t.messages || []).filter((m) => m.from === 'support');
  const lastSup = sup.length ? sup[sup.length - 1].at : null;
  return {
    id: String(t._id), number: t.number, topic: topicOf(t), source: t.source, status: t.status, report: isReport(t),
    createdAt: t.createdAt, updatedAt: t.updatedAt, answered: sup.length > 0,
    fresh: !!lastSup && (!t.userSeenAt || new Date(lastSup) > new Date(t.userSeenAt)), // ответ, который ещё не открывал
  };
}

// GET /support/my — свои обращения и жалобы, свежие сверху
router.get('/my', auth, async (req, res) => {
  try {
    const [rows, u] = await Promise.all([
      SupportTicket.find({ userId: req.user.id }).sort({ updatedAt: -1 }).limit(50)
        .select('number subject description source status messages.from messages.at createdAt updatedAt userSeenAt').lean(),
      User.findById(req.user.id).select('supportByEmail').lean(),
    ]);
    res.json({ supportByEmail: !!u?.supportByEmail, tickets: rows.map(myBrief) });
  } catch (err) {
    console.error('[support/my]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// GET /support/my/:id — переписка (открыл — ответы прочитаны; updatedAt не трогаем, порядок списка тот же)
router.get('/my/:id', auth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const t = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { userSeenAt: new Date() } },
      { new: true, timestamps: false }
    ).select('number subject description source status messages files createdAt updatedAt userSeenAt').lean();
    if (!t) return res.status(404).json({ error: req.t('server.notFound') });
    res.json({
      ticket: {
        ...myBrief(t), description: t.description, files: (t.files || []).map(String),
        // кто из поддержки ответил, человеку не показываем — «Служба поддержки»
        messages: (t.messages || []).map((m) => ({
          from: m.from, kind: m.kind, text: m.text, at: m.at, site: !!m.site, emailed: !!m.emailed, fallback: m.fallback || null,
        })),
      },
    });
  } catch (err) {
    console.error('[support/my/get]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /support/my/:id/reply { text } — написать в переписку с сайта: обращение снова «непрочитанное» у админов
const myReplyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => 'u:' + req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.support.tooMany') }),
});
router.post('/my/:id/reply', auth, myReplyLimiter, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (text.length < 2) return res.status(400).json({ error: req.t('server.support.messageEmpty') });
    const msg = { from: 'user', kind: 'user', text, site: true, at: new Date() };
    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $push: { messages: { $each: [msg], $slice: -MAX_MESSAGES } }, $set: { status: 'unread', hasNewReply: true, userSeenAt: new Date() } },
      { new: true }
    ).select('-mailIds');
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    await notifyAdmins(req, ticket);
    res.json({ ok: true, message: { ...msg, emailed: false }, ticket: myBrief(ticket) });
  } catch (err) {
    console.error('[support/my/reply]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /support/stream-report { streamer, reason, description? } — 🚩 жалоба на эфир (только вошедшим:
// у аккаунта есть почта для ответа). Идёт в те же обращения, в админке — отдельная вкладка «🚩 Эфиры»
const REPORT_REASONS = ['violence', 'sexual', 'minors', 'hate', 'copyright', 'spam', 'other'];
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => 'u:' + req.user.id, // маршрут только для вошедших — считаем по аккаунту
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.support.tooMany') }),
});
router.post('/stream-report', auth, reportLimiter, async (req, res) => {
  try {
    const nameLower = String(req.body?.streamer || '').trim().toLowerCase().slice(0, 40);
    const reason = String(req.body?.reason || '');
    const text = String(req.body?.description || '').trim().slice(0, 1000);
    if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: req.t('server.support.reportReason') });
    const files = parseFiles(req.body?.files);
    if (typeof files === 'string') return res.status(400).json({ error: req.t(files) });
    // «угроза детям» — без картинок: такие материалы нельзя хранить даже как доказательство, только описание словами
    if (reason === 'minors' && files.length) return res.status(400).json({ error: req.t('server.support.noFilesMinors') });
    const streamer = nameLower && (await User.findOne({ streamerNameLower: nameLower })
      .select('streamerName streamerNameLower isLive streamTitle streamPlaybackId').lean());
    if (!streamer) return res.status(404).json({ error: req.t('server.notFound') });
    const me = await User.findById(req.user.id).select('username email').lean();
    const reasonText = i18n.t(req.lang, 'server.support.reasons.' + reason);
    // эфир идёт — сохраняем последние ~30 с как доказательство (кроме «угрозы детям»: такое хранить нельзя)
    const withClip = !!streamer.isLive && reason !== 'minors';
    const ticket = await createWithFiles({
      number: await nextNumber(),
      name: String(me?.username || '').slice(0, 12),
      email: me?.email || '',
      description: `🚩 ${streamer.streamerName} — ${reasonText}${text ? '\n\n' + text : ''}`,
      lang: req.lang,
      userId: req.user.id,
      username: me?.username || '',
      source: 'stream',
      subject: `🚩 ${streamer.streamerName}`,
      report: {
        streamer: streamer.streamerName, reason, title: streamer.streamTitle || '', live: !!streamer.isLive,
        ...(withClip ? { clip: { status: 'pending' } } : {}),
      },
    }, files);
    await notifyAdmins(req, ticket);
    if (withClip) saveReportClip(req, ticket._id, streamer);
    res.status(201).json({ ok: true, number: ticket.number });
  } catch (err) {
    console.error('[support/stream-report]', err);
    res.status(500).json({ error: req.t('server.sendFailed') });
  }
});

// POST /support/preset-report { presetId, reason, description? } — 🚩 жалоба на пре-сет (только вошедшим, тот же лимит,
// что у жалоб на эфир). В админке — во вкладке «🚩 Жалобы» вместе с эфирами; оттуда пре-сет можно удалить
const PRESET_REASONS = ['sexual', 'hate', 'copyright', 'spam', 'other'];
router.post('/preset-report', auth, reportLimiter, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '');
    const text = String(req.body?.description || '').trim().slice(0, 1000);
    if (!PRESET_REASONS.includes(reason)) return res.status(400).json({ error: req.t('server.support.reportReason') });
    const presetId = String(req.body?.presetId || '');
    const preset = isId(presetId) && (await Preset.findById(presetId).select('name type authorId authorName').lean());
    if (!preset) return res.status(404).json({ error: req.t('server.presets.notFound') });
    if (String(preset.authorId) === String(req.user.id)) return res.status(400).json({ error: req.t('server.support.reportOwn') });

    const me = await User.findById(req.user.id).select('username email').lean();
    const reasonText = i18n.t(req.lang, 'server.support.reasons.' + reason);
    const ticket = await SupportTicket.create({
      number: await nextNumber(),
      name: String(me?.username || '').slice(0, 12),
      email: me?.email || '',
      description: `🚩 «${preset.name}» (${preset.authorName}) — ${reasonText}${text ? '\n\n' + text : ''}`.slice(0, 5000),
      lang: req.lang,
      userId: req.user.id,
      username: me?.username || '',
      source: 'preset',
      subject: `🚩 «${String(preset.name).slice(0, 150)}»`,
      report: { reason, preset: { id: presetId, name: preset.name, type: preset.type, author: preset.authorName } },
    });
    await notifyAdmins(req, ticket);
    res.status(201).json({ ok: true, number: ticket.number });
  } catch (err) {
    console.error('[support/preset-report]', err);
    res.status(500).json({ error: req.t('server.sendFailed') });
  }
});

// запись к жалобе — в фоне (ответ человеку не ждёт ffmpeg); готово/не вышло — админка обновит карточку
function saveReportClip(req, ticketId, streamer) {
  require('../services/clips').createEvidence(streamer)
    .then(({ id, sec }) => ({ id, status: 'ready', sec }))
    .catch((e) => {
      console.warn('[support/stream-report] запись эфира не сохранена:', e.i18nKey || e.message);
      return { status: 'failed' };
    })
    .then(async (clip) => {
      const t = await SupportTicket.findByIdAndUpdate(ticketId, { $set: { 'report.clip': clip } }, { new: true }).select('-mailIds');
      if (t) await broadcast(req, t);
    })
    .catch((e) => console.error('[support/stream-report] clip', e.message));
}

async function notifyAdmins(req, ticket) {
  const io = req.app.get('io');
  if (!io) return;
  const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
  io.to('admins').emit('support:new', { ticket: briefOf(ticket), unreadCount });
  io.to('admins').emit('support:count', { unreadCount });
}

// ---- Письма на support@ → тикеты ----
// Cloudflare Email Routing отдаёт письмо Worker'у, тот шлёт «сырое» письмо сюда
// с секретом INBOUND_EMAIL_SECRET в заголовке x-inbound-secret.

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// если у письма только HTML — грубо превращаем его в текст (теги в админке всё равно экранируются)
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// отрезаем процитированное прошлое письмо («> ...», «On ... wrote:», «... написал(а):»)
function stripQuoted(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(On .+wrote:|.+написал\(а\):|.+пишет:|-{2,}\s*(Original Message|Исходное сообщение))/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// не больше 10 писем в час с одного адреса — защита от флуда
const inboundHits = new Map(); // email → [время]
function inboundLimited(email) {
  const now = Date.now();
  const arr = (inboundHits.get(email) || []).filter((t) => now - t < 60 * 60 * 1000);
  arr.push(now);
  inboundHits.set(email, arr);
  if (inboundHits.size > 5000) inboundHits.clear();
  return arr.length > 10;
}

// Message-ID из In-Reply-To / References (строка или массив) → список
function refsOf(mail) {
  const raw = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : [mail.references])];
  return raw.flatMap((x) => String(x || '').match(/<[^<>\s]{1,250}>/g) || []).slice(0, 30);
}

// ответ человека на наше письмо: тикет ищем по Message-ID, иначе по «[#номер]» в теме.
// Отправитель обязан совпасть с почтой тикета — иначе чужое письмо не попадёт в чужую переписку.
async function findThreadTicket(mail, email) {
  const refs = refsOf(mail);
  let ticket = null;
  const byId = ticketIdFromRefs(refs);
  if (byId) ticket = await SupportTicket.findById(byId);
  if (!ticket && refs.length) ticket = await SupportTicket.findOne({ mailIds: { $in: refs } });
  if (!ticket) {
    const m = String(mail.subject || '').match(/\[#(\d{1,9})\]/);
    if (m) ticket = await SupportTicket.findOne({ number: Number(m[1]) });
  }
  return ticket && ticket.email === email ? ticket : null;
}

router.post('/inbound', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) {
    console.warn('[support/inbound] отклонено: INBOUND_EMAIL_SECRET не задан в .env');
    return res.status(403).json({ error: 'forbidden', reason: 'no-secret-configured' });
  }
  if (!safeEqual(req.get('x-inbound-secret') || '', secret)) {
    // сам секрет в лог не пишем — только факт
    console.warn('[support/inbound] отклонено: секрет от Worker не совпадает с INBOUND_EMAIL_SECRET');
    return res.status(403).json({ error: 'forbidden', reason: 'bad-secret' });
  }
  if (typeof req.body !== 'string' || !req.body) return res.status(400).json({ error: 'empty' });

  try {
    const mail = await simpleParser(req.body, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    const from = mail.from?.value?.[0] || {};
    const email = String(from.address || req.get('x-envelope-from') || '').trim().toLowerCase().slice(0, 100);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'bad sender' });

    // автоответы («я в отпуске», отчёты о недоставке) и наши же письма не превращаем в тикеты — иначе петля
    const autoSubmitted = String(mail.headers.get('auto-submitted') || 'no').toLowerCase();
    const ownAddress = String(process.env.MAIL_FROM || '').match(/[^<\s]+@[^>\s]+/)?.[0]?.toLowerCase();
    if (autoSubmitted !== 'no' || email === ownAddress || /^(mailer-daemon|postmaster)@/i.test(email)) {
      return res.json({ ok: true, skipped: 'auto' });
    }
    if (inboundLimited(email)) return res.json({ ok: true, skipped: 'rate' });

    const subject = String(mail.subject || '').trim().slice(0, 200);
    const body = stripQuoted(mail.text || htmlToText(mail.html));
    const lang = guessLang(subject, body);
    const attachNote = mail.attachments?.length ? '\n\n' + i18n.t(lang, 'server.support.attachments', { n: mail.attachments.length }) : '';
    const text = ((body || i18n.t(lang, 'server.support.emptyMail')) + attachNote).slice(0, 5000);
    const messageId = /^<[^<>\s]{1,250}>$/.test(String(mail.messageId || '')) ? mail.messageId : null;

    // ответ на наше письмо → в ту же переписку, обращение снова «непрочитанное»
    const thread = await findThreadTicket(mail, email);
    if (thread) {
      const update = {
        $push: { messages: { $each: [{ from: 'user', kind: 'user', text }], $slice: -MAX_MESSAGES } },
        $set: { status: 'unread', hasNewReply: true },
      };
      if (messageId) update.$push.mailIds = { $each: [messageId], $slice: -50 };
      const ticket = await SupportTicket.findByIdAndUpdate(thread._id, update, { new: true });
      await notifyAdmins(req, ticket);
      console.log('[support/inbound] ответ → тикет #' + ticket.number);
      return res.json({ ok: true, id: ticket._id, reply: true });
    }

    // если почта принадлежит зарегистрированному пользователю — привязываем тикет к нему
    const user = await User.findOne({ email }).select('username').lean();

    const ticket = await SupportTicket.create({
      number: await nextNumber(),
      name: String(from.name || '').trim().slice(0, 12),
      email,
      subject,
      description: text,
      source: 'email',
      lang,
      mailIds: messageId ? [messageId] : [],
      userId: user ? user._id : null,
      username: user ? user.username : '',
    });

    await notifyAdmins(req, ticket);
    console.log('[support/inbound] письмо → тикет #' + ticket.number);
    res.status(201).json({ ok: true, id: ticket._id });
  } catch (err) {
    console.error('[support/inbound]', err.message);
    res.status(500).json({ error: 'parse failed' });
  }
});

// ---- админка ----

// карточка в списке: без переписки и служебных Message-ID
function briefOf(t) {
  const o = typeof t.toObject === 'function' ? t.toObject() : t;
  const last = (o.messages || [])[o.messages?.length - 1];
  return {
    _id: o._id, number: o.number, name: o.name, email: o.email, source: o.source, subject: o.subject,
    description: o.description, status: o.status, hasNewReply: !!o.hasNewReply, username: o.username,
    lang: o.lang, createdAt: o.createdAt, updatedAt: o.updatedAt,
    report: o.report && (o.report.streamer || o.report.preset?.id) ? o.report : null,
    // снимок логов не отдаём в списке (он большой) — только флаг; сами логи — GET /support/:id/logs
    request: o.request?.kind ? { ...o.request, logs: undefined, hasLogs: !!o.request.logs } : null, userId: o.userId ? String(o.userId) : null,
    files: (o.files || []).map(String), messagesCount: (o.messages || []).length, lastMessage: last ? { from: last.from, kind: last.kind, at: last.at } : null,
  };
}

// старым обращениям (до нумерации) выдаём номера по порядку создания
let numbersChecked = false;
async function ensureNumbers() {
  if (numbersChecked) return;
  const rows = await SupportTicket.find({ number: { $exists: false } }).sort({ createdAt: 1 }).select('_id description').lean();
  for (const r of rows) {
    await SupportTicket.updateOne(
      { _id: r._id, number: { $exists: false } },
      { $set: { number: await nextNumber(), lang: guessLang(r.description) } }
    );
  }
  numbersChecked = true;
}

async function broadcast(req, ticket) {
  const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
  const io = req.app.get('io');
  if (io) {
    io.to('admins').emit('support:updated', { ticket: briefOf(ticket), unreadCount });
    io.to('admins').emit('support:count', { unreadCount });
  }
  return unreadCount;
}


// список: ?status=unread|accepted|trivial|answered или поиск по номеру ?q=123 (во всех статусах)
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    await ensureNumbers();
    const q = String(req.query.q || '').trim().replace(/^#/, '');
    let filter;
    if (q) {
      if (!/^\d{1,9}$/.test(q)) return res.json({ tickets: [] });
      filter = { number: Number(q) };
    } else {
      const status = req.query.status || 'unread';
      if (req.query.source === 'stream') {
        filter = { source: { $in: REPORT_SOURCES } }; // вкладка «🚩 Жалобы»: на эфиры и пре-сеты, свежие сверху
      } else {
        if (!STATUSES.includes(status)) return res.status(400).json({ error: req.t('server.badStatus') });
        filter = { status, source: { $nin: REPORT_SOURCES } };
      }
    }
    const tickets = await SupportTicket.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .select('-mailIds')
      .lean();
    res.json({ tickets: tickets.map(briefOf) });
  } catch (err) {
    console.error('[support/list]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// админ: счётчик непрочитанных
router.get('/count', auth, adminOnly, async (req, res) => {
  try {
    const [unreadCount, streamUnread] = await Promise.all([
      SupportTicket.countDocuments({ status: 'unread' }),
      SupportTicket.countDocuments({ status: 'unread', source: { $in: REPORT_SOURCES } }),
    ]);
    res.json({ unreadCount, streamUnread });
  } catch (err) {
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// админ: удалить пре-сет, на который пожаловались (как «Удалить» админом на странице пре-сетов: лайки и добавления
// уходят вместе с ним, уже созданные у людей команды/награды остаются). Обращение помечается report.preset.deleted
router.delete('/:id/preset', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const ticket = await SupportTicket.findById(req.params.id).select('-mailIds');
    const pid = ticket?.report?.preset?.id;
    if (!pid) return res.status(404).json({ error: req.t('server.notFound') });
    const p = isId(pid) && (await Preset.findById(pid).select('_id authorId name'));
    if (p) {
      await Promise.all([PresetLike.deleteMany({ presetId: p._id }), PresetAdd.deleteMany({ presetId: p._id }), p.deleteOne()]);
      notify.send(p.authorId, 'preset.removed', { preset: p.name }, { link: '/workbench/presets.html' }); // автору — решение модерации
    }
    ticket.report.preset.deleted = true;
    await ticket.save();
    await broadcast(req, ticket);
    res.json({ ok: true, existed: !!p, ticket: briefOf(ticket) });
  } catch (err) {
    console.error('[support/preset-delete]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// запись эфира к жалобе (mp4 с перемоткой — sendFile умеет Range) или её обложка ?thumb=1 — только админу
router.get('/clip/:id', auth, adminOnly, (req, res) => {
  const file = require('../services/clips').evidencePath(req.params.id, req.query.thumb === '1');
  if (!file) return res.status(404).json({ error: req.t('server.notFound') });
  res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=86400' } });
});

// скриншот обращения — админу и автору обращения (картинку не кэширует Cloudflare: private)
async function fileAccess(req, res, next) {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const f = await SupportFile.findById(req.params.id).select('ticketId').lean();
    if (!f) return res.status(404).json({ error: req.t('server.notFound') });
    if (await SupportTicket.exists({ _id: f.ticketId, userId: req.user.id })) return next();
    return adminOnly(req, res, next);
  } catch (e) {
    next(e);
  }
}
router.get('/file/:id', auth, fileAccess, async (req, res) => {
  try {
    const f = await SupportFile.findById(req.params.id).lean();
    if (!f) return res.status(404).json({ error: req.t('server.notFound') });
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(f.data.buffer || f.data));
  } catch (err) {
    console.error('[support/file]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// полная карточка с перепиской + нижний блок ответа (подпись и история), ровно как уйдёт в письме
// GET /support/:id/logs — снимок «что делал за сутки до запроса на удаление» (кнопка «Логи пользователя»)
router.get('/:id/logs', auth, adminOnly, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
  const t = await SupportTicket.findById(req.params.id).select('request.logs request.kind').lean();
  if (!t || t.request?.kind !== 'deletion') return res.status(404).json({ error: req.t('server.notFound') });
  res.json({ logs: t.request.logs || null });
});

router.get('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: { hasNewReply: false } }, { new: true })
      .select('-mailIds').lean();
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    // куда уйдёт ответ: на сайт (уведомление) или письмом — решает сервер (deliveryOf), админу только показываем
    const d = await deliveryOf(ticket);
    const reply = d.via === 'email'
      ? { via: 'email', to: ticket.email || d.email, subject: subjectOf(ticket), footer: footer(ticket, req.user.username) }
      : d.via === 'site' ? { via: 'site', to: '@' + d.user.username, subject: topicOf(ticket), footer: '' } : null;
    res.json({ ticket: { ...briefOf(ticket), messages: ticket.messages || [] }, reply });
  } catch (err) {
    console.error('[support/get]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// обработать можно только непрочитанное: статус меняем атомарно (условие status: 'unread'),
// поэтому двойной клик или два админа одновременно не отправят два письма
async function claimUnread(ticket, status) {
  if (ticket.status !== 'unread') return false;
  const r = await SupportTicket.updateOne({ _id: ticket._id, status: 'unread' }, { $set: { status, hasNewReply: false } });
  return r.modifiedCount === 1;
}

// админ: «Принято» / «Пустяк» — только из непрочитанных; обработанное обращение не меняется (только через базу).
// Оба статуса отправляют человеку письмо (если есть почта)
router.patch('/:id/status', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const status = req.body.status;
    if (!['accepted', 'trivial'].includes(status)) {
      return res.status(400).json({ error: req.t('server.badStatus') });
    }
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    const d = await deliveryOf(ticket);
    if (!(await claimUnread(ticket, status))) return res.status(409).json({ error: req.t('server.support.closed') });

    let emailed = false;
    let site = d.via === 'site';
    let fallback; // письмо не ушло (лимит / сбой) — уведомление на сайт с причиной
    if (d.via === 'email') {
      if (!ticket.email) ticket.email = d.email;
      try {
        const r = await sendSupportEmail(ticket, status);
        emailed = r.emailed;
        if (r.messageId) ticket.mailIds.push(r.messageId);
      } catch (e) {
        console.error('[support/status] письмо не отправлено:', e.code === 'MAIL_LIMIT' ? 'дневной лимит писем исчерпан' : e.message);
        if (d.user) fallback = e.code === 'MAIL_LIMIT' ? 'mailLimit' : 'mailFailed';
      }
      if (!emailed && d.user && !fallback) fallback = 'mailFailed';
      if (fallback) site = true;
    }
    ticket.messages.push({
      from: 'support', kind: status, text: '', author: req.user.username || '', emailed,
      ...(site ? { site: true } : {}), ...(fallback ? { fallback } : {}),
    });
    ticket.status = status;
    ticket.hasNewReply = false;
    await ticket.save();
    if (site) notifyUser(ticket, d.user, status, fallback);

    const unreadCount = await broadcast(req, ticket);
    res.json({ ticket: briefOf(ticket), unreadCount, emailed, hadEmail: d.via === 'email', site, fallback: fallback || null });
  } catch (err) {
    console.error('[support/status]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// админ: ответ на обращение — на сайт или письмом (deliveryOf); письмо не ушло, а аккаунт есть — на сайт
router.post('/:id/reply', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: req.t('server.support.replyEmpty') });

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    const d = await deliveryOf(ticket);
    if (d.via === 'none') return res.status(400).json({ error: req.t('server.support.noEmail') });
    if (!(await claimUnread(ticket, 'answered'))) return res.status(409).json({ error: req.t('server.support.closed') });

    // на сайт: письма нет — уведомление в колокольчик и переписка в профиле (дневной лимит писем не тратится).
    // fallback — человек выбрал почту, но письмо не ушло (лимит писем / сбой): тоже на сайт, с причиной
    const toSite = async (fallback) => {
      ticket.messages.push({ from: 'support', kind: 'reply', text, author: req.user.username || '', site: true, ...(fallback ? { fallback } : {}) });
      if (ticket.messages.length > MAX_MESSAGES) ticket.messages = ticket.messages.slice(-MAX_MESSAGES);
      ticket.status = 'answered';
      ticket.hasNewReply = false;
      await ticket.save();
      notifyUser(ticket, d.user, 'reply', fallback);
      const unreadCount = await broadcast(req, ticket);
      return res.json({ ticket: briefOf(ticket), unreadCount, via: 'site', fallback: fallback || null });
    };
    if (d.via === 'site') return toSite();
    if (!ticket.email) ticket.email = d.email; // выбрал «ответы на почту» уже после обращения

    let r;
    let limit = false;
    try {
      r = await sendSupportEmail(ticket, 'reply', { text, author: req.user.username || '' });
    } catch (e) {
      limit = e.code === 'MAIL_LIMIT';
      console.error('[support/reply] письмо не отправлено:', limit ? 'дневной лимит писем исчерпан' : e.message);
      r = { emailed: false };
    }
    if (!r.emailed) {
      // у человека есть аккаунт — ответ не теряется и не ждёт: уходит на сайт, причину он увидит в уведомлении
      if (d.user) return toSite(limit ? 'mailLimit' : 'mailFailed');
      // гость: письмо не ушло — возвращаем «непрочитанное», чтобы админ мог отправить ещё раз
      await SupportTicket.updateOne({ _id: ticket._id, status: 'answered' }, { $set: { status: 'unread' } });
      return res.status(limit ? 503 : 502).json({ error: req.t(limit ? 'server.support.mailLimit' : 'server.support.mailFailed') });
    }

    ticket.mailIds.push(r.messageId);
    if (ticket.mailIds.length > 50) ticket.mailIds = ticket.mailIds.slice(-50);
    ticket.messages.push({ from: 'support', kind: 'reply', text, author: req.user.username || '', emailed: true });
    if (ticket.messages.length > MAX_MESSAGES) ticket.messages = ticket.messages.slice(-MAX_MESSAGES);
    ticket.status = 'answered';
    ticket.hasNewReply = false;
    await ticket.save();

    const unreadCount = await broadcast(req, ticket);
    res.json({ ticket: briefOf(ticket), unreadCount, via: 'email' });
  } catch (err) {
    console.error('[support/reply]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// заявка из профиля (смена почты, когда лимит писем исчерпан; удаление аккаунта) — обычное обращение с пометкой request
async function createRequestTicket(req, user, request, description) {
  const ticket = await SupportTicket.create({
    number: await nextNumber(),
    name: String(user.username || '').slice(0, 12),
    email: user.email || '',
    description: String(description).slice(0, 5000),
    lang: req.lang,
    userId: user._id,
    username: user.username || '',
    request,
  });
  await notifyAdmins(req, ticket);
  return ticket;
}

module.exports = router;
module.exports.createRequestTicket = createRequestTicket;
