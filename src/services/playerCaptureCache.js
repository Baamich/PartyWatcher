// playerCaptureCache.js
// простой in-memory кэш результатов /extract, живёт пока жива комната
const cache = new Map(); // key: `${roomCode}:${episode}` → { data, expiresAt }

const TTL_MS = 90 * 1000; // 90 секунд — компромисс между экономией запросов и свежестью CDN-ссылок

function buildKey(roomCode, episode) {
  return `${roomCode}:${episode || 1}`;
}

function get(roomCode, episode) {
  const key = buildKey(roomCode, episode);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function set(roomCode, episode, data) {
  const key = buildKey(roomCode, episode);
  cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

// вызывается при удалении комнаты — чистим все записи этой комнаты (все серии)
function clearRoom(roomCode) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${roomCode}:`)) {
      cache.delete(key);
    }
  }
}

module.exports = { get, set, clearRoom };