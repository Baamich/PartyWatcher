// kodik.routes.js — /api/kodik: поиск фильмов/сериалов для комнаты с плеером Kodik
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../middleware/auth');
const i18n = require('../services/i18n');
const kodik = require('../services/kodik');

// поиск идёт после auth — считаем по аккаунту (повторы одного запроса берутся из кэша сервиса)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.kodik.tooMany') }),
});

// есть ли на сервере ключ API (без него — только ссылка на плеер)
router.get('/config', auth, (req, res) => {
  res.json({ search: kodik.hasToken() });
});

router.get('/search', auth, searchLimiter, async (req, res) => {
  try {
    const items = await kodik.search(req.query.q);
    res.json({ items });
  } catch (e) {
    const status = e.i18nKey === 'server.kodik.badQuery' ? 400 : e.i18nKey ? 503 : 500;
    if (!e.i18nKey) console.error('[kodik/search]', e);
    res.status(status).json({ error: i18n.errText(req, e, 'server.kodik.apiFailed') });
  }
});

module.exports = router;
