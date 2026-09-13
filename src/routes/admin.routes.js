const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const updateService = require('../services/updateService');

const HASH_RE = /^[0-9a-f]{7,40}$/i;

router.get('/commits', auth, adminOnly, async (req, res) => {
  try {
    const commits = await updateService.getCommits(100);
    res.json({ commits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/update', auth, adminOnly, (req, res) => {
  if (updateService.getStatus().state === 'running') {
    return res.status(409).json({ error: 'Обновление уже идёт' });
  }

  const hash = req.body && req.body.hash;
  if (hash && !HASH_RE.test(hash)) {
    return res.status(400).json({ error: 'Некорректный хэш коммита' });
  }

  updateService.performUpdate(hash || undefined);
  res.status(202).json({ status: 'started' });
});

router.get('/update/status', auth, adminOnly, (req, res) => {
  res.json(updateService.getStatus());
});

module.exports = router;