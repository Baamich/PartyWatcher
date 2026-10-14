// /api/clips — клипы: создать (последние ~30 с эфира), открыть, переименовать, удалить
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const clips = require('../../services/clips');
const categories = require('../../services/categories');
const { hasProfanity } = require('../../services/profanity');
const Clip = require('../../models/Clip');
const User = require('../../models/User');

const ID_RE = /^[a-f0-9]{24}$/i;

// клип — тяжёлая операция (ffmpeg): не чаще 4 в минуту и 30 в час на аккаунт
const minuteLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 4, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false,
  message: (req) => ({ error: req.t('server.clips.tooMany') }),
});
const hourLimiter = rateLimit({
  windowMs: 3600 * 1000, limit: 30, keyGenerator: (req) => String(req.user.id),
  standardHeaders: true, legacyHeaders: false,
  message: (req) => ({ error: req.t('server.clips.tooMany') }),
});

// что видит браузер (без путей на диске)
async function publicClip(c) {
  return {
    id: String(c._id),
    title: c.title || '',
    streamerNameLower: c.streamerNameLower,
    creatorName: c.creatorName,
    durationSec: c.durationSec,
    views: c.views || 0,
    createdAt: c.createdAt,
    url: `/media/${c.fileRel}`,
    thumb: c.thumbRel ? `/media/${c.thumbRel}` : null,
    category: c.categoryId ? await categories.viewByTid(c.categoryId).catch(() => null) : null,
  };
}

// удалять и переименовывать может автор клипа и владелец канала (и модератор с правом удалять сообщения — см. channelMods)
async function canManage(req, c) {
  if (!req.user) return false;
  if (String(c.creatorId) === String(req.user.id) || String(c.streamerId) === String(req.user.id)) return true;
  if (require('../../services/roles').isAdminRole(req.user.role)) return true;
  try {
    const mods = require('../../services/channelMods');
    return await mods.can(c.streamerNameLower, req.user.id, 'deleteMsg');
  } catch (_) {
    return false;
  }
}

// POST /clips { streamer } — клип из идущего эфира
router.post('/', auth, minuteLimiter, hourLimiter, async (req, res) => {
  try {
    const nameLower = String(req.body?.streamer || '').trim().toLowerCase();
    const s = nameLower && await User.findOne({ streamerNameLower: nameLower })
      .select('_id streamerNameLower isLive streamPlaybackId streamTitle streamCategoryId').lean();
    if (!s) return res.status(404).json({ error: req.t('server.streamers.notFound') });
    if (!s.isLive) return res.status(409).json({ error: req.t('server.clips.notLive') });
    const c = await clips.createClip(s, req.user);
    require('../../services/alerts').fire(s.streamerNameLower, 'clip', { name: req.user.username, title: c.title || '' }).catch(() => {});
    res.status(201).json(await publicClip(c));
  } catch (e) {
    if (!e.i18nKey) console.error('[POST /clips]', e);
    res.status(e.i18nKey === 'server.clips.busy' ? 429 : 400).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.clips.failed') });
  }
});

// GET /clips/:id — клип (+1 просмотр) и можно ли мне им управлять
router.get('/:id', auth.optional, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.clips.notFound') });
  const c = await Clip.findOneAndUpdate({ _id: req.params.id }, { $inc: { views: 1 } }, { new: true }).lean();
  if (!c) return res.status(404).json({ error: req.t('server.clips.notFound') });
  const streamer = await User.findById(c.streamerId).select('streamerName streamerNameLower profileRev streamerAvatarUrl').lean();
  res.set('Cache-Control', 'no-store');
  res.json({
    ...(await publicClip(c)),
    streamerName: streamer?.streamerName || c.streamerNameLower,
    streamerAvatar: streamer?.streamerAvatarUrl ? `/api/streamers/${encodeURIComponent(c.streamerNameLower)}/avatar?v=${streamer.profileRev || 0}` : null,
    canManage: await canManage(req, c),
  });
});

// PATCH /clips/:id { title }
router.patch('/:id', auth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.clips.notFound') });
  const c = await Clip.findById(req.params.id).lean();
  if (!c) return res.status(404).json({ error: req.t('server.clips.notFound') });
  if (!(await canManage(req, c))) return res.status(403).json({ error: req.t('server.clips.forbidden') });
  const title = String(req.body?.title || '').trim().replace(/\s+/g, ' ');
  if (title.length > 100) return res.status(400).json({ error: req.t('server.clips.titleLong') });
  if (title && hasProfanity(title)) return res.status(400).json({ error: req.t('server.clips.titleBad') });
  await Clip.updateOne({ _id: c._id }, { $set: { title } });
  res.json({ title });
});

// DELETE /clips/:id
router.delete('/:id', auth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.clips.notFound') });
  const c = await Clip.findById(req.params.id);
  if (!c) return res.status(404).json({ error: req.t('server.clips.notFound') });
  if (!(await canManage(req, c))) return res.status(403).json({ error: req.t('server.clips.forbidden') });
  await clips.removeClip(c);
  res.json({ status: 'ok' });
});

router.publicClip = publicClip;
module.exports = router;
