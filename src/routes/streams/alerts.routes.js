// /api/alerts — студия → 🔔 События: настройки алертов (автосохранение по одному событию), раскладка карточек,
// ключ оверлея/API, «Проверить», свои GIF и звуки (их же используют награды)
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../../middleware/auth');
const C = require('../../public/alerts/catalog');
const alerts = require('../../services/alerts');
const AlertSettings = require('../../models/AlertSettings');
const AlertMedia = require('../../models/AlertMedia');
const User = require('../../models/User');

const ID_RE = /^[a-f0-9]{24}$/i;
const MEDIA_MAX = { image: 3 * 1024 * 1024, sound: 1024 * 1024 };
const MEDIA_COUNT = 30;
const IMAGE_RE = /^data:(image\/(?:gif|png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const SOUND_RE = /^data:(audio\/(?:mpeg|mp3|ogg|wav|x-wav|webm));base64,([A-Za-z0-9+/=]+)$/;

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id).select('_id streamerName streamerNameLower').lean();
  if (!me || !me.streamerName) return res.status(403).json({ error: req.t('server.presets.noStreamer') });
  req.me = me;
  next();
}

async function getDoc(me) {
  let doc = await AlertSettings.findOne({ userId: me._id }).lean();
  if (!doc) {
    try {
      doc = (await AlertSettings.create({ userId: me._id, streamerNameLower: me.streamerNameLower })).toObject();
    } catch (e) {
      if (e.code !== 11000) throw e;
      doc = await AlertSettings.findOne({ userId: me._id }).lean();
    }
  }
  return doc;
}

const maskKey = (k) => (k ? '••••••••' + k.slice(-4) : null);
const mediaView = (m) => ({ id: String(m._id), kind: m.kind, name: m.name, size: m.size, ref: 'media:' + m._id });

// GET /alerts/settings — всё для страницы
router.get('/settings', auth, requireStreamer, async (req, res) => {
  const doc = await getDoc(req.me);
  const events = {};
  for (const ev of C.EVENTS) events[ev.id] = alerts.eventCfg(doc, ev.id);
  const media = await AlertMedia.find({ userId: req.me._id }).select('-data').sort({ createdAt: -1 }).lean();
  res.json({ events, layout: doc.layout || null, keyMasked: maskKey(doc.key), media: media.map(mediaView), mediaMax: MEDIA_COUNT });
});

// PUT /alerts/events/:id — настройки одного события (автосохранение)
router.put('/events/:id', auth, requireStreamer, async (req, res) => {
  const id = String(req.params.id);
  if (!C.eventById(id)) return res.status(404).json({ error: req.t('server.alerts.badEvent') });
  const cfg = C.cleanEvent(id, req.body);
  // своя GIF/звук — только из своих файлов
  for (const k of ['anim', 'sound']) {
    if (/^media:/.test(cfg[k])) {
      const ok = await AlertMedia.exists({ _id: cfg[k].slice(6), userId: req.me._id, kind: k === 'anim' ? 'image' : 'sound' });
      if (!ok) cfg[k] = C.eventById(id)[k];
    }
  }
  await getDoc(req.me);
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { ['events.' + id]: cfg } });
  alerts.invalidate(req.me.streamerNameLower);
  res.json({ event: cfg });
});

// PUT /alerts/layout { panels } — где лежат карточки
router.put('/layout', auth, requireStreamer, async (req, res) => {
  const panels = {};
  for (const ev of C.EVENTS) {
    const r = req.body?.panels?.[ev.id];
    if (!r || typeof r !== 'object') continue;
    const n = (v, min, max) => Math.round(Math.min(max, Math.max(min, Number(v) || 0)));
    panels[ev.id] = { x: n(r.x, 0, 4000), y: n(r.y, 0, 8000), w: n(r.w, 220, 1200), h: n(r.h, 200, 1200) };
  }
  await getDoc(req.me);
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { layout: { panels } } });
  res.json({ status: 'ok' });
});

router.delete('/layout', auth, requireStreamer, async (req, res) => {
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { layout: null } });
  res.json({ status: 'ok' });
});

// GET /alerts/key — ключ целиком (для копирования ссылки оверлея); POST — выпустить новый (старый перестаёт работать)
router.get('/key', auth, requireStreamer, async (req, res) => {
  const doc = await getDoc(req.me);
  if (!doc.key) return res.status(404).json({ error: req.t('server.alerts.noKey') });
  res.set('Cache-Control', 'no-store');
  res.json({ key: doc.key });
});
router.post('/key', auth, requireStreamer, async (req, res) => {
  await getDoc(req.me);
  const key = crypto.randomBytes(24).toString('base64url');
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { key } });
  res.set('Cache-Control', 'no-store');
  res.json({ key, keyMasked: maskKey(key) });
});

// POST /alerts/test/:id — показать событие в OBS с примером данных
const testLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false, message: (req) => ({ error: req.t('server.alerts.tooMany') }),
});
router.post('/test/:id', auth, requireStreamer, testLimiter, async (req, res) => {
  const ev = C.eventById(String(req.params.id));
  if (!ev) return res.status(404).json({ error: req.t('server.alerts.badEvent') });
  await alerts.fire(req.me.streamerNameLower, ev.id, { ...ev.sample }, { test: true });
  res.json({ status: 'ok' });
});

// ---------- свои файлы: GIF/картинка (до 3 МБ) и звук (до 1 МБ) ----------
const uploadLimiter = rateLimit({
  windowMs: 3600 * 1000, limit: 40, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false, message: (req) => ({ error: req.t('server.alerts.tooMany') }),
});
router.post('/media', auth, requireStreamer, uploadLimiter, async (req, res) => {
  const kind = req.body?.kind === 'sound' ? 'sound' : 'image';
  const m = (kind === 'sound' ? SOUND_RE : IMAGE_RE).exec(String(req.body?.data || ''));
  if (!m) return res.status(400).json({ error: req.t(kind === 'sound' ? 'server.alerts.badSound' : 'server.alerts.badImage') });
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > MEDIA_MAX[kind]) {
    return res.status(400).json({ error: req.t('server.alerts.tooBig', { mb: MEDIA_MAX[kind] / 1024 / 1024 }) });
  }
  if ((await AlertMedia.countDocuments({ userId: req.me._id })) >= MEDIA_COUNT) {
    return res.status(400).json({ error: req.t('server.alerts.mediaLimit', { n: MEDIA_COUNT }) });
  }
  const doc = await AlertMedia.create({
    userId: req.me._id, kind, mime: m[1] === 'audio/mp3' ? 'audio/mpeg' : m[1],
    name: String(req.body?.name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60), data, size: data.length,
  });
  res.status(201).json({ media: mediaView(doc) });
});

router.delete('/media/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.alerts.mediaNotFound') });
  await AlertMedia.deleteOne({ _id: req.params.id, userId: req.me._id });
  res.json({ status: 'ok' });
});

// GET /alerts/media/:id — сам файл (оверлей и студия). Файл не меняется — кэш на год
const fileCache = new Map();
let fileCacheBytes = 0;
router.get('/media/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  let f = fileCache.get(req.params.id);
  if (!f) {
    const doc = await AlertMedia.findById(req.params.id).select('mime data').lean();
    if (!doc) return res.status(404).set('Cache-Control', 'no-store').end();
    f = { mime: doc.mime, buf: Buffer.from(doc.data.buffer || doc.data) };
    if (fileCacheBytes + f.buf.length > 50 * 1024 * 1024) { fileCache.clear(); fileCacheBytes = 0; }
    fileCache.set(req.params.id, f);
    fileCacheBytes += f.buf.length;
  }
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(f.buf);
});

module.exports = router;
