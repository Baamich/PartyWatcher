//support.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const SupportTicket = require('../models/SupportTicket');
const Counter = require('../models/Counter');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');
const i18n = require('../services/i18n');
const { sendSupportEmail, footer, subjectOf, ticketIdFromRefs } = require('../services/supportMail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUSES = ['unread', 'accepted', 'trivial', 'answered'];
const MAX_MESSAGES = 100; // переписка по одному обращению

const nextNumber = () => Counter.next('supportTicket');
// язык писем для обращения с почты: есть кириллица — русский, иначе английский
const guessLang = (...texts) => (/[А-Яа-яЁё]/.test(texts.join(' ')) ? 'ru' : 'en');

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

    const ticket = await SupportTicket.create({
      number: await nextNumber(),
      name,
      email,
      description,
      lang: req.lang,
      userId: req.user ? req.user.id : null,
      username: req.user ? req.user.username || '' : '',
    });

    await notifyAdmins(req, ticket);
    res.status(201).json({ ok: true, id: ticket._id, number: ticket.number });
  } catch (err) {
    console.error('[support/create]', err);
    res.status(500).json({ error: req.t('server.sendFailed') });
  }
});

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
    messagesCount: (o.messages || []).length, lastMessage: last ? { from: last.from, kind: last.kind, at: last.at } : null,
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

const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));

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
      if (!STATUSES.includes(status)) return res.status(400).json({ error: req.t('server.badStatus') });
      filter = { status };
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
    const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
    res.json({ unreadCount });
  } catch (err) {
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// полная карточка с перепиской + нижний блок ответа (подпись и история), ровно как уйдёт в письме
router.get('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: { hasNewReply: false } }, { new: true })
      .select('-mailIds').lean();
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    res.json({
      ticket: { ...briefOf(ticket), messages: ticket.messages || [] },
      reply: ticket.email ? { subject: subjectOf(ticket), footer: footer(ticket, req.user.username) } : null,
    });
  } catch (err) {
    console.error('[support/get]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// админ: смена статуса. «Принято» и «Пустяк» отправляют человеку письмо (если есть почта)
router.patch('/:id/status', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const status = req.body.status;
    if (!['accepted', 'trivial', 'unread'].includes(status)) {
      return res.status(400).json({ error: req.t('server.badStatus') });
    }
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });

    let emailed = false;
    const changed = ticket.status !== status;
    if (changed && status !== 'unread' && ticket.email) {
      try {
        const r = await sendSupportEmail(ticket, status);
        emailed = r.emailed;
        if (r.messageId) ticket.mailIds.push(r.messageId);
      } catch (e) {
        console.error('[support/status] письмо не отправлено:', e.message);
      }
      ticket.messages.push({ from: 'support', kind: status, text: '', author: req.user.username || '', emailed });
    }
    ticket.status = status;
    ticket.hasNewReply = false;
    await ticket.save();

    const unreadCount = await broadcast(req, ticket);
    res.json({ ticket: briefOf(ticket), unreadCount, emailed, hadEmail: !!ticket.email });
  } catch (err) {
    console.error('[support/status]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// админ: ответ на обращение письмом. Без почты ответить нельзя
router.post('/:id/reply', auth, adminOnly, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: req.t('server.support.replyEmpty') });

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: req.t('server.notFound') });
    if (!ticket.email) return res.status(400).json({ error: req.t('server.support.noEmail') });

    let r;
    try {
      r = await sendSupportEmail(ticket, 'reply', { text, author: req.user.username || '' });
    } catch (e) {
      console.error('[support/reply] письмо не отправлено:', e.message);
      r = { emailed: false };
    }
    if (!r.emailed) return res.status(502).json({ error: req.t('server.support.mailFailed') });

    ticket.mailIds.push(r.messageId);
    if (ticket.mailIds.length > 50) ticket.mailIds = ticket.mailIds.slice(-50);
    ticket.messages.push({ from: 'support', kind: 'reply', text, author: req.user.username || '', emailed: true });
    if (ticket.messages.length > MAX_MESSAGES) ticket.messages = ticket.messages.slice(-MAX_MESSAGES);
    ticket.status = 'answered';
    ticket.hasNewReply = false;
    await ticket.save();

    const unreadCount = await broadcast(req, ticket);
    res.json({ ticket: briefOf(ticket), unreadCount });
  } catch (err) {
    console.error('[support/reply]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

module.exports = router;
