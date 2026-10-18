// roomCleanup.js

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');
const notify = require('./notify');

const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const YT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // сутки

const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';

console.log('[cleanup] крон автоочистки комнат запущен');

const EMPTY_TTL_H = 20; // пустая комната живёт 20 часов
const WARN_BEFORE_H = 4; // за 4 часа — уведомление владельцу «скоро удалится»

cron.schedule('0 * * * *', async () => {
  try {
    const now = Date.now();
    const cutoff = new Date(now - EMPTY_TTL_H * 60 * 60 * 1000);
    // крон раз в час: каждая пустая комната попадает в это окно ровно один раз — отметка «уже предупредили» не нужна
    const warnTo = new Date(now - (EMPTY_TTL_H - WARN_BEFORE_H) * 60 * 60 * 1000);
    const warnFrom = new Date(warnTo.getTime() - 60 * 60 * 1000);
    const soon = await Room.find({ emptySince: { $gt: warnFrom, $lte: warnTo } }).select('owner name code').lean();
    for (const r of soon) {
      notify.send(r.owner, 'room.expiring', { name: r.name, h: WARN_BEFORE_H }, { link: `/room.html?code=${encodeURIComponent(r.code)}` });
    }

    const expired = await Room.find({ emptySince: { $ne: null, $lte: cutoff } });

    if (expired.length) {
      const ids = expired.map((r) => r._id);
      await ChatMessage.deleteMany({ room: { $in: ids } });
      await Room.deleteMany({ _id: { $in: ids } });

      // чистим превью удалённых комнат (при явном удалении через кнопку это
      // уже делает room.routes.js, а тут — для комнат, умерших по таймауту)
      for (const room of expired) {
        try { fs.unlinkSync(path.join(THUMB_DIR, `${room.code}.jpg`)); } catch (_) {}
        notify.send(room.owner, 'room.expired', { name: room.name, h: EMPTY_TTL_H }, { link: '/' });
      }

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