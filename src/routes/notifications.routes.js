// Уведомления на сайте (колокольчик в шапке — public/js/notify-bell.js, настройки — профиль → «Уведомления»).
// Логика — services/notify.js
const express = require('express');
const auth = require('../middleware/auth');
const notify = require('../services/notify');

const router = express.Router();

// GET /notifications?before=<мс>&limit=10&open=1 — страница списка, свежие сверху.
// open=1 на первой странице — колокольчик открыли: всё прочитано (seenAt в ответе — прежняя метка)
router.get('/', auth, async (req, res) => {
  try {
    const r = await notify.list(req.user.id, {
      before: req.query.before, limit: req.query.limit, open: req.query.open === '1', lang: req.lang,
    });
    if (!r) return res.status(401).json({ error: req.t('server.userNotFound') });
    res.json(r);
  } catch (err) {
    console.error('[notifications/list]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// GET /notifications/count — сколько непрочитанных (страницы без опроса эфиров спрашивают сами)
router.get('/count', auth, async (req, res) => {
  try {
    res.json({ unread: await notify.unreadOf(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// GET /notifications/settings — разделы (вкл/выкл) и «ответы поддержки на почту»
router.get('/settings', auth, async (req, res) => {
  const s = await notify.settingsOf(req.user.id);
  if (!s) return res.status(401).json({ error: req.t('server.userNotFound') });
  res.json(s);
});

// PUT /notifications/settings { off: ['news', …] } и/или { supportByEmail: true|false }
router.put('/settings', auth, async (req, res) => {
  try {
    const s = await notify.saveSettings(req.user.id, { off: req.body?.off, supportByEmail: req.body?.supportByEmail });
    if (!s) return res.status(401).json({ error: req.t('server.userNotFound') });
    res.json(s);
  } catch (err) {
    console.error('[notifications/settings]', err.message);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

module.exports = router;
