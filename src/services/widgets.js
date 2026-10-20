// widgets.js — виджеты канала для OBS (студия → ⏱️ Виджеты, оверлей /overlay/widget.html, мини-пульт).
// Источник правды — память процесса (instances: 1): действия (старт таймера, +1 к счётчику) применяются сразу
// и рассылаются по сокету /alerts в комнату widgets:<канал>, в базу — одной записью с задержкой.
// Таймеры не тикают на сервере: оверлей считает сам по отметкам времени (end/start) с поправкой на часы.
// Числа (зрители, подписчики) и события рассылаются, только если кто-то из виджетов канала подключён
const crypto = require('crypto');
const C = require('../public/widgets/catalog');
const ChannelWidgets = require('../models/ChannelWidgets');
const User = require('../models/User');
const Follow = require('../models/Follow');
const chatBus = require('./chatBus');
const categories = require('./categories');
const i18n = require('./i18n');

let nsp = null;
const room = (nameLower) => 'widgets:' + nameLower;
function init(namespace) {
  nsp = namespace;
}
const listeners = (nameLower) => nsp?.adapter.rooms.get(room(nameLower))?.size || 0;

// ---------- память: канал → { userId, nameLower, widgets, layout, at, saveTimer, stats, live, statsAt } ----------
const cache = new Map();
const loading = new Map(); // канал → Promise (два входа разом не заводят две записи)
const SAVE_MS = 1000;
const IDLE_MS = 10 * 60 * 1000;
const STATS_MS = 15 * 1000;

async function load(nameLower) {
  if (!nameLower) return null;
  const hit = cache.get(nameLower);
  if (hit) { hit.at = Date.now(); return hit; }
  if (loading.has(nameLower)) return loading.get(nameLower);
  const p = (async () => {
    const doc = await ChannelWidgets.findOne({ streamerNameLower: nameLower }).lean();
    let userId = doc?.userId;
    if (!userId) {
      const u = await User.findOne({ streamerNameLower: nameLower }).select('_id').lean();
      if (!u) return null;
      userId = u._id;
    }
    const widgets = (Array.isArray(doc?.widgets) ? doc.widgets : []).map((w) => C.cleanWidget(w)).filter(Boolean).slice(0, C.MAX_WIDGETS);
    const last = doc?.last && typeof doc.last === 'object' ? doc.last : {};
    const e = { userId: String(userId), nameLower, widgets, last, layout: doc?.layout || null, at: Date.now(), saveTimer: null, stats: null, live: null, statsAt: 0 };
    cache.set(nameLower, e);
    return e;
  })().finally(() => loading.delete(nameLower));
  loading.set(nameLower, p);
  return p;
}

function save(e) {
  clearTimeout(e.saveTimer);
  e.saveTimer = setTimeout(() => {
    e.saveTimer = null;
    ChannelWidgets.updateOne(
      { userId: e.userId },
      { $set: { widgets: e.widgets, last: e.last, streamerNameLower: e.nameLower } },
      { upsert: true }
    ).catch((err) => console.warn('[widgets] save', err.message));
  }, SAVE_MS);
}

// незанятые каналы — из памяти (несохранённые и с подключёнными оверлеями остаются)
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) {
    if (!e.saveTimer && now - e.at > IDLE_MS && !listeners(k)) cache.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ---------- числа канала: эфир, зрители, подписчики, название и категория ----------
async function refreshStats(e, force = false) {
  if (!force && e.stats && Date.now() - e.statsAt < STATS_MS) return e.stats;
  const u = await User.findById(e.userId).select('streamerName isLive liveStartedAt followersCount streamTitle streamCategoryId').lean();
  const startedAt = u?.isLive && u.liveStartedAt ? new Date(u.liveStartedAt) : null;
  const followersStream = startedAt ? await Follow.countDocuments({ streamerId: e.userId, createdAt: { $gte: startedAt } }).catch(() => 0) : 0;
  const cat = u?.streamCategoryId ? await categories.viewByTid(u.streamCategoryId).catch(() => null) : null;
  e.live = { isLive: !!u?.isLive, startedAt: startedAt ? startedAt.getTime() : 0 };
  e.stats = {
    viewers: chatBus.viewerCount(e.nameLower, e.userId),
    followers: u?.followersCount || 0,
    followersStream,
    title: u?.streamTitle || '',
    category: cat ? { name: cat.name, ru: cat.ru || '' } : null,
    name: u?.streamerName || e.nameLower,
  };
  e.statsAt = Date.now();
  return e.stats;
}

const snapshot = (e) => ({ now: Date.now(), widgets: e.widgets, live: e.live, stats: e.stats, last: e.last });

function emit(e, event, payload) {
  if (nsp && listeners(e.nameLower)) nsp.to(room(e.nameLower)).emit(event, { now: Date.now(), ...payload });
}
const emitWidget = (e, w) => emit(e, 'widget:update', { widget: w });

// вход оверлея/студии/мини-пульта (sockets/alertsSocket): только что проверенный ключ → снимок всего канала
async function join(socket, nameLower) {
  const e = await load(nameLower);
  if (!e) return null;
  await refreshStats(e).catch(() => null);
  socket.join(room(nameLower));
  return snapshot(e);
}

// ---------- студия ----------
const byId = (e, id) => e.widgets.find((w) => w.id === String(id)) || null;

async function forMe(me) {
  const e = await load(me.streamerNameLower);
  if (!e) throw i18n.err('server.presets.noStreamer');
  await refreshStats(e).catch(() => null);
  return e;
}

// свободное имя для команды чата: timer, timer2, timer3…
function freeSlug(e, base, skipId) {
  const used = new Set(e.widgets.filter((w) => w.id !== skipId).map((w) => w.slug));
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!used.has(base + i)) return base + i;
  return base + crypto.randomBytes(2).toString('hex');
}

async function create(me, type) {
  const t = C.typeById(type);
  if (!t) throw i18n.err('server.widgets.badType');
  const e = await forMe(me);
  if (e.widgets.length >= C.MAX_WIDGETS) throw i18n.err('server.widgets.limit', { n: C.MAX_WIDGETS });
  const w = C.cleanWidget({ id: crypto.randomBytes(5).toString('hex'), type, slug: freeSlug(e, type === 'custom' ? 'widget' : t.cmd || type) });
  if (type === 'countdown') w.state = C.cleanState(type, { left: w.opts.sec * 1000, total: w.opts.sec * 1000 });
  e.widgets.push(w);
  save(e);
  emitWidget(e, w);
  return w;
}

// виджет из пре-сета (data — уже проверенный cleanPresetData): новый id, свободное имя для команд
async function createFrom(me, data) {
  const e = await forMe(me);
  if (e.widgets.length >= C.MAX_WIDGETS) throw i18n.err('server.widgets.limit', { n: C.MAX_WIDGETS });
  const t = C.typeById(data?.type);
  if (!t) throw i18n.err('server.widgets.badType');
  const base = C.SLUG_RE.test(data.slug || '') ? data.slug : data.type === 'custom' ? 'widget' : t.cmd || data.type;
  const w = C.cleanWidget({ ...data, id: crypto.randomBytes(5).toString('hex'), slug: freeSlug(e, base) });
  if (w.type === 'countdown') w.state = C.cleanState('countdown', { left: w.opts.sec * 1000, total: w.opts.sec * 1000 });
  e.widgets.push(w);
  save(e);
  emitWidget(e, w);
  return w;
}

// что из виджета уходит в пре-сет: тип, имя, стиль, настройки; из состояния — только текст надписи / бегущей строки
function presetData(w) {
  const keep = w.type === 'text' || w.type === 'ticker' || w.type === 'custom' ? { text: w.state?.text || '' } : {};
  const c = C.cleanWidget({ type: w.type, name: w.name, slug: w.slug, style: w.style, opts: w.opts, state: keep });
  if (!c) return null;
  delete c.id;
  return c;
}

async function update(me, id, body) {
  const e = await forMe(me);
  const w = byId(e, id);
  if (!w) throw i18n.err('server.widgets.notFound');
  const b = body && typeof body === 'object' ? body : {};
  const slug = String(b.slug ?? w.slug).toLowerCase().trim();
  if (!C.SLUG_RE.test(slug)) throw i18n.err('server.widgets.badSlug');
  if (e.widgets.some((x) => x.id !== w.id && x.slug === slug)) throw i18n.err('server.widgets.slugTaken', { slug });
  const next = C.cleanWidget({ ...w, name: b.name ?? w.name, slug, style: b.style ?? w.style, opts: b.opts ?? w.opts, state: w.state });
  // отсчёт стоит на старте и поменяли длительность — встаёт на новую
  if (w.type === 'countdown' && !w.state.run && next.opts.sec !== w.opts.sec && (!w.state.left || w.state.left === w.state.total)) {
    next.state = C.cleanState('countdown', { left: next.opts.sec * 1000, total: next.opts.sec * 1000 });
  }
  Object.assign(w, next);
  save(e);
  emitWidget(e, w);
  return w;
}

async function remove(me, id) {
  const e = await forMe(me);
  const i = e.widgets.findIndex((w) => w.id === String(id));
  if (i < 0) return false;
  e.widgets.splice(i, 1);
  save(e);
  emit(e, 'widget:remove', { id: String(id) });
  return true;
}

async function setLayout(me, layout) {
  const e = await forMe(me);
  e.layout = layout;
  await ChannelWidgets.updateOne({ userId: e.userId }, { $set: { layout, streamerNameLower: e.nameLower } }, { upsert: true });
}

// ---------- действия: студия, мини-пульт и команды чата ----------
// arg — секунды (таймеры), число (счётчики), текст (надписи). Возвращает виджет; ошибка — i18n.err
const ACTIONS = {
  countdown: ['start', 'pause', 'toggle', 'reset', 'add', 'set'],
  stopwatch: ['start', 'pause', 'toggle', 'reset'],
  counter: ['add', 'set', 'reset'],
  goal: ['add', 'set', 'reset'],
  text: ['set'],
  ticker: ['set'],
  credits: ['run', 'stop'],
  last: ['clear'],
  custom: ['add', 'set', 'reset', 'text', 'roll'],
};
const DAY_MS = 86400 * 1000;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function apply(w, action, arg, now) {
  const s = w.state;
  const sec = Number(arg);
  switch (w.type) {
    case 'countdown': {
      const pause = () => { if (s.run) { s.left = Math.max(0, s.end - now); s.run = false; s.end = 0; } };
      const start = () => {
        if (s.run) return;
        if (s.left <= 0) s.left = s.total || w.opts.sec * 1000;
        s.run = true;
        s.end = now + s.left;
      };
      if (action === 'start' && Number.isFinite(sec) && sec > 0) {
        s.total = s.left = clamp(Math.round(sec * 1000), 1000, DAY_MS);
        s.run = false;
        start();
      } else if (action === 'start') start();
      else if (action === 'pause') pause();
      else if (action === 'toggle') (s.run ? pause : start)();
      else if (action === 'reset') { s.run = false; s.end = 0; s.left = s.total = s.total || w.opts.sec * 1000; }
      else if (action === 'set') {
        if (!Number.isFinite(sec) || sec <= 0) throw i18n.err('server.widgets.badValue');
        s.run = false; s.end = 0; s.left = s.total = clamp(Math.round(sec * 1000), 1000, DAY_MS);
      } else if (action === 'add') {
        if (!Number.isFinite(sec) || !sec) throw i18n.err('server.widgets.badValue');
        if (s.run) s.end = clamp(s.end + sec * 1000, now, now + DAY_MS);
        else s.left = clamp(s.left + sec * 1000, 0, DAY_MS);
        s.total = Math.max(s.total, s.run ? s.end - now : s.left);
      }
      return;
    }
    case 'stopwatch': {
      const pause = () => { if (s.run) { s.acc = Math.max(0, now - s.start); s.run = false; s.start = 0; } };
      const start = () => { if (!s.run) { s.start = now - (s.acc || 0); s.run = true; } };
      if (action === 'start') start();
      else if (action === 'pause') pause();
      else if (action === 'toggle') (s.run ? pause : start)();
      else if (action === 'reset') { s.run = false; s.start = 0; s.acc = 0; }
      return;
    }
    case 'counter':
    case 'goal': {
      if (w.type === 'goal' && w.opts.source !== 'manual') throw i18n.err('server.widgets.goalAuto');
      const n = Number(arg);
      if (action === 'reset') s.n = 0;
      else if (!Number.isFinite(n)) throw i18n.err('server.widgets.badValue');
      else s.n = Math.round(action === 'add' ? s.n + n : n);
      const min = w.type === 'counter' && w.opts.negative ? -1e9 : 0;
      s.n = clamp(s.n, min, 1e9);
      return;
    }
    case 'text':
    case 'ticker':
      w.state = C.cleanState(w.type, { text: String(arg ?? '') });
      return;
    case 'credits':
      if (action === 'run') s.runAt = now;
      else s.stopAt = now;
      return;
    case 'custom': {
      if (action === 'text') { s.text = String(arg ?? ''); return; }
      if (action === 'roll') { s.rev = ((s.rev || 0) + 1) % 1e9; return; }
      const n = Number(arg);
      if (action === 'reset') s.n = 0;
      else if (!Number.isFinite(n)) throw i18n.err('server.widgets.badValue');
      else s.n = clamp(Math.round(action === 'add' ? s.n + n : n), -1e9, 1e9);
      return;
    }
    case 'last':
      s.items = [];
  }
}

async function act(nameLower, id, action, arg) {
  const e = await load(nameLower);
  const w = e && byId(e, id);
  if (!w) throw i18n.err('server.widgets.notFound');
  if (!(ACTIONS[w.type] || []).includes(action)) throw i18n.err('server.widgets.badAction');
  apply(w, action, arg, Date.now());
  w.state = C.cleanState(w.type, w.state);
  save(e);
  emitWidget(e, w);
  return w;
}

// действие награды за поинты: виджет по имени для команд, op — add|set|start|text|roll|run (что подходит его типу).
// value — уже подставленный шаблон: число, время («90», «1m») или текст
async function actBySlug(nameLower, slug, op, value) {
  const e = await load(nameLower);
  const w = e?.widgets.find((x) => x.slug === String(slug || '').toLowerCase());
  if (!w) throw i18n.err('server.widgets.notFound');
  const num = Number(String(value ?? '').trim());
  const span = () => {
    const v = String(value ?? '').trim().replace(/^\+/, '');
    const neg = v.startsWith('-');
    const sec = /^\d{1,6}$/.test(v.replace(/^-/, '')) ? Number(v.replace(/^-/, '')) : C.parseSpan(v.replace(/^-/, ''));
    return sec ? (neg ? -sec : sec) : null;
  };
  let action = null;
  let arg;
  switch (w.type) {
    case 'countdown':
      if (op === 'add') { action = 'add'; arg = span(); }
      else if (op === 'set') { action = 'set'; arg = span(); }
      else if (op === 'start' || op === 'run') { action = 'start'; arg = String(value ?? '').trim() ? span() : undefined; }
      break;
    case 'stopwatch':
      if (op === 'start' || op === 'run') action = 'start';
      break;
    case 'counter':
    case 'goal':
      if (op === 'add' || op === 'set') { action = op; arg = Number.isFinite(num) && String(value ?? '').trim() ? num : op === 'add' ? 1 : null; }
      break;
    case 'text':
    case 'ticker':
      if (op === 'text' || op === 'set') { action = 'set'; arg = value; }
      break;
    case 'custom':
      if (op === 'add' || op === 'set') { action = op; arg = Number.isFinite(num) && String(value ?? '').trim() ? num : op === 'add' ? 1 : null; }
      else if (op === 'text') { action = 'text'; arg = value; }
      else if (op === 'roll') action = 'roll';
      break;
    case 'credits':
      if (op === 'run' || op === 'start') action = 'run';
      break;
  }
  if (!action || arg === null) throw i18n.err('server.widgets.badAction');
  return act(nameLower, w.id, action, arg);
}

// для команды чата: виджет типа type по имени (slug) или первый такого типа
async function findForCommand(nameLower, type, slug) {
  const e = await load(nameLower);
  if (!e) return null;
  const own = e.widgets.filter((w) => w.type === type);
  if (slug) {
    const s = String(slug).toLowerCase();
    const hit = own.find((w) => w.slug === s);
    if (hit) return { widget: hit, bySlug: true };
  }
  return own[0] ? { widget: own[0], bySlug: false } : null;
}

// ---------- события канала (хуки из rtmpServer, chatSocket, подписок и алертов) ----------
// эфир начался/закончился: время эфира и подписки за эфир
async function liveChanged(nameLower) {
  const e = cache.get(nameLower);
  if (!e || !listeners(nameLower)) return;
  await refreshStats(e, true).catch(() => null);
  emit(e, 'widget:stats', { live: e.live, stats: e.stats });
}

function followers(nameLower, count, added) {
  const e = cache.get(nameLower);
  if (!e?.stats || !listeners(nameLower)) return;
  e.stats.followers = count;
  if (added && e.live?.isLive) e.stats.followersStream += 1;
  emit(e, 'widget:stats', { stats: e.stats });
}

// зрители: chatSocket уже склеивает входы/выходы (не чаще раза в 1,5 с)
function viewersChanged(nameLower) {
  const e = cache.get(nameLower);
  if (!e?.stats || !listeners(nameLower)) return;
  const n = chatBus.viewerCount(nameLower, e.userId);
  if (n === e.stats.viewers) return;
  e.stats.viewers = n;
  emit(e, 'widget:stats', { stats: e.stats });
}

// поменяли название или категорию эфира
async function streamInfo(nameLower) {
  const e = cache.get(nameLower);
  if (!e || !listeners(nameLower)) return;
  await refreshStats(e, true).catch(() => null);
  emit(e, 'widget:stats', { stats: e.stats });
}

// событие для «Последнего события» (alerts.fire): запоминаем в виджете, он переживёт перезапуск OBS
// и для переменных {last_follower}, {last_reward}… «своего виджета» (последнее событие каждого вида)
async function onEvent(nameLower, evId, vars) {
  if (!C.LAST_EVENTS.includes(evId)) return;
  const e = cache.get(nameLower) || (await load(nameLower).catch(() => null));
  if (!e || !e.widgets.length) return; // виджетов нет — помнить нечего
  const at = Date.now();
  const clean = C.cleanVars(vars);
  e.last = { ...e.last, [evId]: { ...clean, at } };
  save(e);
  emit(e, 'widget:last', { last: e.last });
  for (const w of e.widgets) {
    if (w.type !== 'last' || w.opts.event !== evId) continue;
    w.state.items = [{ vars: clean, at }, ...(w.state.items || [])].slice(0, C.LIMITS.items);
    emitWidget(e, w);
  }
}

// число или текст виджета для команд чата: {widget:имя} (из памяти; канал без виджетов — null)
async function valueOf(nameLower, slug) {
  const e = await load(nameLower).catch(() => null);
  const w = e?.widgets.find((x) => x.slug === String(slug || '').trim().toLowerCase());
  if (!w) return null;
  if (w.type === 'counter' || w.type === 'goal' || w.type === 'custom') return w.type === 'custom' && w.state.text && !w.state.n ? w.state.text : String(w.state.n || 0);
  if (w.type === 'text' || w.type === 'ticker') return w.state.text || '';
  if (w.type === 'countdown') return C.fmtDuration(C.countdownLeft(w.state, Date.now()) + 999);
  if (w.type === 'stopwatch') return C.fmtDuration(C.stopwatchElapsed(w.state, Date.now()));
  return null;
}

// последнее событие канала (для команд и наград): { name, … } или null
async function lastEvent(nameLower, evId) {
  const e = await load(nameLower).catch(() => null);
  return e?.last?.[evId] || null;
}

// ---------- титры: кто был с тобой в эфире (кэш 30 с) ----------
const creditsCache = new Map(); // канал → { at, data }
async function credits(nameLower) {
  const hit = creditsCache.get(nameLower);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  const e = await load(nameLower);
  if (!e) return null;
  await refreshStats(e).catch(() => null);
  const since = new Date(e.live?.startedAt || Date.now() - 12 * 3600 * 1000);
  const StreamChatMessage = require('../models/StreamChatMessage');
  const Redemption = require('../models/Redemption');
  const ChannelMod = require('../models/ChannelMod');
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].slice(0, C.LIMITS.credits);
  const [follows, raids, buys, chat, mods] = await Promise.all([
    Follow.find({ streamerId: e.userId, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(C.LIMITS.credits).select('followerId').lean(),
    StreamChatMessage.find({ streamerNameLower: nameLower, source: 'raid', createdAt: { $gte: since } }).select('senderUsername').limit(50).lean(),
    Redemption.find({ streamerId: e.userId, createdAt: { $gte: since }, test: { $ne: true } }).select('username').limit(500).lean(),
    StreamChatMessage.aggregate([
      { $match: { streamerNameLower: nameLower, createdAt: { $gte: since }, senderId: { $ne: null }, external: { $ne: true } } },
      { $group: { _id: '$senderId', name: { $last: '$senderUsername' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 60 },
    ]),
    ChannelMod.find({ streamerNameLower: nameLower }).select('username').limit(50).lean(),
  ]);
  const users = follows.length ? await User.find({ _id: { $in: follows.map((f) => f.followerId) } }).select('username').lean() : [];
  const nameOf = new Map(users.map((u) => [String(u._id), u.username]));
  const data = {
    followers: uniq(follows.map((f) => nameOf.get(String(f.followerId)))),
    raiders: uniq(raids.map((r) => r.senderUsername)),
    rewards: uniq(buys.map((b) => b.username)),
    chatters: uniq(chat.filter((c) => String(c._id) !== e.userId).map((c) => c.name)),
    mods: uniq(mods.map((m) => m.username)),
  };
  if (creditsCache.size > 500) creditsCache.clear();
  creditsCache.set(nameLower, { at: Date.now(), data });
  return data;
}

module.exports = {
  init, room, load, join, forMe, create, createFrom, presetData, update, remove, setLayout, act, actBySlug, findForCommand, ACTIONS, valueOf, lastEvent,
  liveChanged, followers, viewersChanged, streamInfo, onEvent, credits, snapshot,
};
