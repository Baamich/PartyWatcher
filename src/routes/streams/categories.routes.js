// /api/categories — категории эфиров: есть ли поиск, поиск (для студии), обложки
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const categories = require('../../services/categories');
const Category = require('../../models/Category');

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.cat.tooMany') }),
});

// GET /categories/config — настроены ли ключи Twitch (без них выбрать категорию нельзя)
router.get('/config', auth, (req, res) => {
  res.json({ enabled: categories.enabled() });
});

// GET /categories/search?q= — игры и категории по названию (русские названия неигровых тоже находятся)
router.get('/search', auth, searchLimiter, async (req, res) => {
  try {
    res.json(await categories.search(req.query.q));
  } catch (e) {
    if (!e.i18nKey) console.error('[GET /categories/search]', e);
    res.status(502).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.cat.searchFailed') });
  }
});

// обложки в памяти (их немного, ~20–40 КБ каждая)
const coverCache = new Map(); // slug → { type, buf }
const COVER_CACHE_MAX = 300;

// GET /categories/:slug/cover — обложка с нашего сервера (не меняется — кэш на год)
router.get('/:slug/cover', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').slice(0, 80);
    let c = coverCache.get(slug);
    if (!c) {
      const doc = await Category.findOne({ slug }).select('cover coverType -_id').lean();
      if (!doc?.cover) return res.status(404).set('Cache-Control', 'no-store').end();
      c = { type: doc.coverType || 'image/jpeg', buf: Buffer.from(doc.cover.buffer || doc.cover) };
      if (coverCache.size >= COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
      coverCache.set(slug, c);
    }
    res.set('Content-Type', c.type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(c.buf);
  } catch (err) {
    console.error('[GET /categories/:slug/cover]', err);
    res.status(500).set('Cache-Control', 'no-store').end();
  }
});

module.exports = router;
