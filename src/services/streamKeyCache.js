const User = require('../models/User');

const byKey = new Map(); // streamKey -> { userId, playbackId, streamerNameLower }
const byPlaybackId = new Map(); // playbackId -> streamKey (для обратного поиска при отдаче HLS)

async function loadAll() {
  const users = await User.find({ streamKey: { $ne: null } })
    .select('_id streamKey streamPlaybackId streamerNameLower')
    .lean();
  byKey.clear();
  byPlaybackId.clear();
  users.forEach((u) => {
    byKey.set(u.streamKey, {
      userId: String(u._id),
      playbackId: u.streamPlaybackId,
      streamerNameLower: u.streamerNameLower,
    });
    if (u.streamPlaybackId) byPlaybackId.set(u.streamPlaybackId, u.streamKey);
  });
}

function set(oldKey, newKey, entry) {
  if (oldKey) {
    const old = byKey.get(oldKey);
    if (old?.playbackId) byPlaybackId.delete(old.playbackId);
    byKey.delete(oldKey);
  }
  byKey.set(newKey, entry);
  if (entry.playbackId) byPlaybackId.set(entry.playbackId, newKey);
}

function get(key) {
  return byKey.get(key) || null;
}

function keyByPlaybackId(playbackId) {
  return byPlaybackId.get(playbackId) || null;
}

module.exports = { loadAll, set, get, keyByPlaybackId };