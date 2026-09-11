const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const config = require('../config');
const updateService = require('../services/updateService');
const User = require('../models/User');

router.post('/update', auth, adminOnly, async (req, res) => {
  const providedKey = req.headers['x-update-key'];
  if (config.update.secretKey && providedKey !== config.update.secretKey) {
    return res.status(403).json({ error: 'Неверный update key' });
  }

  try {
    const result = await updateService.performUpdate();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    console.error('[update] error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
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