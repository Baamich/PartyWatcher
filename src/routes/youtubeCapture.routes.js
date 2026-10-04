// youtubeCapture.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Room = require('../models/Room');
const { ensureExtraction, getCachedUrl, getJobInfo, publicJob } = require('../services/ytdlpAgeGate');

// Комната, где текущий юзер хост, а видео из YouTube. Иначе отвечает ошибкой и возвращает null.
async function loadOwnedYoutubeRoom(req, res) {
  const code = String(req.body?.code ?? req.query?.code ?? ''); // String(): в запрос нельзя подсунуть объект-оператор Mongo
  const room = code ? await Room.findOne({ code }) : null;
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return null;
  }
  if (String(room.owner) !== String(req.user.id)) {
    res.status(403).json({ error: 'Только хост может переключить источник' });
    return null;
  }
  if (room.video.type !== 'youtube') {
    res.status(400).json({ error: 'Это действие только для видео YouTube' });
    return null;
  }
  return room;
}

// Сохраняем копию в комнате (зрители, зашедшие позже, сразу её получат) и сообщаем тем, кто уже внутри.
async function finalizeRoom(code, videoUrl, url, io) {
  const room = await Room.findOne({ code });
  if (!room || room.video.type !== 'youtube' || room.video.url !== videoUrl) return; // хост уже сменил видео

  room.video.ageRestricted = true;
  room.ageConfirmed = true;
  room.video.directUrl = url;
  await room.save();

  if (room.isPublic) io.to('lobby').emit('rooms:public-updated');
  io.to(code).emit('youtube:age-restricted-stream', { url });
}

// POST /youtube-capture/age-restricted-extract — запустить скачивание (отвечает сразу)
router.post('/age-restricted-extract', auth, async (req, res) => {
  try {
    const room = await loadOwnedYoutubeRoom(req, res);
    if (!room) return;

    const videoUrl = room.video.url;
    const io = req.app.get('io');

    // уже скачано раньше
    const cached = getCachedUrl(videoUrl);
    if (cached) {
      if (room.video.directUrl !== cached) await finalizeRoom(room.code, videoUrl, cached, io);
      return res.json({ success: true, status: 'done', url: cached });
    }

    const job = ensureExtraction(videoUrl);

    // когда скачается, обновим именно эту комнату (у одного видео может быть несколько комнат)
    if (!job.hooks.has(room.code)) {
      job.hooks.add(room.code);
      job.promise
        .then((url) => finalizeRoom(room.code, videoUrl, url, io))
        .catch((e) => console.warn('[youtube-capture] скачивание не удалось:', String(e.message).slice(0, 200)));
    }

    res.status(202).json({ success: true, ...publicJob(job) });
  } catch (err) {
    if (err.code === 'BAD_URL') return res.status(400).json({ error: err.message });
    if (err.code === 'QUEUE_FULL') return res.status(429).json({ error: err.message });
    console.error('[youtube-capture/extract]', err);
    res.status(500).json({ error: 'Не удалось запустить скачивание' });
  }
});

// GET /youtube-capture/age-restricted-status?code=... — как идёт скачивание
router.get('/age-restricted-status', auth, async (req, res) => {
  try {
    const room = await loadOwnedYoutubeRoom(req, res);
    if (!room) return;

    const cached = getCachedUrl(room.video.url);
    if (cached) {
      if (room.video.directUrl !== cached) {
        await finalizeRoom(room.code, room.video.url, cached, req.app.get('io'));
      }
      return res.json({ status: 'done', url: cached });
    }

    res.json(getJobInfo(room.video.url) || { status: 'idle' });
  } catch (err) {
    console.error('[youtube-capture/status]', err);
    res.status(500).json({ error: 'Не удалось узнать статус' });
  }
});

module.exports = router;