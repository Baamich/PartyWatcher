// video.routes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const router = express.Router();
const auth = require('../middleware/auth');
const config = require('../config');
const Video = require('../models/Video');

const uploadDir = path.join(process.cwd(), config.upload.dir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({ storage, limits: { fileSize: config.upload.maxSizeMb * 1024 * 1024 } });

router.post('/upload', auth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

  const expiresAt = new Date(Date.now() + config.upload.ttlDays * 24 * 60 * 60 * 1000);

  const video = await Video.create({
    owner: req.user.id,
    filename: req.file.filename,
    originalName: req.file.originalname,
    sizeBytes: req.file.size,
    expiresAt,
  });

  res.status(201).json({ id: video._id, url: `/uploads/${video.filename}`, expiresAt: video.expiresAt });
});

router.get('/mine', auth, async (req, res) => {
  const videos = await Video.find({ owner: req.user.id }).sort({ createdAt: -1 });
  res.json(videos);
});

router.delete('/:id', auth, async (req, res) => {
  const video = await Video.findOne({ _id: req.params.id, owner: req.user.id });
  if (!video) return res.status(404).json({ error: 'Не найдено' });

  fs.unlink(path.join(uploadDir, video.filename), () => {});
  await video.deleteOne();
  res.json({ status: 'ok' });
});

// каждый день в 04:00 — чистка просроченных файлов
cron.schedule('0 4 * * *', async () => {
  const expired = await Video.find({ expiresAt: { $lte: new Date() } });
  for (const video of expired) {
    fs.unlink(path.join(uploadDir, video.filename), () => {});
    await video.deleteOne();
  }
  if (expired.length) console.log(`[cleanup] удалено просроченных видео: ${expired.length}`);
});

module.exports = router;