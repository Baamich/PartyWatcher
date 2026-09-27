const fs = require('fs');
const path = require('path');
const StreamVod = require('../models/StreamVod');
const User = require('../models/User');

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

/** recording дольше 2 мин, а юзер уже не в эфире → ready */
async function finalizeStuckRecordings() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const stuck = await StreamVod.find({
    status: 'recording',
    createdAt: { $lte: cutoff },
  }).limit(100);

  let n = 0;
  for (const v of stuck) {
    const user = await User.findById(v.userId).select('isLive').lean();
    if (user && user.isLive) continue;
    await StreamVod.updateOne({ _id: v._id }, { $set: { status: 'ready' } });
    n += 1;
  }
  if (n) console.log('[vod-cleanup] recording→ready (зависшие):', n);
}

async function tick() {
  await cleanupExpiredVods();
  await finalizeStuckRecordings();
}

tick().catch((e) => console.error('[vod-cleanup]', e.message));
setInterval(() => {
  tick().catch((e) => console.error('[vod-cleanup]', e.message));
}, 60 * 1000);

module.exports = {};