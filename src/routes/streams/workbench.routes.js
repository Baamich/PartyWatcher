const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../../models/User');
const ChannelBan = require('../../models/ChannelBan');
const auth = require('../../middleware/auth');
const streamKeyCache = require('../../services/streamKeyCache');

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
  res.json({
    streamTitle: me.streamTitle || '',
    streamDescription: me.streamDescription || '',
    streamKeyMasked: maskKey(me.streamKey),
    streamPlaybackId: me.streamPlaybackId || null,
    isLive: me.isLive,
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

module.exports = router;