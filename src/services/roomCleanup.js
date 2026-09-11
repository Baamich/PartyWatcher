const cron = require('node-cron');
const Room = require('../models/Room');

cron.schedule('0 * * * *', async () => {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);
  const expired = await Room.find({ emptySince: { $ne: null, $lte: cutoff } });
  if (expired.length) {
    await Room.deleteMany({ _id: { $in: expired.map((r) => r._id) } });
    console.log(`[cleanup] удалено неактивных комнат: ${expired.length}`);
  }
});