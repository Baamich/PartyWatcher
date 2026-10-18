require('./services/logTime'); // время и уровень в начале каждой строки лога (раздел «📜 Логи» админки)
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
const adminRoutes = require('./routes/admin.routes');
const driveRoutes = require('./routes/drive.routes');
const playerCaptureRoutes = require('./routes/playerCapture.routes');
const streamProxyRoutes = require('./routes/streamProxy.routes');
const youtubeCaptureRoutes = require('./routes/youtubeCapture.routes');
const voiceRoutes = require('./routes/voice.routes');
const kodikRoutes = require('./routes/kodik.routes');

const supportRoutes = require('./routes/support.routes');
const streamersRoutes = require('./routes/streams/streamers.routes');
const workbenchRoutes = require('./routes/streams/workbench.routes');
const presetsRoutes = require('./routes/streams/presets.routes');
const categoriesRoutes = require('./routes/streams/categories.routes');
const directoryRoutes = require('./routes/streams/directory.routes');
const clipsRoutes = require('./routes/streams/clips.routes');
const channelRoutes = require('./routes/streams/channel.routes');
const emotesRoutes = require('./routes/streams/emotes.routes');
const alertsRoutes = require('./routes/streams/alerts.routes');
const { pointsRouter, rewardsRouter } = require('./routes/streams/rewards.routes');
const registerAlertsSocket = require('./sockets/alertsSocket');
const registerChatSocket = require('./sockets/chatSocket');
const rtmpServer = require('./services/rtmpServer');
const streamKeyCache = require('./services/streamKeyCache');
const { sendLiveMaster } = require('./services/liveMaster');
const debugScreenshotsDir = path.join(process.cwd(), 'debug-screenshots');
const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';

const CHAT_ROUTES =  require('./routes/chat');
const NEWS_ROUTES = require('./routes/news');
const securityHeaders = require('./middleware/securityHeaders');
const cspRoutes = require('./routes/csp.routes');
const i18n = require('./services/i18n');
const pages = require('./services/pages');
const assets = require('./services/assets');
const compression = require('compression');

// сжатие ответов, которые собираются на лету (HTML, JSON API, словари): свои js/css уже сжаты заранее (assets.js).
// Видео, relay потоков и сокеты не трогаем — там сжатие только задерживало бы поток
function compressFilter(req, res) {
  if (/^\/(media|api\/stream|socket\.io)\//.test(req.path)) return false;
  return compression.filter(req, res);
}

const roles = require('./services/roles');
const authMw = require('./middleware/auth');
const perf = require('./services/perf');
const bans = require('./services/bans');
const analytics = require('./services/analytics');
const adminStatsRoutes = require('./routes/adminStats.routes');
const adminUsersRoutes = require('./routes/adminUsers.routes');
const adminDetectRoutes = require('./routes/adminDetect.routes');

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
  // cloudflared держит соединения к сайту открытыми и переиспользует их: у Node по умолчанию 5 с простоя —
  // туннель иногда попадал в уже закрытое соединение (лишняя попытка и задержка). Держим дольше, чем он
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  const siteOrigin = (() => { try { return new URL(config.publicUrl).origin; } catch { return null; } })();
  const io = new Server(server, {
    cors: { origin: siteOrigin ? [siteOrigin] : false },
    allowRequest: (req, cb) => {
      if (!bans.allowSocket(req)) return cb(null, false); // забаненный IP/устройство
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);            // не браузер: бот на C#
      cb(null, !siteOrigin || origin === siteOrigin); // браузер: только наш сайт
    },
  });
  
  app.use(perf.serverTiming); // Server-Timing: сколько запрос считался на сервере
  app.use(securityHeaders()); // CSP и остальные заголовки безопасности (режим — CSP_MODE в .env)
  app.use(compression({ threshold: 1024, filter: compressFilter }));
  // браузеры с чужих сайтов к API не пускаем; запросы без Origin (бот, curl) CORS не касается
  app.use(cors({ origin: siteOrigin ? [siteOrigin] : false, credentials: true }));
  app.use('/api/streamers', express.json({ limit: '15mb' })); // аватар, баннер, макет
  app.use('/api/emotes', express.json({ limit: '1mb' })); // картинка смайла (до 256 КБ в base64)
  app.use('/api/alerts', express.json({ limit: '5mb' })); // своя GIF алерта (до 3 МБ в base64)
  app.use('/api/support', express.json({ limit: '7mb' })); // скриншоты к обращению (до 5 по 1 МБ, base64)
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(i18n.middleware); // req.lang и req.t для сообщений API
  app.use(bans.guard); // забаненные IP и устройства — 403 на всё (админа не трогает)
  app.use(analytics.middleware); // статистика админки: счётчики в памяти, в базу раз в минуту
  app.get('/locales/:lang.js', i18n.bundle); // словари для браузера (src/locales)
  // страницы документации студии: src/locales/<язык>/docs/*.html
  for (const lang of i18n.LANGS) {
    app.use(`/locales/${lang}/docs`, express.static(path.join(i18n.LOCALES_DIR, lang, 'docs'), { index: false, setHeaders: pages.staticHeaders }));
  }

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

  const ADMIN_PATHS = /^\/(admin(\.html)?|js\/admin(-stats|-users|-detect|-logs)?\.js|css\/admin(-stats)?\.css)\/?$/i;
  app.use(async (req, res, next) => {
    if (!ADMIN_PATHS.test(req.path)) return next();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    // verifyToken сверяет tokenVersion: снятый с роли админ (tokenVersion + 1) со старым токеном страницу не получит
    let isAdmin = false;
    try {
      const t = req.cookies && req.cookies.token;
      isAdmin = !!t && roles.isAdminRole((await authMw.verifyToken(t)).role);
    } catch (_) {}
    if (!isAdmin) return res.status(404).send('Not found');
    if (/^\/admin(\.html)?\/?$/i.test(req.path)) {
      return pages.send(req, res, 'admin.html').catch(next);
    }
    next();
  });

  // hls.js берём из npm: файла в репозитории нет, а так он есть после любого npm install, версия — в package-lock
  try {
    const hlsFile = require.resolve('hls.js/dist/hls.min.js');
    // сжатый заранее (brotli/gzip — assets.js), кэш 7 дней
    app.get('/vendor/hls.min.js', assets.middleware(() => hlsFile, (res) => res.setHeader('Cache-Control', 'public, max-age=604800')));
  } catch (_) {
    console.warn('[server] hls.js не установлен — /vendor/hls.min.js будет только из public/vendor');
  }

  // клиент Socket.IO — минифицированный файл из npm с версией по хэшу (вместо /socket.io/socket.io.js: 156 КБ без кэша)
  app.get('/vendor/socket.io.min.js', assets.middleware(pages.absOf, pages.staticHeaders));

  // Impressum: данные владельца — из .env (IMPRINT_*), подставляются в public/impressum.html.
  // Раньше pages.middleware, иначе /impressum.html отдался бы без подстановок
  if (!config.imprint.name || !config.imprint.street || !config.imprint.city) {
    console.warn('[imprint] не заполнены IMPRINT_NAME / IMPRINT_STREET / IMPRINT_CITY в .env — /impressum без данных владельца');
  }
  const imprintOpts = (req) => {
    const im = config.imprint;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const filled = im.name && im.street && im.city;
    return {
      vars: { 'imprint.name': im.name || '—', 'imprint.street': im.street, 'imprint.city': im.city, 'imprint.country': im.country, 'imprint.email': im.email },
      raw: {
        'imprint.phoneRow': im.phone ? `<br />${esc(i18n.t(req.lang, 'imprint.phone'))}: ${esc(im.phone)}` : '',
        'imprint.missing': filled ? '' : `<p class="auth-error">${esc(i18n.t(req.lang, 'imprint.missing'))}</p>`,
      },
    };
  };
  app.get(['/impressum', '/impressum.html', '/imprint'], (req, res, next) => {
    pages.send(req, res, 'impressum.html', imprintOpts(req)).catch(next);
  });
  // политика конфиденциальности (текст — src/locales/<язык>/privacy.json), ответственный — те же IMPRINT_*
  app.get(['/datenschutz', '/datenschutz.html', '/privacy'], (req, res, next) => {
    pages.send(req, res, 'datenschutz.html', imprintOpts(req)).catch(next);
  });

  app.use(pages.middleware); // HTML-страницы: версии файлов, словарь, перевод и данные входа сразу в разметке
  app.use(assets.middleware(pages.absOf, pages.staticHeaders)); // свои js/css: минифицированы и сжаты заранее
  assets.warm([pages.PUBLIC, ...Object.values(pages.VENDOR), ...(() => { try { return [require.resolve('hls.js/dist/hls.min.js')]; } catch { return []; } })()]);
  app.use(express.static(path.join(__dirname, 'public'), { setHeaders: pages.staticHeaders }));
  app.use('/media/thumbnails', express.static(THUMB_DIR));
  // скачанные видео YouTube 18+ — только админу и друзьям (как и сами комнаты с ними)
  app.use('/media/yt-cache', authMw.optional, async (req, res, next) => {
    if (req.user && (await roles.isTrusted(req.user.id))) return next();
    res.status(403).end();
  }, express.static(YT_CACHE_DIR));
  app.use('/media/vod', express.static(path.join(process.cwd(), 'media', 'vod')));
  // клипы не меняются (у каждого свой id) — кэш на неделю
  app.use('/media/clips', express.static(path.join(process.cwd(), 'media', 'clips'), { maxAge: '7d', index: false }));

  app.get('/media/live/:playbackId/*', (req, res) => {
    const key = streamKeyCache.keyByPlaybackId(req.params.playbackId);
    if (!key) return res.status(404).end();

    const liveDir = path.join(process.cwd(), 'media', 'live', key);
    const rel = path.normalize(req.params[0] || '').replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(liveDir, rel);

    // защита от path traversal — итоговый путь обязан остаться внутри папки этого ключа
    if (filePath !== liveDir && !filePath.startsWith(liveDir + path.sep)) return res.status(400).end();

    if (rel === 'master.m3u8') return sendLiveMaster(liveDir, res);
    // плейлисты меняются каждую секунду; сегменты неизменны (номера от времени, не повторяются после перезапуска)
    res.setHeader('Cache-Control', /\.m3u8$/i.test(rel) ? 'no-store' : 'public, max-age=60');
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin', adminStatsRoutes);
  app.use('/api/admin', adminUsersRoutes);
  app.use('/api/admin', adminDetectRoutes);
  app.use('/api/admin', require('./routes/adminLogs.routes'));
  app.use('/api/drive', driveRoutes);
  app.use('/api/player-capture', playerCaptureRoutes);
  app.use('/api/stream', streamProxyRoutes);
  app.use('/api/youtube-capture', youtubeCaptureRoutes);
  app.use('/api/voice',  voiceRoutes);
  app.use('/api/kodik', kodikRoutes);

  if (process.env.PLAYER_CAPTURE_DEBUG === '1') {
    app.use('/debug-screenshots', express.static(debugScreenshotsDir));
  }
  app.use('/api/support', supportRoutes);
  app.use('/api/streamers', streamersRoutes);
  app.use('/api/workbench', workbenchRoutes);
  app.use('/api/presets', presetsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/streams', directoryRoutes);
  app.use('/api/clips', clipsRoutes);
  app.use('/api/channel', channelRoutes);
  app.use('/api/emotes', emotesRoutes);
  app.use('/api/alerts', alertsRoutes);
  app.use('/api/points', pointsRouter);
  app.use('/api/rewards', rewardsRouter);

  app.use('/api/chat', CHAT_ROUTES);
  app.use('/api/news', NEWS_ROUTES);
  app.use('/api/csp-report', cspRoutes);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

  // новости как раздел сайта: та же страница, что в студии, но короткий адрес и меню сайта (переключает news.js)
  app.get(['/news', '/news/'], (req, res, next) => {
    pages.send(req, res, 'workbench/news.html').catch(next);
  });

  // условия пользования (текст — src/locales/<язык>/terms.json, версия — services/terms.js)
  app.get(['/terms', '/terms/'], (req, res, next) => {
    pages.send(req, res, 'terms.html').catch(next);
  });

  // страница профиля стримера — единый шаблон на любое имя
  app.get('/clips/:id', (req, res, next) => {
    pages.send(req, res, 'clips/clip.html').catch(next);
  });

  app.get('/streamers/:name', (req, res, next) => {
    pages.send(req, res, 'streamers/streamer.html').catch(next);
  });

  // профиль пользователя (кнопка-ник в шапке) — единый шаблон на любое имя
  app.get('/u/:name', (req, res, next) => {
    pages.send(req, res, 'profile.html').catch(next);
  });
    
  app.set('io', io);

  registerRoomSocket(io);
  registerChatSocket(io);
  registerAlertsSocket(io);

  bans.start(); // список банов IP/устройств — в память, перечитывается раз в 30 с
  analytics.start(io); // CPU, память, сокеты и посещения — раз в минуту в базу
  require('./services/regQueue').start(); // очередь регистраций: письма, не влезшие в дневной лимит, — когда он откроется

  await streamKeyCache.loadAll(); // заполняем кэш ключей ДО старта RTMP-сервера
  rtmpServer.run();

  // единый обработчик ошибок — ПОСЛЕДНИМ в цепочке
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const tr = req.t || ((k) => i18n.t(i18n.DEFAULT_LANG, k));
    if (err.type === 'entity.too.large') return res.status(413).json({ error: tr('server.tooLarge') });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: tr('server.badJson') });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: tr('server.serverError') });
  });

  server.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});