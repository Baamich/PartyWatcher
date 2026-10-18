// Уведомления на сайте (колокольчик в шапке — public/js/notify-bell.js).
// Личные — models/Notification (одна запись на событие, тексты собирает клиент по type из common.notify.type.*).
// Новости сайта — НЕ рассылаются по записям: одна новость на всех, список берётся из News на лету (кэш в памяти).
// Прочитано / нет — одна метка User.notifSeenAt: открыл колокольчик → всё, что раньше, прочитано.
// Разделы можно выключить в профиле (User.notifyOff); безопасность и системные — нельзя.
// send() никогда не бросает: уведомление не должно ломать само действие
const Notification = require('../models/Notification');
const User = require('../models/User');

// type → раздел настроек. Новые типы — сюда + тексты common.notify.type.<type> в ru и en
const TYPES = {
  'system.welcome': 'system',
  'support.reply': 'support',
  'support.accepted': 'support',
  'support.trivial': 'support',
  'support.report': 'support',
  'security.login': 'security',
  'security.password': 'security',
  'security.passwordReset': 'security',
  'security.emailRequest': 'security',
  'security.email': 'security',
  'security.emailByAdmin': 'security',
  'security.username': 'security',
  'security.mainDevice': 'security',
  'security.deleteCancel': 'security',
  'room.expiring': 'rooms',
  'room.expired': 'rooms',
  'channel.follow': 'channel',
  'channel.clip': 'channel',
  'chat.mod': 'chat',
  'chat.unmod': 'chat',
  'chat.ban': 'chat',
  'chat.unban': 'chat',
  'preset.removed': 'presets',
  'preset.add': 'presets',
  'preset.like': 'presets',
};
// разделы в профиле (по порядку); locked — всегда включены
const CATS = ['news', 'support', 'security', 'rooms', 'channel', 'chat', 'presets'];
const LOCKED = new Set(['security', 'system']);
const GROUP_MS = 12 * 3600 * 1000; // «ник и ещё N» копится, пока не прочитано, но не дольше 12 часов
const PAGE_MAX = 20;
const NEWS_DAYS = 60; // новости сайта в колокольчике — за последние 60 дней
const MAX_UNREAD = 99;

const catOf = (type) => TYPES[type] || null;
const isOff = (user, cat) => !LOCKED.has(cat) && Array.isArray(user?.notifyOff) && user.notifyOff.includes(cat);
const seenOf = (user) => new Date(user?.notifSeenAt || user?.createdAt || 0);

// подстановки — только короткие строки и числа (в базу не попадёт ничего лишнего)
function cleanVars(vars) {
  if (!vars) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v == null || v === '') continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

// send(userId, 'support.reply', { topic }, { link, group })
// group — копить одинаковые в одну запись (vars.name — кто последний; тот же человек подряд не считается дважды)
async function send(userId, type, vars, opts = {}) {
  try {
    const cat = catOf(type);
    if (!userId || !cat) return null;
    const user = await User.findById(userId).select('notifSeenAt notifyOff createdAt').lean();
    if (!user || isOff(user, cat)) return null;
    const v = cleanVars(vars);
    const now = new Date();
    if (opts.group) {
      const since = new Date(Math.max(seenOf(user).getTime(), now.getTime() - GROUP_MS));
      const prev = await Notification.findOne({ userId: user._id, group: opts.group, at: { $gt: since } }).sort({ at: -1 }).lean();
      if (prev) {
        if (prev.vars?.name && prev.vars.name === v?.name) return prev;
        await Notification.updateOne({ _id: prev._id }, { $inc: { count: 1 }, $set: { at: now, vars: v } });
        return prev;
      }
    }
    return await Notification.create({
      userId: user._id, type, vars: v, at: now,
      ...(opts.link ? { link: String(opts.link).slice(0, 300) } : {}),
      ...(opts.group ? { group: String(opts.group).slice(0, 120), count: 1 } : {}),
    });
  } catch (e) {
    console.error('[notify]', type, e.message);
    return null;
  }
}

// ---------- новости сайта: одна на всех, из базы раз в 5 минут (или сразу после публикации — newsChanged) ----------
let newsCache = null;
let newsAt = 0;
let newsLoading = null;
const NEWS_TTL = 5 * 60 * 1000;

async function recentNews() {
  if (newsCache && Date.now() - newsAt < NEWS_TTL) return newsCache;
  if (!newsLoading) {
    const News = require('../models/News');
    newsLoading = News.find({ publishedAt: { $gt: new Date(Date.now() - NEWS_DAYS * 86400000) } })
      .sort({ publishedAt: -1 }).limit(50)
      .select('title lang tr trStamp editedAt publishedAt important').lean()
      .then((rows) => {
        newsCache = rows.map((n) => {
          const stamp = new Date(n.editedAt || n.publishedAt).getTime();
          const tr = {};
          if (n.trStamp === stamp && n.tr) for (const [l, x] of Object.entries(n.tr)) if (x?.title) tr[l] = String(x.title).slice(0, 200);
          return { id: String(n._id), at: new Date(n.publishedAt), important: !!n.important, title: n.title, lang: n.lang || null, tr };
        });
        newsAt = Date.now();
        return newsCache;
      })
      .finally(() => { newsLoading = null; });
  }
  return newsLoading;
}
function newsChanged() {
  newsAt = 0;
}
// новости, которые человек может увидеть: не старше аккаунта и не выключены
async function newsFor(user) {
  if (isOff(user, 'news')) return [];
  const born = new Date(user.createdAt || 0).getTime() - 7 * 86400000; // новичку — и пару свежих новостей до регистрации
  return (await recentNews()).filter((n) => n.at.getTime() > born);
}
function newsItem(n, lang) {
  const title = n.lang && n.lang !== lang && n.tr[lang] ? n.tr[lang] : n.title;
  return { id: 'news:' + n.id, type: n.important ? 'news.important' : 'news', vars: { title }, link: '/news#n-' + n.id, at: n.at };
}

// ---------- счётчик и список ----------
const USER_FIELDS = 'notifSeenAt notifyOff createdAt';

async function unreadOf(userOrId) {
  const user = userOrId && typeof userOrId === 'object' && 'createdAt' in userOrId ? userOrId
    : await User.findById(userOrId).select(USER_FIELDS).lean();
  if (!user) return 0;
  const since = seenOf(user);
  const [personal, news] = await Promise.all([
    Notification.countDocuments({ userId: user._id, at: { $gt: since } }, { limit: MAX_UNREAD }),
    newsFor(user).then((list) => list.filter((n) => n.at > since).length),
  ]);
  return Math.min(MAX_UNREAD, personal + news);
}

// страница списка: свежие сверху, before — время последнего показанного (мс). Первая страница с open
// помечает всё прочитанным; seenAt — прежняя метка (клиент выделяет то, что новее неё)
async function list(userId, { before, limit = 10, open = false, lang = 'ru' } = {}) {
  const user = await User.findById(userId).select(USER_FIELDS).lean();
  if (!user) return null;
  const n = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 10));
  const b = Number(before) > 0 ? new Date(Number(before)) : null;
  const q = { userId: user._id, ...(b ? { at: { $lt: b } } : {}) };
  const [rows, news] = await Promise.all([
    Notification.find(q).sort({ at: -1 }).limit(n).lean(),
    newsFor(user),
  ]);
  const items = rows.map((r) => ({
    id: String(r._id), type: r.type, vars: r.vars || {}, link: r.link || null, at: r.at,
    ...(r.count > 1 ? { count: r.count } : {}),
  }));
  for (const x of news) if (!b || x.at < b) items.push(newsItem(x, lang));
  items.sort((a, c) => new Date(c.at) - new Date(a.at));
  const page = items.slice(0, n);
  const seenAt = seenOf(user);
  if (open && !b) await User.updateOne({ _id: user._id }, { $set: { notifSeenAt: new Date() } });
  return {
    items: page,
    seenAt,
    // есть ли дальше: страница полная (ещё что-то может быть) — клиент спросит before = время последнего
    more: page.length === n,
  };
}

// ---------- настройки ----------
async function settingsOf(userId) {
  const u = await User.findById(userId).select('notifyOff supportByEmail').lean();
  if (!u) return null;
  return {
    cats: CATS.map((c) => ({ id: c, on: !isOff(u, c), locked: LOCKED.has(c) })),
    supportByEmail: !!u.supportByEmail,
  };
}
async function saveSettings(userId, { off, supportByEmail } = {}) {
  const set = {};
  if (Array.isArray(off)) set.notifyOff = [...new Set(off.map(String))].filter((c) => CATS.includes(c) && !LOCKED.has(c));
  if (typeof supportByEmail === 'boolean') set.supportByEmail = supportByEmail;
  if (Object.keys(set).length) await User.updateOne({ _id: userId }, { $set: set });
  return settingsOf(userId);
}

// ---------- готовые поводы (чтобы роуты не собирали vars сами) ----------
const { maskEmail } = require('./mailer');
const countryOf = (req) => String(req?.headers?.['cf-ipcountry'] || '').slice(0, 2).toUpperCase().replace(/^(XX|T1)$/, '');
const profileLink = (username, tab) => (username ? '/u/' + encodeURIComponent(String(username).toLowerCase()) + '#' + tab : null);

// вход с паролем с нового устройства (браузер, где этот аккаунт ещё не был): устройство и страна, без IP
async function login(req, user) {
  try {
    const { parseUA, deviceIds } = require('./clientInfo');
    const { did } = deviceIds(req);
    if (did) {
      const UserSeen = require('../models/UserSeen');
      if (await UserSeen.exists({ userId: user._id, did })) return;
    }
    await send(user._id, 'security.login', { device: parseUA(req.headers || {}).name || '', country: countryOf(req) },
      { link: profileLink(user.username, 'devices') });
  } catch (e) {
    console.error('[notify] login', e.message);
  }
}

// события истории аккаунта (services/accountLog.record) → уведомление владельцу
async function accountEvent(userId, type, data = {}) {
  const u = await User.findById(userId).select('username').lean().catch(() => null);
  const sec = (link) => profileLink(u?.username, link);
  switch (type) {
    case 'password':
      return send(userId, data.to === 'reset' ? 'security.passwordReset' : 'security.password', {}, { link: sec('devices') });
    case 'email':
      return send(userId, data.by ? 'security.emailByAdmin' : 'security.email', { from: maskEmail(data.from), to: maskEmail(data.to) }, { link: sec('general') });
    case 'username':
      return send(userId, 'security.username', { from: data.from, to: data.to }, { link: sec('general') });
    case 'mainDevice':
      return send(userId, 'security.mainDevice', { device: data.to }, { link: sec('devices') });
    case 'deleteCancel':
      return send(userId, 'security.deleteCancel', {}, { link: sec('security') });
    default:
      return null;
  }
}

module.exports = {
  TYPES, CATS, LOCKED,
  send, unreadOf, list, settingsOf, saveSettings, newsChanged,
  login, accountEvent, maskEmail, profileLink,
};
