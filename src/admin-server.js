const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const config = require('./config');
const connectDB = require('./db/mongoose');
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const supportRoutes = require('./routes/support.routes');

async function start() {
  await connectDB();

  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  // API
  app.use('/api/support', supportRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);

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