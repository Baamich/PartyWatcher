const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const updateService = require('../services/updateService');

router.post('/update', auth, adminOnly, (req, res) => {
  if (updateService.getStatus().state === 'running') {
    return res.status(409).json({ error: 'Обновление уже идёт' });
  }
  updateService.performUpdate();
  res.status(202).json({ status: 'started' });
});

router.get('/update/status', auth, adminOnly, (req, res) => {
  res.json(updateService.getStatus());
});

module.exports = router;