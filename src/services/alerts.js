// alerts.js — события канала для оверлея OBS (/overlay/alerts.html) и ботов (сокет /alerts по ключу).
// fire() — главное: всем, кто подключён по ключу канала, уходит 'event' (сырое, для ботов — всегда)
// и 'alert' (для оверлея — только если событие включено в студии). Пороги (рубежи, разогрев чата, комбо) — здесь же
const crypto = require('crypto');
const C = require('../public/alerts/catalog');
const AlertSettings = require('../models/AlertSettings');
const ChannelSeen = require('../models/ChannelSeen');

let nsp = null;
const room = (nameLower) => 'alerts:' + nameLower;
function init(namespace) {
  nsp = namespace;
}

// ---------- настройки канала (кэш 30 с) ----------
const cache = new Map(); // nameLower → { at, doc }
const TTL = 30 * 1000;

async function settings(nameLower) {
  const hit = cache.get(nameLower);
  if (hit && Date.now() - hit.at < TTL) return hit.doc;
  const doc = await AlertSettings.findOne({ streamerNameLower: nameLower }).select('events followGoalMax').lean();
  if (cache.size > 2000) cache.clear();
  cache.set(nameLower, { at: Date.now(), doc });
  return doc;
}
const invalidate = (nameLower) => cache.delete(nameLower);

// настройки события с умолчаниями из каталога (у канала без настроек — как в каталоге)
function eventCfg(doc, id) {
  return C.cleanEvent(id, doc?.events?.[id]);
}

async function enabled(nameLower, id) {
  const cfg = eventCfg(await settings(nameLower).catch(() => null), id);
  return !!cfg?.on;
}

// главное: событие канала
async function fire(nameLower, id, vars = {}, opts = {}) {
  if (!nsp || !nameLower || !C.eventById(id)) return;
  const at = new Date().toISOString();
  if (!opts.test) nsp.to(room(nameLower)).emit('event', { type: id, vars, at });
  const doc = await settings(nameLower).catch(() => null);
  const cfg = eventCfg(doc, id);
  if (!cfg || (!cfg.on && !opts.test)) return;
  nsp.to(room(nameLower)).emit('alert', {
    id: crypto.randomBytes(6).toString('hex'),
    event: id,
    vars,
    cfg,
    text: cfg.text, // пусто — оверлей берёт надпись по умолчанию на своём языке
    emoteId: opts.emoteId || null,
    test: !!opts.test,
  });
}

// ---------- пороги и счётчики ----------
const VIEWER_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const FOLLOW_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

// зрители: рубеж — один раз за эфир (сброс в конце эфира, переподключение OBS не сбрасывает)
const viewerMax = new Map();
function resetStream(nameLower) {
  viewerMax.delete(nameLower);
}
function viewers(nameLower, count) {
  const step = [...VIEWER_STEPS].reverse().find((s) => count >= s);
  if (!step || step <= (viewerMax.get(nameLower) || 0)) return;
  viewerMax.set(nameLower, step);
  fire(nameLower, 'viewers', { count: step }).catch(() => {});
}

// подписчики: рубеж — один раз навсегда (отписки и повторные подписки не повторяют алерт)
async function followers(nameLower, userId, count) {
  const step = [...FOLLOW_STEPS].reverse().find((s) => count >= s);
  if (!step) return;
  const r = await AlertSettings.updateOne(
    { userId, followGoalMax: { $lt: step } },
    { $set: { followGoalMax: step }, $setOnInsert: { streamerNameLower: nameLower } }
  ).catch(() => null);
  if (r?.modifiedCount) fire(nameLower, 'followGoal', { count: step }).catch(() => {});
  else if (!r?.matchedCount) {
    // настроек ещё нет — создаём с рубежом
    try {
      await AlertSettings.create({ userId, streamerNameLower: nameLower, followGoalMax: step });
      fire(nameLower, 'followGoal', { count: step }).catch(() => {});
    } catch (_) {}
  }
}

// первый раз в чате этого канала: память процесса + одна запись в базе на человека
const seenMem = new Map(); // nameLower → Set(userId)
async function chatMessage(nameLower, userId, username, text) {
  let set = seenMem.get(nameLower);
  if (!set) { set = new Set(); seenMem.set(nameLower, set); }
  if (set.has(userId)) return;
  if (set.size > 5000) set.clear();
  set.add(userId);
  if (seenMem.size > 2000) seenMem.clear();
  try {
    const r = await ChannelSeen.updateOne({ streamerNameLower: nameLower, userId }, { $setOnInsert: { streamerNameLower: nameLower } }, { upsert: true });
    if (r.upsertedCount) fire(nameLower, 'firstChat', { name: username, message: String(text).slice(0, 100) }).catch(() => {});
  } catch (_) {}
}

// разогрев чата: N сообщений за минуту (N — порог события), не чаще раза в 10 минут
const hypeLog = new Map(); // nameLower → { times: [], last }
async function chatHype(nameLower) {
  let h = hypeLog.get(nameLower);
  if (!h) { h = { times: [], last: 0 }; hypeLog.set(nameLower, h); }
  const now = Date.now();
  h.times.push(now);
  while (h.times.length && now - h.times[0] > 60000) h.times.shift();
  if (h.times.length > 2000) h.times.splice(0, h.times.length - 2000);
  if (now - h.last < 10 * 60000) return;
  const cfg = eventCfg(await settings(nameLower).catch(() => null), 'hype');
  if (!cfg || h.times.length < cfg.param) return;
  h.last = now;
  fire(nameLower, 'hype', { count: h.times.length }).catch(() => {});
}

// комбо смайлов: один смайл подряд от N разных людей (в пределах 30 с между сообщениями), не чаще раза в 2 минуты
const combos = new Map(); // nameLower → { code, id, users: Set, at, fired, last }
async function emotes(nameLower, userId, used) {
  if (!used) return;
  const codes = Object.keys(used);
  if (!codes.length) return;
  const now = Date.now();
  let c = combos.get(nameLower);
  if (!c || now - c.at > 30000 || !used[c.code]) {
    c = { code: codes[0], id: used[codes[0]], users: new Set(), at: now, fired: false, last: c?.last || 0 };
    combos.set(nameLower, c);
  }
  c.users.add(String(userId));
  c.at = now;
  if (combos.size > 2000) combos.clear();
  if (c.fired || now - c.last < 2 * 60000) return;
  const cfg = eventCfg(await settings(nameLower).catch(() => null), 'emoteCombo');
  if (!cfg || c.users.size < cfg.param) return;
  c.fired = true;
  c.last = now;
  fire(nameLower, 'emoteCombo', { emote: c.code, count: c.users.size }, { emoteId: c.id }).catch(() => {});
}

// чистка памяти раз в 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hypeLog) if (!h.times.length || now - h.times[h.times.length - 1] > 10 * 60000) hypeLog.delete(k);
  for (const [k, c] of combos) if (now - c.at > 10 * 60000) combos.delete(k);
}, 10 * 60000).unref();

module.exports = { init, room, fire, settings, invalidate, eventCfg, enabled, resetStream, viewers, followers, chatMessage, chatHype, emotes };
