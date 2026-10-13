// Роли: user (по умолчанию), friend (друг администратора), admin. friend и admin могут то, что закрыто для
// остальных из-за юридического риска: комнаты «Просмотр фильма / сериала» (player_capture) и комнаты 18+ —
// и создавать, и смотреть (вход в такую комнату, relay видео). Остальным эти функции не показываются,
// а по ссылке — окно «нет доступа».
// Роль friend ставится только в базе: db.users.updateOne({ usernameLower: 'логин' }, { $set: { role: 'friend' } })
// Роль берём из базы (в токене — старая до следующего входа), держим в памяти минуту: relay спрашивает на каждый сегмент
const User = require('../models/User');

const TRUSTED = ['admin', 'friend'];
const TTL_MS = 60 * 1000;
const cache = new Map(); // userId → { ok, at }

async function isTrusted(userId) {
  if (!userId) return false;
  const id = String(userId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  const u = await User.findById(id).select('role').lean();
  const ok = !!u && TRUSTED.includes(u.role);
  if (cache.size > 5000) cache.clear();
  cache.set(id, { ok, at: Date.now() });
  return ok;
}

// комната с ограниченным видео: «Просмотр фильма» или 18+
// ... или YouTube 18+, скачанный на сервер (yt-dlp)
const isRestrictedVideo = (video) => !!video && (video.type === 'player_capture' || !!video.adult || (video.type === 'youtube' && !!video.ageRestricted));

// в комнате стало ограниченное видео: зрители без доступа получают «нет доступа» и выходят из неё
async function dropUntrusted(io, code) {
  const ids = [...(io.sockets.adapter.rooms.get(code) || [])];
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (!s || !s.user || (await isTrusted(s.user.id))) continue;
    s.emit('room:denied');
    s.leave(code);
  }
}

module.exports = { TRUSTED, isTrusted, isRestrictedVideo, dropUntrusted };
