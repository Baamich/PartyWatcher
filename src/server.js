const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { Server } = require('socket.io');

const config = require('./config');
const connectDB = require('./db/mongoose');
const registerRoomSocket = require('./sockets/roomSocket');

const authRoutes = require('./routes/auth.routes');
const roomRoutes = require('./routes/room.routes');
const videoRoutes = require('./routes/video.routes');
const adminRoutes = require('./routes/admin.routes');

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

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);

  registerRoomSocket(io);

  server.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Файл слишком большой (лимит: ${config.upload.maxSizeMb} MB)` });
  }
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});