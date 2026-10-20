// /api/widgets — студия → ⏱️ Виджеты и мини-пульт «Поверх окон»: список, создание, настройки, действия
// (старт таймера, +1 к счётчику), раскладка карточек. Только владелец канала; модераторы — командами чата
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../../middleware/auth');
const C = require('../../public/widgets/catalog');
const widgets = require('../../services/widgets');
const i18n = require('../../services/i18n');
const User = require('../../models/User');

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id).select('_id streamerName streamerNameLower').lean();
  if (!me || !me.streamerName) return res.status(403).json({ error: req.t('server.presets.noStreamer') });
  req.me = me;
  next();
}
const fail = (req, res, e) => {
  if (!e?.i18nKey) throw e;
  res.status(e.i18nKey === 'server.widgets.notFound' ? 404 : 400).json({ error: i18n.errText(req, e) });
};

// настройки и раскладку правят редко, действия (кнопки таймера) — часто
const editLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 120, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false, message: (req) => ({ error: req.t('server.widgets.tooMany') }),
});
const actLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 240, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false, message: (req) => ({ error: req.t('server.widgets.tooMany') }),
});

// GET /widgets — всё для страницы и мини-пульта
router.get('/', auth, requireStreamer, async (req, res) => {
  const e = await widgets.forMe(req.me);
  res.set('Cache-Control', 'no-store');
  res.json({ ...widgets.snapshot(e), layout: e.layout, max: C.MAX_WIDGETS, channel: req.me.streamerNameLower });
});

router.post('/', auth, requireStreamer, editLimiter, async (req, res) => {
  try {
    res.status(201).json({ widget: await widgets.create(req.me, String(req.body?.type || '')) });
  } catch (e) { fail(req, res, e); }
});

router.put('/layout', auth, requireStreamer, editLimiter, async (req, res) => {
  const e = await widgets.forMe(req.me);
  const panels = {};
  for (const w of e.widgets) {
    const r = req.body?.panels?.[w.id];
    if (!r || typeof r !== 'object') continue;
    const n = (v, min, max) => Math.round(Math.min(max, Math.max(min, Number(v) || 0)));
    panels[w.id] = { x: n(r.x, 0, 4000), y: n(r.y, 0, 8000), w: n(r.w, 220, 1200), h: n(r.h, 160, 1200) };
  }
  await widgets.setLayout(req.me, { panels });
  res.json({ status: 'ok' });
});

router.delete('/layout', auth, requireStreamer, editLimiter, async (req, res) => {
  await widgets.setLayout(req.me, null);
  res.json({ status: 'ok' });
});

router.put('/:id', auth, requireStreamer, editLimiter, async (req, res) => {
  try {
    res.json({ widget: await widgets.update(req.me, req.params.id, req.body) });
  } catch (e) { fail(req, res, e); }
});

router.delete('/:id', auth, requireStreamer, editLimiter, async (req, res) => {
  await widgets.remove(req.me, req.params.id);
  res.json({ status: 'ok' });
});

// POST /widgets/:id/action { action, arg } — см. widgets.ACTIONS
router.post('/:id/action', auth, requireStreamer, actLimiter, async (req, res) => {
  try {
    const action = String(req.body?.action || '');
    const arg = req.body?.arg;
    res.json({ widget: await widgets.act(req.me.streamerNameLower, req.params.id, action, typeof arg === 'string' ? arg.slice(0, 1000) : arg) });
  } catch (e) { fail(req, res, e); }
});

module.exports = router;
