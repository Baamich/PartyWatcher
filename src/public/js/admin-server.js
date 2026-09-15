// admin-server.js — независимый процесс: живёт и когда partywatcher упал
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const config = require('./config');
const connectDB = require('./db/mongoose');
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');

async function start() {
  await connectDB(); // отдельное подключение к той же базе, не зависит от основного процесса

  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  // отдаём только то, что нужно админке — не поднимаем весь public целиком без разбора,
  // но проще всего отдать всю папку, там нет ничего секретного
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/auth', authRoutes); // логин нужен и тут, вдруг сессия истекла
  app.use('/api/admin', adminRoutes);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  app.listen(config.adminPort, () => {
    console.log(`[admin-server] listening on port ${config.adminPort} (pid ${process.pid})`);
  });
}

start().catch((err) => {
  console.error('Failed to start admin-server:', err);
  process.exit(1);
});