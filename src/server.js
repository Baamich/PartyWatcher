const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { Server } = require('socket.io');

const config = require('./config');
const connectDB = require('./db/mongoose');
const registerRoomSocket = require('./sockets/roomSocket');
require('./services/roomCleanup');

const authRoutes = require('./routes/auth.routes');
const roomRoutes = require('./routes/room.routes');
const videoRoutes = require('./routes/video.routes');
const adminRoutes = require('./routes/admin.routes');
const driveRoutes = require('./routes/drive.routes');
const playerCaptureRoutes = require('./routes/playerCapture.routes');
const streamProxyRoutes = require('./routes/streamProxy.routes');
const youtubeCaptureRoutes = require('./routes/youtubeCapture.routes');
const voiceRoutes = require('./routes/voice.routes');

const supportRoutes = require('./routes/support.routes');
const streamersRoutes = require('./routes/streams/streamers.routes');
const debugScreenshotsDir = path.join(process.cwd(), 'debug-screenshots');
const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';

async function start() {
  await connectDB();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  
  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(path.join(process.cwd(), config.upload.dir)));
  app.use('/media/thumbnails', express.static(THUMB_DIR));
  app.use('/media/yt-cache', express.static(YT_CACHE_DIR));

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/drive', driveRoutes);
  app.use('/api/player-capture', playerCaptureRoutes);
  app.use('/api/stream', streamProxyRoutes);
  app.use('/api/youtube-capture', youtubeCaptureRoutes);
  app.use('/api/voice',  voiceRoutes);

  app.use('/debug-screenshots', express.static(debugScreenshotsDir));
  app.use('/api/support', supportRoutes);
  app.use('/api/streamers', streamersRoutes);

  // страница профиля стримера — единый шаблон на любое имя
  app.get('/streamers/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'streamers', 'streamer.html'));
  });
    
  app.set('io', io);

  registerRoomSocket(io);

  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Файл слишком большой (лимит: ${config.upload.maxSizeMb} MB)` });
    }
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  server.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});