const mongoose = require('mongoose');
const config = require('../config');

async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  console.log('[mongo] connected');

  mongoose.connection.on('error', (err) => {
    console.error('[mongo] connection error:', err);
  });
}

module.exports = connectDB;