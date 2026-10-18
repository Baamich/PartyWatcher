// Сеансы входа (models/Session) и токен в cookie. Профиль → «Устройства»: где сейчас открыт аккаунт,
// главное устройство (с которого регистрировались), завершить чужой сеанс.
// Нагрузка: жив ли сеанс, спрашиваем базу раз в час на сеанс (заодно обновляем «был активен»);
// завершённый сеанс отрезается сразу — его sid помним в памяти (процесс сайта один, instances: 1).
// Админ-сервер — отдельный процесс: там проверка раз в минуту (setCheckTtl)
const crypto = require('crypto');
const { EventEmitter } = require('events');
const jwt = require('jsonwebtoken');
const config = require('../config');
const Session = require('../models/Session');
const User = require('../models/User');
const UserSeen = require('../models/UserSeen');
const { clientIp, parseUA, deviceIds } = require('./clientInfo');

// cookie на весь домен (сайт + live. + админка); на localhost домен не ставим, иначе браузер её не примет
const COOKIE_DOMAIN = (() => {
  if (process.env.COOKIE_DOMAIN !== undefined) return process.env.COOKIE_DOMAIN || undefined;
  try {
    const host = new URL(config.publicUrl).hostname;
    return host === 'partywatcher.de' || host.endsWith('.partywatcher.de') ? '.partywatcher.de' : undefined;
  } catch {
    return undefined;
  }
})();

function signToken(user, sid) {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role, tv: user.tokenVersion || 0, sid },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function setTokenCookie(res, token) {
  const isHttps = config.publicUrl?.startsWith('https://') || process.env.FORCE_SECURE_COOKIE === '1';
  res.cookie('token', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearTokenCookie(res) {
  res.clearCookie('token', { domain: COOKIE_DOMAIN, path: '/' });
}

// ---------- кэш «жив ли сеанс» ----------
let CHECK_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // sid → { ok, at }; ok:false держим до перезапуска (sid больше не оживёт)
const inflight = new Map(); // sid → Promise: десяток параллельных запросов страницы — один поход в базу

function remember(sid, ok) {
  if (cache.size > 20000) cache.clear();
  cache.set(sid, { ok, at: Date.now() });
}

// завершённые сеансы: server.js отключает их сокеты (чат, комната) — иначе открытая вкладка писала бы дальше
const events = new EventEmitter();
const onRevoke = (fn) => events.on('revoke', fn);

// вход: запись сеанса и токен в cookie. main — это вход при регистрации: устройство становится главным;
// legacyIat — сеанс заводится для старого токена без sid
async function start(res, req, user, { main = false, legacyIat } = {}) {
  const sid = crypto.randomBytes(16).toString('base64url');
  const token = signToken(user, sid);
  const { did } = deviceIds(req);
  await Session.create({
    userId: user._id,
    sid,
    tv: user.tokenVersion || 0,
    did,
    device: parseUA(req.headers || {}).name || '',
    ip: clientIp(req),
    country: String(req.headers?.['cf-ipcountry'] || '').slice(0, 2),
    expiresAt: new Date(jwt.decode(token).exp * 1000),
    ...(legacyIat && { legacyIat }),
  });
  if (main && did) {
    await User.updateOne({ _id: user._id, mainDeviceId: { $in: [null, ''] } }, { $set: { mainDeviceId: did } });
  }
  remember(sid, true);
  setTokenCookie(res, token);
  return sid;
}

// payload токена → сеанс жив? Токен без sid (выдан до сеансов) пропускаем: auth.js переведёт его на сеанс
async function check(payload, req) {
  const sid = payload.sid;
  if (!sid) return true;
  const hit = cache.get(sid);
  if (hit && (!hit.ok || Date.now() - hit.at < CHECK_TTL_MS)) return hit.ok;
  if (inflight.has(sid)) return inflight.get(sid);
  const p = (async () => {
    const set = { lastSeenAt: new Date() };
    if (req) set.ip = clientIp(req);
    const s = await Session.findOneAndUpdate({ sid, userId: payload.id, revoked: { $ne: true } }, { $set: set }, { projection: { _id: 1 } }).lean();
    remember(sid, !!s);
    return !!s;
  })().finally(() => inflight.delete(sid));
  inflight.set(sid, p);
  return p;
}

// старый токен без sid → настоящий сеанс и новый токен. Один сеанс на токен (по его iat): пришёл снова —
// тот же сеанс; этот сеанс завершили — null, токен больше не принимается
const upgrading = new Map(); // token → Promise<sid|null>
function upgradeLegacy(req, res, payload, token) {
  let p = upgrading.get(token);
  if (!p) {
    p = (async () => {
      const user = await User.findById(payload.id).select('username role tokenVersion').lean();
      if (!user) return null;
      const prev = await Session.findOne({ userId: user._id, legacyIat: payload.iat }).select('sid revoked').lean();
      if (prev) {
        if (prev.revoked) return null;
        setTokenCookie(res, signToken(user, prev.sid));
        return prev.sid;
      }
      return start(res, req, user, { legacyIat: payload.iat });
    })().catch((e) => { console.error('[sessions] upgrade', e.message); return null; });
    upgrading.set(token, p);
    setTimeout(() => upgrading.delete(token), 5 * 60 * 1000).unref?.();
  }
  return p;
}

// завершить сеансы по условию; возвращает, сколько. Сеансы старых токенов остаются отметкой revoked (до срока)
async function revokeWhere(filter) {
  const rows = await Session.find({ ...filter, revoked: { $ne: true } }).select('sid legacyIat').lean();
  if (!rows.length) return 0;
  const legacy = rows.filter((r) => r.legacyIat).map((r) => r._id);
  const plain = rows.filter((r) => !r.legacyIat).map((r) => r._id);
  if (legacy.length) await Session.updateMany({ _id: { $in: legacy } }, { $set: { revoked: true } });
  if (plain.length) await Session.deleteMany({ _id: { $in: plain } });
  for (const r of rows) remember(r.sid, false);
  events.emit('revoke', new Set(rows.map((r) => r.sid)));
  return rows.length;
}

// главное устройство: у старых аккаунтов (до «Устройств») — самое раннее устройство из истории входов
async function ensureMain(user) {
  if (user.mainDeviceId) return user.mainDeviceId;
  const first = await UserSeen.findOne({ userId: user._id, did: { $nin: [null, ''] } }).sort({ firstAt: 1 }).select('did').lean();
  if (!first) return '';
  await User.updateOne({ _id: user._id, mainDeviceId: { $in: [null, ''] } }, { $set: { mainDeviceId: first.did } });
  return first.did;
}

// этот сеанс — с главного устройства? Главного у аккаунта нет (нечего защищать) — считаем, что да
async function mainState(userId, sid) {
  const user = await User.findById(userId).select('mainDeviceId').lean();
  if (!user) return { isMain: false, hasMain: false };
  const mainDid = await ensureMain(user);
  if (!mainDid) return { isMain: true, hasMain: false };
  const s = sid ? await Session.findOne({ sid, revoked: { $ne: true } }).select('did').lean() : null;
  return { isMain: !!(s && s.did === mainDid), hasMain: true };
}

// как в Telegram: смена пароля и почты, удаление аккаунта — только с главного устройства.
// Укравший пароль с нового устройства не выкинет хозяина; забыл пароль — сброс по письму работает как раньше
async function requireMain(req, res, next) {
  try {
    if ((await mainState(req.user.id, req.user.sid)).isMain) return next();
    res.status(403).json({ error: req.t('server.account.devices.mainOnly'), code: 'mainOnly' });
  } catch (e) {
    next(e);
  }
}

// сеансы аккаунта; мёртвые (сменился пароль или бан — другая tokenVersion) заодно удаляем
async function list(user) {
  const rows = await Session.find({ userId: user._id, revoked: { $ne: true } }).sort({ lastSeenAt: -1 }).lean();
  const tv = user.tokenVersion || 0;
  const dead = rows.filter((r) => (r.tv || 0) !== tv);
  if (dead.length) await revokeWhere({ _id: { $in: dead.map((r) => r._id) } });
  return rows.filter((r) => (r.tv || 0) === tv);
}

function setCheckTtl(ms) {
  CHECK_TTL_MS = ms;
}

module.exports = {
  COOKIE_DOMAIN, signToken, setTokenCookie, clearTokenCookie,
  start, check, upgradeLegacy, revokeWhere, ensureMain, mainState, requireMain, list, setCheckTtl, onRevoke,
};
