// emotes.js — смайлы в чате эфира: :code: → картинка. Списки смайлов (канала и публичные) и
// «подписан ли» держим в памяти на минуту: чат спрашивает на каждое сообщение
const Emote = require('../models/Emote');
const Follow = require('../models/Follow');

const CODE_RE = /^[A-Za-z0-9_]{2,20}$/;
const MAX_PER_CHANNEL = 30;
const MAX_PUBLIC = 3;
const MAX_BYTES = 256 * 1024;
const TTL = 60 * 1000;

const channelCache = new Map(); // nameLower → { at, map: Map<codeLower, {id, code}> }
let publicCache = { at: 0, map: new Map() };
const followCache = new Map(); // `${streamerId}:${userId}` → { at, ok }

async function channelMap(nameLower) {
  const hit = channelCache.get(nameLower);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const rows = await Emote.find({ streamerNameLower: nameLower }).select('code codeLower').lean();
  const map = new Map(rows.map((r) => [r.codeLower, { id: String(r._id), code: r.code }]));
  if (channelCache.size > 2000) channelCache.clear();
  channelCache.set(nameLower, { at: Date.now(), map });
  return map;
}

async function publicMap() {
  if (Date.now() - publicCache.at < TTL) return publicCache.map;
  const rows = await Emote.find({ isPublic: true }).select('code codeLower').sort({ createdAt: -1 }).limit(2000).lean();
  publicCache = { at: Date.now(), map: new Map(rows.map((r) => [r.codeLower, { id: String(r._id), code: r.code }])) };
  return publicCache.map;
}

// подписался/отписался — смайлы канала доступны (или нет) сразу, без минуты кэша
function forgetFollow(streamerId, userId) {
  followCache.delete(String(streamerId) + ':' + String(userId));
}

function invalidate(nameLower) {
  channelCache.delete(nameLower);
  publicCache.at = 0;
}

async function isFollower(streamerId, userId) {
  if (!streamerId || !userId) return false;
  const k = streamerId + ':' + userId;
  const hit = followCache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  const ok = !!(await Follow.exists({ followerId: userId, streamerId }));
  if (followCache.size > 20000) followCache.clear();
  followCache.set(k, { at: Date.now(), ok });
  return ok;
}

// :code: в тексте → { code: id } только для смайлов, которыми этот человек может пользоваться в этом чате.
// canChannel — стример, модератор или подписчик канала
async function resolve(text, nameLower, canChannel) {
  const codes = new Set();
  for (const m of String(text).matchAll(/:([A-Za-z0-9_]{2,20}):/g)) codes.add(m[1]);
  if (!codes.size) return null;
  const [ch, pub] = await Promise.all([canChannel ? channelMap(nameLower) : null, publicMap()]);
  const out = {};
  for (const code of codes) {
    const lc = code.toLowerCase();
    const e = (ch && ch.get(lc)) || pub.get(lc); // свой смайл канала важнее публичного с тем же кодом
    if (e) out[code] = e.id;
  }
  return Object.keys(out).length ? out : null;
}

// картинка смайла из data:URL: png/webp/jpeg или gif (анимация); проверка размера
function parseImage(dataUrl) {
  const m = /^data:(image\/(?:png|webp|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return { tooBig: true };
  return { mime: m[1], data: buf, animated: m[1] === 'image/gif' };
}

module.exports = {
  CODE_RE, MAX_PER_CHANNEL, MAX_PUBLIC, MAX_BYTES,
  channelMap, publicMap, invalidate, isFollower, forgetFollow, resolve, parseImage,
};
