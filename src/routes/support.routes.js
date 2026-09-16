//support.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const SupportTicket = require('../models/SupportTicket');

// пользователь создаёт обращение
router.post('/', auth, async (req, res) => {
  try {
    let name = String(req.body.name || '').trim().slice(0, 12);
    let email = String(req.body.email || '').trim().slice(0, 26);
    const description = String(req.body.description || '').trim().slice(0, 1000);

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
      userId: req.user.id,
      username: req.user.username || '',
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