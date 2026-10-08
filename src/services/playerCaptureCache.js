// playerCaptureCache.js
// простой in-memory кэш результатов /extract, живёт пока жива комната
const cache = new Map(); // key: `${roomCode}:${season}:${episode}` → { data, expiresAt }
const TTL_MS = 60 * 60 * 1000; // 60 минут

// сезон в ключе обязателен: иначе «2 сезон, 3 серия» отдавала бы кэш «1 сезон, 3 серия»
function buildKey(roomCode, episode, season) {
  return `${roomCode}:${Number(season) || 1}:${Number(episode) || 1}`;
}

function get(roomCode, episode, season) {
  const key = buildKey(roomCode, episode, season);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function set(roomCode, episode, data, season) {
  // не кэшируем пустые/неуспешные ответы
  if (!data || !data.success) return;
  if ((!data.streams || data.streams.length === 0) && (!data.playerIframes || data.playerIframes.length === 0)) {
    return;
  }
  const key = buildKey(roomCode, episode, season);
  cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

function clearRoom(roomCode) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${roomCode}:`)) {
      cache.delete(key);
    }
  }
}

// просроченные записи удаляем раз в 10 минут, а не только при чтении — иначе брошенные комнаты копятся в памяти
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { get, set, clearRoom };
