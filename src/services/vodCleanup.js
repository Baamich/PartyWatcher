const fs = require('fs');
const path = require('path');
const StreamVod = require('../models/StreamVod');

async function cleanupExpiredVods() {
  const expired = await StreamVod.find({ expiresAt: { $lte: new Date() } }).limit(200);
  for (const v of expired) {
    try {
      fs.unlinkSync(path.join(process.cwd(), 'media', v.fileRel));
    } catch (_) {}
    await v.deleteOne();
  }
  if (expired.length) console.log('[vod-cleanup] удалено', expired.length);
}

cleanupExpiredVods().catch((e) => console.error('[vod-cleanup]', e.message));
setInterval(() => {
  cleanupExpiredVods().catch((e) => console.error('[vod-cleanup]', e.message));
}, 60 * 60 * 1000);

module.exports = {};