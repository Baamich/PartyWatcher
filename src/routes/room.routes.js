// room.routes.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Room = require('../models/Room');
const auth = require('../middleware/auth');
const i18n = require('../services/i18n');
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
const MAX_ROOMS_PER_USER = 6; // больше — ошибка «удалите ненужную»

function validateVideo(video) {
  const t = video?.type;
  const u = String(video?.url || '').trim();
  // возвращает ключ словаря ошибки (перевод — req.t) или null
  if (!VIDEO_TYPES.includes(t)) return 'server.room.unknownType';
  if ((t === 'direct' || t === 'player_capture') && !/^https?:\/\//i.test(u)) {
    return 'server.room.needFullUrl';
  }
  if (t === 'twitch' && !/twitch\.tv\/videos\/\d+/.test(u)) {
    return 'server.room.needTwitchVod';
  }
  if (t === 'drive' && !/^[A-Za-z0-9_-]{10,100}$/.test(u)) {
    return 'server.room.badDriveFile';
  }
  // ссылка на YouTube должна содержать настоящий id видео (потом её обрабатывает yt-dlp на сервере)
  if (t === 'youtube' && !extractYoutubeId(u)) {
    return 'server.room.badYoutube';
  }
  return null;
}

router.post('/', auth, async (req, res) => {
  try {
    const { name, video, isPublic } = req.body;
    if (!name || !video?.type || !video?.url) {
      return res.status(400).json({ error: req.t('server.room.needNameAndVideo') });
    }
    const videoError = validateVideo(video);
    if (videoError) return res.status(400).json({ error: req.t(videoError) });

    if ((await Room.countDocuments({ owner: req.user.id })) >= MAX_ROOMS_PER_USER) {
      return res.status(400).json({ error: req.t('server.room.tooMany', { n: MAX_ROOMS_PER_USER }) });
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
    res.status(500).json({ error: req.t('server.room.createFailed') });
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
  if (!room) return res.status(404).json({ error: req.t('server.notFound') });
  if (String(room.owner) !== String(req.user.id)) {
    return res.status(403).json({ error: req.t('server.room.notYours') });
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
  if (!room) return res.status(404).json({ error: req.t('server.room.notFound') });
  res.json({ code: room.code, name: room.name });
});

router.post('/:code/change-video', auth, async (req, res) => {
  try {
    const room = await Room.findOne({ code: req.params.code });
    if (!room) return res.status(404).json({ error: req.t('server.room.notFound') });
    if (String(room.owner) !== String(req.user.id)) {
      return res.status(403).json({ error: req.t('server.room.hostOnlyChange') });
    }

    let rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: req.t('server.room.needUrl') });

    const type = room.video.type;
    let url = rawUrl;

    if (type === 'youtube') {
      if (!extractYoutubeId(rawUrl)) {
        return res.status(400).json({ error: req.t('server.room.needYoutube') });
      }
    } else if (type === 'twitch') {
      if (!/twitch\.tv\/videos\//.test(rawUrl)) {
        return res.status(400).json({ error: req.t('server.room.needTwitchVod2') });
      }
    } else if (type === 'drive') {
      const match = rawUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || rawUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (!match && !/^[a-zA-Z0-9_-]+$/.test(rawUrl)) {
        return res.status(400).json({ error: req.t('server.room.badDrive') });
      }
      url = match ? match[1] : rawUrl;
    } else if (type === 'player_capture' || type === 'direct') {
      if (!rawUrl.startsWith('http')) {
        return res.status(400).json({ error: req.t('server.room.needFullUrl') });
      }
    } else {
      return res.status(400).json({ error: req.t('server.room.changeUnsupported') });
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
      username: 'Система', // служебное имя: клиент показывает его на языке зрителя
      key: 'room.sys.videoChanged', // клиент переводит по ключу, text — запасной вариант
      text: i18n.t(i18n.DEFAULT_LANG, 'server.sys.videoChanged'),
      at: Date.now(),
    });

    if (room.isPublic) {
      io.to('lobby').emit('rooms:public-updated');
    }

    res.json({ status: 'ok', video: room.video, playback: room.playback });
  } catch (err) {
    console.error('[rooms/change-video]', err);
    res.status(500).json({ error: req.t('server.room.changeFailed') });
  }
});

module.exports = router;