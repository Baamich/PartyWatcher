const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
// обновление сайта — только владелец (owner)
const ownerOnly = require('../middleware/adminOnly').owner;
const updateService = require('../services/updateService');

const HASH_RE = /^[0-9a-f]{7,40}$/i;

router.get('/commits', auth, ownerOnly, async (req, res) => {
  try {
    const commits = await updateService.getCommits(100);
    res.json({ commits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/update', auth, ownerOnly, (req, res) => {
  if (updateService.getStatus().state === 'running') {
    return res.status(409).json({ error: req.t('server.admin.updateRunning') });
  }

  const hash = req.body && req.body.hash;
  if (hash && !HASH_RE.test(hash)) {
    return res.status(400).json({ error: req.t('server.admin.badHash') });
  }

  updateService.performUpdate(hash || undefined);
  res.status(202).json({ status: 'started' });
});

router.get('/update/status', auth, ownerOnly, (req, res) => {
  const s = updateService.getStatus();
  // служебные строки журнала хранятся ключами — переводим на язык админа
  res.json({ ...s, log: s.log.map((x) => (typeof x === 'string' ? x : req.t(x.k, x.v))) });
});

module.exports = router;