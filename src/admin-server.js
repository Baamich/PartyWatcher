const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const config = require('./config');
const connectDB = require('./db/mongoose');
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const supportRoutes = require('./routes/support.routes');
const cspRoutes = require('./routes/csp.routes');
const securityHeaders = require('./middleware/securityHeaders');
const i18n = require('./services/i18n');

async function start() {
  await connectDB();

  const app = express();
  app.set('trust proxy', 1); // за cloudflared: иначе rate limit видит у всех один IP 127.0.0.1

  // cors() не нужен: админка ходит в API только со своего же домена
  app.use(securityHeaders());
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });
  app.use(express.json());
  app.use(cookieParser());
  app.use(i18n.middleware);
  app.get('/locales/:lang.js', i18n.bundle);

  // API
  app.use('/api/support', supportRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/csp-report', cspRoutes);
  

  // Статика БЕЗ автоматической отдачи index.html
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,   // ← важно!
  }));

  // Главная страница админки
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // Всё остальное
  app.use((req, res) => {
    res.status(404).send('Not found');
  });

  app.listen(config.adminPort, () => {
    console.log(`[admin-server] listening on port ${config.adminPort} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start admin-server:', err);
  process.exit(1);
});