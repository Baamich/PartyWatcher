const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const config = require('../config');
const updateService = require('../services/updateService');
const User = require('../models/User');

// src/routes/admin.routes.js — заменить роут /update и добавить /update/status
router.post('/update', auth, adminOnly, (req, res) => {
  const providedKey = req.headers['x-update-key'];
  if (config.update.secretKey && providedKey !== config.update.secretKey) {
    return res.status(403).json({ error: 'Неверный update key' });
  }
  if (updateService.getStatus().state === 'running') {
    return res.status(409).json({ error: 'Обновление уже идёт' });
  }

  updateService.performUpdate(); // не ждём — запускаем в фоне
  res.status(202).json({ status: 'started' });
});

router.get('/update/status', auth, adminOnly, (req, res) => {
  res.json(updateService.getStatus());
});

router.get('/users', auth, adminOnly, async (req, res) => {
  res.json(await User.find().select('-passwordHash'));
});

router.post('/users/:id/promote', auth, adminOnly, async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { role: 'admin' }, { new: true }).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(user);
});

module.exports = router;