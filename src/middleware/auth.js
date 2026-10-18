const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { TERMS_VERSION } = require('../services/terms');
const sessions = require('../services/sessions');

// состояние пользователя держим в памяти минуту: не ходим в базу на каждый запрос, а после смены пароля
// или бана старые токены перестают работать максимум через минуту (в этом процессе — сразу, forgetUser)
const TV_TTL_MS = 60 * 1000;
const tvCache = new Map(); // userId → { tv, terms, perm, banUntil, at }

async function userState(userId) {
  const hit = tvCache.get(userId);
  if (hit && Date.now() - hit.at < TV_TTL_MS) return hit;
  const u = await User.findById(userId).select('tokenVersion termsVersion banPerm banUntil').lean();
  const st = u
    ? {
        tv: u.tokenVersion || 0,
        terms: u.termsVersion === TERMS_VERSION,
        perm: !!u.banPerm,
        banUntil: u.banUntil ? new Date(u.banUntil).getTime() : 0,
      }
    : { tv: null }; // пользователя больше нет
  st.at = Date.now();
  if (tvCache.size > 10000) tvCache.clear();
  tvCache.set(userId, st);
  return st;
}

function readToken(req) {
  return req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
}

// { id, username, role, tv, sid, terms } или исключение; используется и HTTP, и сокетами.
// req (если есть) — для «был активен» и IP сеанса
async function verifyToken(token, req) {
  const payload = jwt.verify(token, config.jwt.secret);
  const st = await userState(String(payload.id));
  if (st.tv === null || (payload.tv || 0) !== st.tv) throw new Error('token revoked');
  // бан навсегда или блокировка, срок которой ещё не вышел
  if (st.perm || st.banUntil > Date.now()) {
    throw Object.assign(new Error('banned'), { code: 'BANNED' });
  }
  // сеанс завершили (профиль → «Устройства», выход, смена пароля)
  if (!(await sessions.check(payload, req))) throw new Error('session ended');
  payload.terms = st.terms;
  return payload;
}

async function verifyRequest(req, res) {
  const token = readToken(req);
  if (!token) throw Object.assign(new Error('no token'), { code: 'NO_TOKEN' });
  const payload = await verifyToken(token, req);
  // токен выдан до сеансов — заводим сеанс и меняем cookie (человек ничего не замечает); его сеанс завершили — не пускаем
  if (!payload.sid && res) {
    payload.sid = await sessions.upgradeLegacy(req, res, payload, token);
    // sid из кэша апгрейда тоже проверяем: его сеанс могли завершить минуту назад
    if (!payload.sid || !(await sessions.check(payload, req))) throw new Error('session ended');
  }
  return payload;
}

// без принятых условий пользования можно читать и смотреть, но не менять данные — кроме самого
// согласия и выхода (окно js/terms-gate.js показывается на любой странице)
// удалить аккаунт можно и не принимая новые условия (условия сами отправляют в профиль)
const TERMS_FREE = /^\/api\/auth\/(?:terms|logout|me|delete)\b/;

async function auth(req, res, next) {
  try {
    req.user = await verifyRequest(req, res);
  } catch (e) {
    if (e.code === 'NO_TOKEN') {
      // гость — обычное дело (главная спрашивает /auth/me у каждого), в лог не пишем
      return res.status(401).json({ error: req.t('server.notAuthorized') });
    }
    if (e.code === 'BANNED') return res.status(401).json({ error: req.t('server.ban.accountShort'), code: 'banned' });
    console.log('[auth] REJECT (invalid token) →', req.originalUrl, e.message);
    return res.status(401).json({ error: req.t('server.badToken') });
  }
  if (!req.user.terms && req.method !== 'GET' && req.method !== 'HEAD' && !TERMS_FREE.test(req.originalUrl)) {
    return res.status(403).json({ error: req.t('server.terms.required'), code: 'terms' });
  }
  next();
}

// не требует входа: если токен валиден — заполняет req.user, иначе req.user = null
async function optionalAuth(req, res, next) {
  try {
    req.user = await verifyRequest(req, res);
  } catch (_) {
    req.user = null;
  }
  next();
}

// сразу забыть закэшированное состояние (смена пароля, бан, принятие условий — в этом же процессе)
function forgetUser(userId) {
  tvCache.delete(String(userId));
}

module.exports = auth;
module.exports.optional = optionalAuth;
module.exports.forgetUser = forgetUser;
module.exports.verifyToken = verifyToken;
