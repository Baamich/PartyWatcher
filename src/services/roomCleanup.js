// roomCleanup.js

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');

const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const YT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // сутки

console.log('[cleanup] крон автоочистки комнат запущен');

cron.schedule('0 * * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const expired = await Room.find({ emptySince: { $ne: null, $lte: cutoff } });

    if (expired.length) {
      const ids = expired.map((r) => r._id);
      await ChatMessage.deleteMany({ room: { $in: ids } });
      await Room.deleteMany({ _id: { $in: ids } });
      console.log(`[cleanup] удалено неактивных комнат: ${expired.length}`);
    }
  } catch (err) {
    console.error('[cleanup] ошибка:', err);
  }
});

// отдельный крон для yt-cache — независим от комнат, т.к. файл может ещё
// использоваться в другой комнате (кэш общий по хэшу URL, не привязан к room.code)
cron.schedule('30 * * * *', () => {
  try {
    if (!fs.existsSync(YT_CACHE_DIR)) return;

    const now = Date.now();
    let removed = 0;

    for (const file of fs.readdirSync(YT_CACHE_DIR)) {
      const filePath = path.join(YT_CACHE_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > YT_CACHE_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    if (removed) console.log(`[cleanup] удалено кэшированных yt-файлов: ${removed}`);
  } catch (err) {
    console.error('[cleanup] ошибка очистки yt-cache:', err);
  }
});