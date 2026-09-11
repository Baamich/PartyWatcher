// scripts/test-db.js
require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI)
  .then(() => { console.log('✅ Подключение успешно'); process.exit(0); })
  .catch((err) => { console.error('❌ Ошибка подключения:', err.message); process.exit(1); });