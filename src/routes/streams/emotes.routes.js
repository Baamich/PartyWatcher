// /api/emotes — смайлы: свои (студия), список для чата канала, картинка смайла
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../../middleware/auth');
const emotes = require('../../services/emotes');
const mods = require('../../services/channelMods');
const { hasProfanity } = require('../../services/profanity');
const Emote = require('../../models/Emote');
const User = require('../../models/User');

const ID_RE = /^[a-f0-9]{24}$/i;
const view = (e) => ({ id: String(e._id), code: e.code, isPublic: !!e.isPublic, animated: !!e.animated });

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id).select('_id streamerName streamerNameLower').lean();
  if (!me || !me.streamerName) return res.status(403).json({ error: req.t('server.presets.noStreamer') });
  req.me = me;
  next();
}

const uploadLimiter = rateLimit({
  windowMs: 3600 * 1000, limit: 30, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false,
  message: (req) => ({ error: req.t('server.emotes.tooMany') }),
});

async function limits(me) {
  const [count, pub] = await Promise.all([
    Emote.countDocuments({ streamerNameLower: me.streamerNameLower }),
    Emote.countDocuments({ ownerId: me._id, isPublic: true }),
  ]);
  return { count, max: emotes.MAX_PER_CHANNEL, publicCount: pub, publicMax: emotes.MAX_PUBLIC, maxKb: emotes.MAX_BYTES / 1024 };
}

// GET /emotes/mine — мои смайлы и лимиты (студия)
router.get('/mine', auth, requireStreamer, async (req, res) => {
  const rows = await Emote.find({ streamerNameLower: req.me.streamerNameLower }).select('-data').sort({ createdAt: 1 }).lean();
  res.json({ emotes: rows.map(view), limits: await limits(req.me) });
});

// POST /emotes { code, image (data:URL), isPublic }
router.post('/', auth, requireStreamer, uploadLimiter, async (req, res) => {
  const me = req.me;
  const code = String(req.body?.code || '').trim();
  if (!emotes.CODE_RE.test(code)) return res.status(400).json({ error: req.t('server.emotes.badCode') });
  if (hasProfanity(code)) return res.status(400).json({ error: req.t('server.emotes.badWord') });
  const img = emotes.parseImage(req.body?.image);
  if (!img) return res.status(400).json({ error: req.t('server.emotes.badImage') });
  if (img.tooBig) return res.status(400).json({ error: req.t('server.emotes.tooBig', { kb: emotes.MAX_BYTES / 1024 }) });
  const isPublic = !!req.body?.isPublic;
  const lim = await limits(me);
  if (lim.count >= lim.max) return res.status(400).json({ error: req.t('server.emotes.limit', { n: lim.max }) });
  if (isPublic && img.animated) return res.status(400).json({ error: req.t('server.emotes.publicAnimated') });
  if (isPublic && lim.publicCount >= lim.publicMax) return res.status(400).json({ error: req.t('server.emotes.publicLimit', { n: lim.publicMax }) });
  try {
    const e = await Emote.create({
      ownerId: me._id, streamerNameLower: me.streamerNameLower, code, codeLower: code.toLowerCase(),
      isPublic, animated: img.animated, mime: img.mime, data: img.data,
    });
    emotes.invalidate(me.streamerNameLower);
    res.status(201).json({ emote: view(e), limits: await limits(me) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: req.t(isPublic ? 'server.emotes.publicTaken' : 'server.emotes.codeTaken') });
    throw e;
  }
});

// PATCH /emotes/:id { isPublic } — сделать публичным / убрать из публичных
router.patch('/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.emotes.notFound') });
  const e = await Emote.findOne({ _id: req.params.id, ownerId: req.me._id }).select('-data');
  if (!e) return res.status(404).json({ error: req.t('server.emotes.notFound') });
  const isPublic = !!req.body?.isPublic;
  if (isPublic && !e.isPublic) {
    if (e.animated) return res.status(400).json({ error: req.t('server.emotes.publicAnimated') });
    const lim = await limits(req.me);
    if (lim.publicCount >= lim.publicMax) return res.status(400).json({ error: req.t('server.emotes.publicLimit', { n: lim.publicMax }) });
  }
  try {
    e.isPublic = isPublic;
    await e.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: req.t('server.emotes.publicTaken') });
    throw err;
  }
  emotes.invalidate(req.me.streamerNameLower);
  res.json({ emote: view(e), limits: await limits(req.me) });
});

// DELETE /emotes/:id
router.delete('/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.emotes.notFound') });
  await Emote.deleteOne({ _id: req.params.id, ownerId: req.me._id });
  emotes.invalidate(req.me.streamerNameLower);
  res.json({ limits: await limits(req.me) });
});

// GET /emotes/for/:name — смайлы для чата канала: свои канала (и можно ли ими пользоваться) + публичные
router.get('/for/:name', auth.optional, async (req, res) => {
  const nameLower = String(req.params.name || '').trim().toLowerCase();
  const owner = await User.findOne({ streamerNameLower: nameLower }).select('_id').lean();
  if (!owner) return res.status(404).json({ error: req.t('server.streamers.notFound') });
  let canUseChannel = false;
  if (req.user) {
    const role = await mods.roleOf(nameLower, req.user.id);
    canUseChannel = !!role || (await emotes.isFollower(String(owner._id), String(req.user.id)));
  }
  const [ch, pub] = await Promise.all([emotes.channelMap(nameLower), emotes.publicMap()]);
  const list = (m) => [...m.values()].map((e) => ({ id: e.id, code: e.code }));
  res.set('Cache-Control', 'no-store');
  res.json({ channel: list(ch), public: list(pub).slice(0, 300), canUseChannel });
});

// GET /emotes/:id — картинка (не меняется: новый смайл = новый id)
const imgCache = new Map();
router.get('/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  let e = imgCache.get(req.params.id);
  if (!e) {
    const doc = await Emote.findById(req.params.id).select('mime data').lean();
    if (!doc) return res.status(404).set('Cache-Control', 'no-store').end();
    e = { mime: doc.mime, buf: Buffer.from(doc.data.buffer || doc.data) };
    if (imgCache.size > 2000) imgCache.clear();
    imgCache.set(req.params.id, e);
  }
  res.set('Content-Type', e.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(e.buf);
});

module.exports = router;
