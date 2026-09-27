const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const User = require('../../models/User');
const ChannelBan = require('../../models/ChannelBan');
const WorkbenchLayout = require('../../models/WorkbenchLayout');
const ChannelActionLog = require('../../models/ChannelActionLog');
const auth = require('../../middleware/auth');
const streamKeyCache = require('../../services/streamKeyCache');
const StreamVod = require('../../models/StreamVod');

// Проверяем реальность по диску: обновляется ли index.m3u8 прямо сейчас,
// а не полагаемся только на флаг isLive в базе (который мог не долететь/не записаться).
function isCurrentlyLive(streamKey) {
  if (!streamKey) return false;
  try {
    const file = path.join(process.cwd(), 'media', 'live', streamKey, 'master.m3u8');
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < 15000;
  } catch {
    return false;
  }
}

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id);
  if (!me || !me.streamerName) return res.status(403).json({ error: 'У тебя ещё нет профиля стримера' });
  req.streamerUser = me;
  next();
}

function maskKey(key) {
  if (!key) return null;
  return '•'.repeat(Math.max(key.length - 4, 8)) + key.slice(-4);
}

// GET /workbench/me — текущие настройки (ключ только замаскированный)
router.get('/me', auth, requireStreamer, async (req, res) => {
  const me = req.streamerUser;
  const liveNow = isCurrentlyLive(me.streamKey);

  // подчищаем рассинхрон флага в базе, раз уж всё равно проверили диск
  if (liveNow !== me.isLive) {
    me.isLive = liveNow;
    // liveStartedAt чистит только rtmpServer.finalizeStop — не диск
    await me.save();
  }

  res.json({
    streamTitle: me.streamTitle || '',
    streamDescription: me.streamDescription || '',
    streamKeyMasked: maskKey(me.streamKey),
    streamPlaybackId: me.streamPlaybackId || null,
    isLive: liveNow,
    // отдаём всегда, пока finalizeStop не обнулил — чтобы таймер пережил краткий offline
    liveStartedAt: me.liveStartedAt || null,
  });
});



// POST /workbench/stream-key/generate — сгенерировать (или перевыпустить) пару ключ+playbackId
router.post('/stream-key/generate', auth, requireStreamer, async (req, res) => {
  const oldKey = req.streamerUser.streamKey;
  const key = crypto.randomBytes(20).toString('hex');
  const playbackId = crypto.randomBytes(12).toString('hex');

  req.streamerUser.streamKey = key;
  req.streamerUser.streamPlaybackId = playbackId;
  await req.streamerUser.save();

  streamKeyCache.set(oldKey, key, {
    userId: String(req.streamerUser._id),
    playbackId,
    streamerNameLower: req.streamerUser.streamerNameLower,
  });

  res.json({ streamKey: key, streamKeyMasked: maskKey(key) });
});

// POST /workbench/stream-key/reveal — получить полный ключ для копирования
router.post('/stream-key/reveal', auth, requireStreamer, async (req, res) => {
  if (!req.streamerUser.streamKey) return res.status(404).json({ error: 'Ключ ещё не создан' });
  res.json({ streamKey: req.streamerUser.streamKey });
});

// PATCH /workbench/settings — название и описание трансляции
router.patch('/settings', auth, requireStreamer, async (req, res) => {
  const { streamTitle, streamDescription } = req.body;
  if (streamTitle !== undefined) {
    if (String(streamTitle).length > 140) return res.status(400).json({ error: 'Название слишком длинное (максимум 140 символов)' });
    req.streamerUser.streamTitle = String(streamTitle).trim();
  }
  if (streamDescription !== undefined) {
    if (String(streamDescription).length > 2000) return res.status(400).json({ error: 'Описание слишком длинное (максимум 2000 символов)' });
    req.streamerUser.streamDescription = String(streamDescription).trim();
  }
  await req.streamerUser.save();
  res.json({ streamTitle: req.streamerUser.streamTitle, streamDescription: req.streamerUser.streamDescription });
});

// GET /workbench/bans — список заблокированных в чате этого канала
router.get('/bans', auth, requireStreamer, async (req, res) => {
  const bans = await ChannelBan.find({ streamerNameLower: req.streamerUser.streamerNameLower })
    .sort({ bannedAt: -1 })
    .lean();
  res.json(bans);
});

// DELETE /workbench/bans/:userId — разблокировать
router.delete('/bans/:userId', auth, requireStreamer, async (req, res) => {
  await ChannelBan.deleteOne({ streamerNameLower: req.streamerUser.streamerNameLower, userId: req.params.userId });
  res.json({ status: 'ok' });
});

// GET /workbench/layout — сохранённое расположение окон этого пользователя
router.get('/layout', auth, requireStreamer, async (req, res) => {
  const layout = await WorkbenchLayout.findOne({ userId: req.streamerUser._id }).lean();
  res.json({ panels: layout?.panels || null });
});

// PUT /workbench/layout — сохранить расположение окон
router.put('/layout', auth, requireStreamer, async (req, res) => {
  const { panels } = req.body;
  if (panels !== null && typeof panels !== 'object') {
    return res.status(400).json({ error: 'Некорректный формат расположения' });
  }
  await WorkbenchLayout.findOneAndUpdate(
    { userId: req.streamerUser._id },
    { panels, updatedAt: new Date() },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});

// DELETE /workbench/layout — сбросить к расположению по умолчанию
router.delete('/layout', auth, requireStreamer, async (req, res) => {
  await WorkbenchLayout.deleteOne({ userId: req.streamerUser._id });
  res.json({ status: 'ok' });
});

// GET /workbench/action-log — последние действия модерации в этом канале
router.get('/action-log', auth, requireStreamer, async (req, res) => {
  const entries = await ChannelActionLog.find({ streamerNameLower: req.streamerUser.streamerNameLower })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(entries);
});
// GET /workbench/vods
router.get('/vods', auth, requireStreamer, async (req, res) => {
  const vods = await StreamVod.find({ userId: req.streamerUser._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(
    vods.map((v) => ({
      id: v._id,
      title: v.title,
      description: v.description,
      published: v.published,
      status: v.status,
      createdAt: v.createdAt,
      expiresAt: v.expiresAt,
      durationSec: v.durationSec,
      url: v.status === 'ready' ? `/media/${v.fileRel}` : null,
    }))
  );
});

// PATCH /workbench/vods/:id
router.patch('/vods/:id', auth, requireStreamer, async (req, res) => {
  const vod = await StreamVod.findOne({ _id: req.params.id, userId: req.streamerUser._id });
  if (!vod) return res.status(404).json({ error: 'Не найдено' });
  if (req.body.title !== undefined) vod.title = String(req.body.title).slice(0, 140);
  if (req.body.description !== undefined) vod.description = String(req.body.description).slice(0, 2000);
  if (req.body.published !== undefined) vod.published = !!req.body.published;
  await vod.save();
  res.json({ ok: true, published: vod.published, title: vod.title, description: vod.description });
});

// DELETE /workbench/vods/:id
router.delete('/vods/:id', auth, requireStreamer, async (req, res) => {
  const vod = await StreamVod.findOne({ _id: req.params.id, userId: req.streamerUser._id });
  if (!vod) return res.status(404).json({ error: 'Не найдено' });
  try {
    fs.unlinkSync(path.join(process.cwd(), 'media', vod.fileRel));
  } catch (_) {}
  await vod.deleteOne();
  res.json({ ok: true });
});

module.exports = router;