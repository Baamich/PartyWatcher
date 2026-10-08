//support.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const SupportTicket = require('../models/SupportTicket');
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

    const io = req.app.get('io');
    if (io) {
      const unreadCount = await SupportTicket.countDocuments({ status: 'unread' });
      io.to('admins').emit('support:new', { ticket, unreadCount });
      io.to('admins').emit('support:count', { unreadCount });
    }

    res.status(201).json({ ok: true, id: ticket._id });
  } catch (err) {
    console.error('[support/create]', err);
    res.status(500).json({ error: 'Не удалось отправить' });
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