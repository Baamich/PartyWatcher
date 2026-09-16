// roomCleanup.js

const cron = require('node-cron');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');

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