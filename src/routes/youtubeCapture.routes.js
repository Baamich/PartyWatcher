// youtubeCapture.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Room = require('../models/Room');
const { extractYoutubeDirect } = require('../services/ytdlpAgeGate');

router.post('/age-restricted-extract', auth, async (req, res) => {
  const { code } = req.body;
  const room = await Room.findOne({ code });
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });
  if (String(room.owner) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Только хост может переключить источник' });
  }

  try {
    const result = await extractYoutubeDirect(room.video.url);

    room.video.ageRestricted = true;
    room.ageConfirmed = true;
    await room.save();

    if (room.isPublic) {
      req.app.get('io').to('lobby').emit('rooms:public-updated');
    }

    res.json({ success: true, url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Не удалось получить поток' });
  }
});

module.exports = router;