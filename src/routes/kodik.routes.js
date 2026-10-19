// kodik.routes.js — /api/kodik: поиск фильмов/сериалов для комнаты с плеером Kodik
const express = require('express');
const rateLimit = require('express-rate-limit');
const { isTrusted } = require('../services/roles');
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
// поиск по каталогу (с постерами) — только админу и друзьям (services/roles.js): сайт сам не подаёт каталог
// всем подряд. Вставить готовую ссылку на плеер Kodik может любой — за ссылку отвечает тот, кто её принёс
router.get('/config', auth, async (req, res) => {
  res.json({ search: kodik.hasToken() && (await isTrusted(req.user.id)) });
});

router.get('/search', auth, searchLimiter, async (req, res) => {
  if (!(await isTrusted(req.user.id))) return res.status(403).json({ error: req.t('server.kodik.searchFriendsOnly') });
  try {
    const items = await kodik.search(req.query.q);
    res.json({ items });
  } catch (e) {
    const status = e.i18nKey === 'server.kodik.badQuery' ? 400 : e.i18nKey ? 503 : 500;
    if (!e.i18nKey) console.error('[kodik/search]', e);
    res.status(status).json({ error: i18n.errText(req, e, 'server.kodik.apiFailed') });
  }
});

// GET /kodik/episodes?url=<ссылка на плеер>[&season=N] — сезоны и серии для списков хоста в комнате.
// Kodik по готовой ссылке доступен всем, поэтому и это — всем вошедшим; ответы кэшируются сервисом (6 ч)
const episodesLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  keyGenerator: (req) => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.kodik.tooMany') }),
});
router.get('/episodes', auth, episodesLimiter, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!kodik.normalizeLink(url)) return res.status(400).json({ error: req.t('server.room.badKodik') });
  const data = await kodik.episodes(url, req.query.season);
  res.json(data || { serial: true, seasons: null });
});

module.exports = router;
