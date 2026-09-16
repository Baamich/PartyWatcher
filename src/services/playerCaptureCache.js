// playerCaptureCache.js
// простой in-memory кэш результатов /extract, живёт пока жива комната
const cache = new Map(); // key: `${roomCode}:${episode}` → { data, expiresAt }
const TTL_MS = 60 * 60 * 1000; // 60 минут

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
  // не кэшируем пустые/неуспешные ответы
  if (!data || !data.success) return;
  if ((!data.streams || data.streams.length === 0) && (!data.playerIframes || data.playerIframes.length === 0)) {
    return;
  }
  const key = buildKey(roomCode, episode);
  cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

function clearRoom(roomCode) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${roomCode}:`)) {
      cache.delete(key);
    }
  }
}

module.exports = { get, set, clearRoom };