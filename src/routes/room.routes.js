const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Room = require('../models/Room');
const auth = require('../middleware/auth');

function generateCode() {
  return crypto.randomBytes(3).toString('hex'); // 6 символов
}

router.post('/', auth, async (req, res) => {
  const { name, video, isPublic } = req.body;
  if (!name || !video?.type || !video?.url) {
    return res.status(400).json({ error: 'Нужно имя комнаты и видео' });
  }

  let code;
  do {
    code = generateCode();
  } while (await Room.findOne({ code }));

  const room = await Room.create({
    name,
    code,
    owner: req.user.id,
    video,
    isPublic: isPublic !== false,
  });

  res.status(201).json(room);
});

router.get('/search', auth, async (req, res) => {
  const q = req.query.q || '';
  const rooms = await Room.find({ isPublic: true, name: { $regex: q, $options: 'i' } }).limit(50);
  res.json(rooms);
});

router.get('/:code', auth, async (req, res) => {
  const room = await Room.findOne({ code: req.params.code });
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });
  res.json(room);
});

module.exports = router;