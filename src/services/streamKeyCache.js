const User = require('../models/User');

const cache = new Map(); // streamKey -> { userId, playbackId, streamerNameLower }

async function loadAll() {
  const users = await User.find({ streamKey: { $ne: null } })
    .select('_id streamKey streamPlaybackId streamerNameLower')
    .lean();
  cache.clear();
  users.forEach((u) => {
    cache.set(u.streamKey, {
      userId: String(u._id),
      playbackId: u.streamPlaybackId,
      streamerNameLower: u.streamerNameLower,
    });
  });
}

function set(oldKey, newKey, entry) {
  if (oldKey) cache.delete(oldKey);
  cache.set(newKey, entry);
}

function get(key) {
  return cache.get(key) || null;
}

module.exports = { loadAll, set, get };