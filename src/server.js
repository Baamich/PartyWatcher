const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const { Server } = require('socket.io');

const config = require('./config');
const connectDB = require('./db/mongoose');
const User = require('./models/User');
const registerRoomSocket = require('./sockets/roomSocket');
require('./services/roomCleanup');
require('./services/vodCleanup');
require('express-async-errors');

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
const workbenchRoutes = require('./routes/streams/workbench.routes');
const registerChatSocket = require('./sockets/chatSocket');
const rtmpServer = require('./services/rtmpServer');
const streamKeyCache = require('./services/streamKeyCache');
const debugScreenshotsDir = path.join(process.cwd(), 'debug-screenshots');
const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';

const CHAT_ROUTES =  require('./routes/chat');
const NEWS_ROUTES = require('./routes/news');
const securityHeaders = require('./middleware/securityHeaders');
const cspRoutes = require('./routes/csp.routes');

async function start() {
  await connectDB();

  const staleReset = await User.updateMany(
    { isLive: true },
    { $set: { isLive: false, liveStartedAt: null } }
  );
  if (staleReset.modifiedCount) {
    console.log(`[boot] сброшено зависших isLive: ${staleReset.modifiedCount}`);
  }

  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  
  app.use(securityHeaders()); // CSP и остальные заголовки безопасности (режим — CSP_MODE в .env)
  app.use(cors());
  app.use('/api/streamers', express.json({ limit: '15mb' })); // аватар, баннер, макет
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // API не должно кэшироваться ни браузером, ни Cloudflare — иначе статус isLive/чат зависают на старом значении
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    next();
  });
  
  // /index.html -> / (сохраняем query, чтобы не ломались ?returnTo=... и ?mode=register)
  app.get('/index.html', (req, res) => {
    const i = req.originalUrl.indexOf('?');
    const qs = i === -1 ? '' : req.originalUrl.slice(i);
    res.redirect(301, '/' + qs);
  });

  const ADMIN_PATHS = /^\/(admin(\.html)?|js\/admin\.js|css\/admin\.css)\/?$/i;
  app.use((req, res, next) => {
    if (!ADMIN_PATHS.test(req.path)) return next();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    let isAdmin = false;
    try {
      const t = req.cookies && req.cookies.token;
      isAdmin = !!t && jwt.verify(t, config.jwt.secret).role === 'admin';
    } catch (_) {}
    if (!isAdmin) return res.status(404).send('Not found');
    if (/^\/admin(\.html)?\/?$/i.test(req.path)) {
      return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(path.join(process.cwd(), config.upload.dir), {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // даже если туда попадёт HTML, он откроется «в песочнице» без скриптов и доступа к сайту
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; media-src 'self'");
    },
  }));
  app.use('/media/thumbnails', express.static(THUMB_DIR));
  app.use('/media/yt-cache', express.static(YT_CACHE_DIR));
  app.use('/media/vod', express.static(path.join(process.cwd(), 'media', 'vod')));

  app.get('/media/live/:playbackId/*', (req, res) => {
    const key = streamKeyCache.keyByPlaybackId(req.params.playbackId);
    if (!key) return res.status(404).end();

    const liveDir = path.join(process.cwd(), 'media', 'live', key);
    const rel = path.normalize(req.params[0] || '').replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(liveDir, rel);

    // защита от path traversal — итоговый путь обязан остаться внутри папки этого ключа
    if (filePath !== liveDir && !filePath.startsWith(liveDir + path.sep)) return res.status(400).end();

    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/drive', driveRoutes);
  app.use('/api/player-capture', playerCaptureRoutes);
  app.use('/api/stream', streamProxyRoutes);
  app.use('/api/youtube-capture', youtubeCaptureRoutes);
  app.use('/api/voice',  voiceRoutes);

  if (process.env.PLAYER_CAPTURE_DEBUG === '1') {
    app.use('/debug-screenshots', express.static(debugScreenshotsDir));
  }
  app.use('/api/support', supportRoutes);
  app.use('/api/streamers', streamersRoutes);
  app.use('/api/workbench', workbenchRoutes);

  app.use('/api/chat', CHAT_ROUTES);
  app.use('/api/news', NEWS_ROUTES);
  app.use('/api/csp-report', cspRoutes);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

  // страница профиля стримера — единый шаблон на любое имя
  app.get('/streamers/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'streamers', 'streamer.html'));
  });
    
  app.set('io', io);

  registerRoomSocket(io);
  registerChatSocket(io);

  await streamKeyCache.loadAll(); // заполняем кэш ключей ДО старта RTMP-сервера
  rtmpServer.run();

  // единый обработчик ошибок — ПОСЛЕДНИМ в цепочке
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Файл слишком большой (лимит: ${config.upload.maxSizeMb} MB)` });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Ошибка сервера' });
  });

  server.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});