//support.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// гостей ограничиваем жёстче: обращение без входа — самый простой путь для спама
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => (req.user ? 20 : 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много обращений, попробуйте позже' },
});

// обращение может создать любой: вошедшему почта не нужна (ответим в аккаунте), гостю — обязательна
router.post('/', auth.optional, guestLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 12);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 100);
    const description = String(req.body.description || '').trim().slice(0, 1000);

    if (!req.user && !email) {
      return res.status(400).json({ error: 'Укажите почту — без входа в аккаунт ответить можно только на неё' });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Некорректная почта' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Опишите проблему' });
    }
    if (description.length < 5) {
      return res.status(400).json({ error: 'Слишком короткое описание' });
    }

    const ticket = await SupportTicket.create({
      name,
      email,
      description,
      userId: req.user ? req.user.id : null,
      username: req.user ? req.user.username || '' : '',
    });

    await notifyAdmins(req, ticket);
    res.status(201).json({ ok: true, id: ticket._id });
  } catch (err) {
    console.error('[support/create]', err);
    res.status(500).json({ error: 'Не удалось отправить' });
  }
});

async function notifyAdmins(req, ticket) {
  const io = req.app.get('io');
  if (!io) return;
  const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
  io.to('admins').emit('support:new', { ticket, unreadCount });
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
    const attachNote = mail.attachments?.length ? `\n\n[вложений: ${mail.attachments.length} — смотрите в почтовом ящике]` : '';
    const description = ((body || '(пустое письмо)') + attachNote).slice(0, 5000);

    // если почта принадлежит зарегистрированному пользователю — привязываем тикет к нему
    const user = await User.findOne({ email }).select('username').lean();

    const ticket = await SupportTicket.create({
      name: String(from.name || '').trim().slice(0, 12),
      email,
      subject,
      description,
      source: 'email',
      userId: user ? user._id : null,
      username: user ? user.username : '',
    });

    await notifyAdmins(req, ticket);
    console.log('[support/inbound] письмо → тикет', String(ticket._id));
    res.status(201).json({ ok: true, id: ticket._id });
  } catch (err) {
    console.error('[support/inbound]', err.message);
    res.status(500).json({ error: 'parse failed' });
  }
});

// админ: список (фильтр status)
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const status = req.query.status || 'unread';
    if (!['unread', 'accepted', 'trivial'].includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }
    const tickets = await SupportTicket.find({ status })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ tickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// админ: счётчик непрочитанных
router.get('/count', auth, adminOnly, async (req, res) => {
  try {
    const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
    res.json({ unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// админ: смена статуса
router.patch('/:id/status', auth, adminOnly, async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ error: 'Некорректный id' });
    const status = req.body.status;
    if (!['accepted', 'trivial', 'unread'].includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }
    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).lean();
    if (!ticket) return res.status(404).json({ error: 'Не найдено' });

    const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('support:updated', { ticket, unreadCount });
      io.to('admins').emit('support:count', { unreadCount });
    }

    res.json({ ticket, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;