const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Room = require('../models/Room');
const auth = require('../middleware/auth');

function generateCode() {
  return crypto.randomBytes(3).toString('hex');
}

function withLiveStatus(room, io) {
  const viewerCount = io.sockets.adapter.rooms.get(room.code)?.size || 0;
  return { ...room.toObject(), viewerCount };
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

  const room = await Room.create({ name, code, owner: req.user.id, video, isPublic: !!isPublic });
  res.status(201).json(room);
});

router.get('/public', auth, async (req, res) => {
  const io = req.app.get('io');
  const q = req.query.q || '';
  const rooms = await Room.find({
    isPublic: true,
    owner: { $ne: req.user.id }, // свои же публичные комнаты и так видны в "Моих комнатах"
    name: { $regex: q, $options: 'i' },
  }).sort({ createdAt: -1 }).limit(100);
  res.json(rooms.map((r) => withLiveStatus(r, io)));
});

router.get('/mine', auth, async (req, res) => {
  const io = req.app.get('io');
  const rooms = await Room.find({ owner: req.user.id }).sort({ createdAt: -1 });
  res.json(rooms.map((r) => withLiveStatus(r, io)));
});

router.get('/search', auth, async (req, res) => {
  const io = req.app.get('io');
  const q = req.query.q || '';
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
  io.to(room.code).emit('room:deleted'); // выкидывает всех, кто сейчас смотрит
  await room.deleteOne();
  res.json({ status: 'ok' });
});

router.get('/:code', auth, async (req, res) => {
  const room = await Room.findOne({ code: req.params.code });
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });
  res.json(room);
});

module.exports = router;