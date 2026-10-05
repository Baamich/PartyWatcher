// room.routes.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Room = require('../models/Room');
const auth = require('../middleware/auth');
const ChatMessage = require('../models/ChatMessage');
const { extractYoutubeId } = require('../services/ytdlpAgeGate');

const fs = require('fs');
const path = require('path');
const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';


const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 64);

function generateCode() {
  return crypto.randomBytes(3).toString('hex');
}

function withLiveStatus(room, io) {
  const viewerCount = io.sockets.adapter.rooms.get(room.code)?.size || 0;
  return { ...room.toObject(), viewerCount };
}

const VIDEO_TYPES = ['youtube', 'twitch', 'drive', 'player_capture', 'direct'];

function validateVideo(video) {
  const t = video?.type;
  const u = String(video?.url || '').trim();
  if (!VIDEO_TYPES.includes(t)) return 'Неизвестный тип видео';
  if ((t === 'direct' || t === 'player_capture') && !/^https?:\/\//i.test(u)) {
    return 'Нужна полная ссылка (http/https)';
  }
  if (t === 'twitch' && !/twitch\.tv\/videos\/\d+/.test(u)) {
    return 'Нужна ссылка на запись Twitch (twitch.tv/videos/...)';
  }
  if (t === 'drive' && !/^[A-Za-z0-9_-]{10,100}$/.test(u)) {
    return 'Не удалось распознать файл Google Диска';
  }
  // ссылка на YouTube должна содержать настоящий id видео (потом её обрабатывает yt-dlp на сервере)
  if (t === 'youtube' && !extractYoutubeId(u)) {
    return 'Не удалось распознать ссылку YouTube';
  }
  return null;
}

router.post('/', auth, async (req, res) => {
  try {
    const { name, video, isPublic } = req.body;
    if (!name || !video?.type || !video?.url) {
      return res.status(400).json({ error: 'Нужно имя комнаты и видео' });
    }
    const videoError = validateVideo(video);
    if (videoError) return res.status(400).json({ error: videoError });

    if ((await Room.countDocuments({ owner: req.user.id })) >= 30) {
      return res.status(400).json({ error: 'Слишком много комнат: удали ненужные' });
    }

    let code;
    do {
      code = generateCode();
    } while (await Room.findOne({ code }));

    // из запроса берём только тип и ссылку: остальное (ageRestricted, directUrl, meta) выставляет сервер
    const room = await Room.create({
      name: String(name).trim().slice(0, 100),
      code,
      owner: req.user.id,
      video: { type: video.type, url: String(video.url).trim() },
      isPublic: !!isPublic,
    });

    // мгновенно обновляем списки у всех, кто на главной
    const io = req.app.get('io');
    if (room.isPublic) {
      io.to('lobby').emit('rooms:public-updated');
    }
    // свои комнаты тоже можно обновить (на случай если человек остался на главной)
    io.to(`user:${req.user.id}`).emit('rooms:mine-updated');

    res.status(201).json(room);
  } catch (err) {
    console.error('[rooms/create]', err);
    res.status(500).json({ error: err.message || 'Не удалось создать комнату' });
  }
});

router.get('/public', auth, async (req, res) => {
  const io = req.app.get('io');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 52;
  const sort = String(req.query.sort || 'newest');
  const onlyWithPeople = req.query.onlyWithPeople === '1';
  const q = String(req.query.q || '').trim();

  const filter = {
    isPublic: true,
    owner: { $ne: req.user.id },
    $or: [
      { 'video.ageRestricted': { $ne: true } },
      { ageConfirmed: true },
    ],
  };

  if (onlyWithPeople) {
    filter.viewerCount = { $gt: 0 };
  }

  if (q) {
    filter.name = { $regex: escapeRegex(q), $options: 'i' };
  }

  let sortOption = { createdAt: -1 };
  if (sort === 'oldest') sortOption = { createdAt: 1 };
  if (sort === 'most')   sortOption = { viewerCount: -1, createdAt: -1 };
  if (sort === 'least')  sortOption = { viewerCount: 1, createdAt: -1 };

  const total = await Room.countDocuments(filter);
  const rooms = await Room.find(filter)
    .select('-bannedUsers')
    .sort(sortOption)
    .skip((page - 1) * limit)
    .limit(limit);

  // подстраховка: если вдруг кэш устарел — берём актуальный из сокетов
  const result = rooms.map((r) => {
    const live = io.sockets.adapter.rooms.get(r.code)?.size;
    return {
      ...r.toObject(),
      viewerCount: live !== undefined ? live : r.viewerCount || 0,
    };
  });

  res.json({
    rooms: result,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  });
});

router.get('/mine', auth, async (req, res) => {
  const io = req.app.get('io');
  const rooms = await Room.find({ owner: req.user.id }).sort({ createdAt: -1 });
  res.json(rooms.map((r) => withLiveStatus(r, io)));
});

router.get('/search', auth, async (req, res) => {
  const io = req.app.get('io');
  const q = escapeRegex(req.query.q || '');
  const rooms = await Room.find({ owner: req.user.id, name: { $regex: q, $options: 'i' } }).sort({ createdAt: -1 });
  res.json(rooms.map((r) => withLiveStatus(r, io)));
});

router.delete('/:code', auth, async (req, res) => {
  const room = await Room.findOne({ code: req.params.code });
  if (!room) return res.status(404).json({ error: 'Не найдено' });
  if (String(room.owner) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Не твоя комната' });
  }

  const io = req.app.get('io');
  io.to(room.code).emit('room:deleted');

  // обновляем списки на главной
  if (room.isPublic) {
    io.to('lobby').emit('rooms:public-updated');
  }
  io.to(`user:${req.user.id}`).emit('rooms:mine-updated');

  await ChatMessage.deleteMany({ room: room._id });
  await room.deleteOne();

  const playerCaptureCache = require('../services/playerCaptureCache');
  playerCaptureCache.clearRoom(room.code);
  try { fs.unlinkSync(path.join(THUMB_DIR, `${room.code}.jpg`)); } catch (_) {}
  res.json({ status: 'ok' });
});

router.get('/:code', auth, async (req, res) => {
  const room = await Room.findOne({ code: req.params.code });
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });
  res.json({ code: room.code, name: room.name });
});

router.post('/:code/change-video', auth, async (req, res) => {
  try {
    const room = await Room.findOne({ code: req.params.code });
    if (!room) return res.status(404).json({ error: 'Комната не найдена' });
    if (String(room.owner) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Только хост может сменить видео' });
    }

    let rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'Нужна ссылка' });

    const type = room.video.type;
    let url = rawUrl;

    if (type === 'youtube') {
      if (!extractYoutubeId(rawUrl)) {
        return res.status(400).json({ error: 'Нужна ссылка YouTube (режим комнаты — youtube)' });
      }
    } else if (type === 'twitch') {
      if (!/twitch\.tv\/videos\//.test(rawUrl)) {
        return res.status(400).json({ error: 'Нужна ссылка на VOD Twitch (twitch.tv/videos/...)' });
      }
    } else if (type === 'drive') {
      const match = rawUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || rawUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (!match && !/^[a-zA-Z0-9_-]+$/.test(rawUrl)) {
        return res.status(400).json({ error: 'Не удалось распознать ссылку Google Диска' });
      }
      url = match ? match[1] : rawUrl;
    } else if (type === 'player_capture' || type === 'direct') {
      if (!rawUrl.startsWith('http')) {
        return res.status(400).json({ error: 'Нужна полная ссылка (http/https)' });
      }
    } else {
      return res.status(400).json({ error: 'Смена ссылки для этого режима не поддерживается' });
    }

    room.video.url = url;
    room.video.title = undefined;
    room.video.ageRestricted = false;
    room.video.directUrl = null;
    room.ageConfirmed = false;
    if (room.video.meta) {
      room.video.meta.currentSeason = null;
      room.video.meta.currentEpisode = null;
      room.video.meta.currentVoice = null;
      room.video.meta.seasons = [];
      room.video.meta.voices = [];
    }
    room.playback = { isPlaying: false, positionSeconds: 0, updatedAt: new Date() };
    room.thumbnailUrl = null;
    room.markModified('video');
    room.markModified('playback');
    await room.save();

    if (type === 'player_capture') {
      try {
        const playerCaptureCache = require('../services/playerCaptureCache');
        playerCaptureCache.clearRoom(room.code);
      } catch (_) {}
    }

    try {
      fs.unlinkSync(path.join(THUMB_DIR, `${room.code}.jpg`));
    } catch (_) {}

    const io = req.app.get('io');
    io.to(room.code).emit('room:video-changed', {
      video: room.video,
      playback: room.playback,
      by: req.user.username,
    });
    io.to(room.code).emit('chat:message', {
      username: 'Система',
      text: `Хост сменил видео`,
      at: Date.now(),
    });

    if (room.isPublic) {
      io.to('lobby').emit('rooms:public-updated');
    }

    res.json({ status: 'ok', video: room.video, playback: room.playback });
  } catch (err) {
    console.error('[rooms/change-video]', err);
    res.status(500).json({ error: err.message || 'Не удалось сменить видео' });
  }
});

module.exports = router;