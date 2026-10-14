// Баны по IP и устройству: список держим в памяти (проверка — на каждый запрос, без базы), перечитываем из базы
// раз в 30 с — баны из отдельного админ-сервера доходят до сайта за это время (в том же процессе — сразу).
// Бан аккаунта — поля banPerm/banUntil у User: его проверяют вход (auth.routes) и middleware/auth.js
const jwt = require('jsonwebtoken');
const config = require('../config');
const Ban = require('../models/Ban');
const i18n = require('./i18n');
const { isAdminRole } = require('./roles');
const { clientIp, deviceIds } = require('./clientInfo');

let map = new Map(); // `${kind}:${value}` → { until }
let loadedAt = 0;

async function reload() {
  try {
    const rows = await Ban.find({}).select('kind value until').lean();
    const next = new Map();
    for (const b of rows) next.set(b.kind + ':' + b.value, { until: b.until ? new Date(b.until).getTime() : 0 });
    map = next;
    loadedAt = Date.now();
  } catch (e) {
    console.warn('[bans] не загрузились:', e.message);
  }
}

let timer = null;
function start() {
  if (timer) return;
  reload();
  timer = setInterval(reload, 30 * 1000);
  timer.unref();
}

function active(kind, value) {
  if (!value) return false;
  const b = map.get(kind + ':' + value);
  return !!b && (!b.until || b.until > Date.now());
}

// { ip, did, hw } → 'ip' | 'did' | 'hw' | null
function bannedBy({ ip, did, hw }) {
  if (!map.size) return null;
  if (active('ip', ip)) return 'ip';
  if (active('did', did)) return 'did';
  if (active('hw', hw)) return 'hw';
  return null;
}

function infoOf(req) {
  return { ip: clientIp(req), ...deviceIds(req) };
}

// админа не запираем никогда (даже если забанил свой же IP по ошибке)
function isAdminReq(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
  if (!m) return false;
  try {
    return isAdminRole(jwt.verify(decodeURIComponent(m[1]), config.jwt.secret).role);
  } catch {
    return false;
  }
}

function blockedPage(lang) {
  const tr = (k) => i18n.t(lang, k);
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${tr('server.ban.pageTitle')}</title></head>` +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121110;color:#f0ebe6;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">' +
    `<div style="max-width:440px"><div style="font-size:48px">⛔</div><h1 style="font-size:22px">${tr('server.ban.pageTitle')}</h1>` +
    `<p style="color:#a9a29b">${tr('server.ban.pageText')}</p></div></body></html>`;
}

// express: забаненный IP/устройство не получает ни страниц, ни API
function guard(req, res, next) {
  if (!map.size) return next();
  const by = bannedBy(infoOf(req));
  if (!by || isAdminReq(req)) return next();
  res.setHeader('Cache-Control', 'no-store');
  const lang = req.lang || i18n.langFromHeaders(req.headers);
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return res.status(403).json({ error: i18n.t(lang, 'server.ban.blocked'), code: 'banned' });
  }
  res.status(403).type('html').send(blockedPage(lang));
}

// сокеты (allowRequest движка — все namespace сразу)
function allowSocket(rawReq) {
  if (!map.size) return true;
  return !bannedBy(infoOf(rawReq)) || isAdminReq(rawReq);
}

async function add(kind, value, meta = {}) {
  await Ban.updateOne(
    { kind, value },
    { $set: { ...meta, at: new Date() } }, // kind и value при вставке берутся из фильтра
    { upsert: true },
  );
  map.set(kind + ':' + value, { until: meta.until ? new Date(meta.until).getTime() : 0 });
}

async function remove(id) {
  const b = await Ban.findByIdAndDelete(id).lean();
  if (b) map.delete(b.kind + ':' + b.value);
  return b;
}

// бан аккаунта: { perm, until } — сейчас действует?
function accountBanned(u) {
  if (!u) return false;
  return !!u.banPerm || (!!u.banUntil && new Date(u.banUntil).getTime() > Date.now());
}

module.exports = { start, reload, guard, allowSocket, bannedBy, infoOf, add, remove, accountBanned, active, loadedAt: () => loadedAt };
