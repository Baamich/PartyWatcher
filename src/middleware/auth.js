const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');

// tokenVersion пользователя держим в памяти минуту: не ходим в базу на каждый запрос,
// а после смены пароля старые токены перестают работать максимум через минуту (в этом процессе — сразу)
const TV_TTL_MS = 60 * 1000;
const tvCache = new Map(); // userId → { tv, at }

async function currentTokenVersion(userId) {
  const hit = tvCache.get(userId);
  if (hit && Date.now() - hit.at < TV_TTL_MS) return hit.tv;
  const u = await User.findById(userId).select('tokenVersion').lean();
  const tv = u ? u.tokenVersion || 0 : null; // null — пользователя больше нет
  if (tvCache.size > 10000) tvCache.clear();
  tvCache.set(userId, { tv, at: Date.now() });
  return tv;
}

function readToken(req) {
  return req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
}

// { id, username, role, tv } или исключение; используется и HTTP, и сокетами
async function verifyToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  const tv = await currentTokenVersion(String(payload.id));
  if (tv === null || (payload.tv || 0) !== tv) throw new Error('token revoked');
  return payload;
}

async function verifyRequest(req) {
  const token = readToken(req);
  if (!token) throw Object.assign(new Error('no token'), { code: 'NO_TOKEN' });
  return verifyToken(token);
}

async function auth(req, res, next) {
  try {
    req.user = await verifyRequest(req);
    next();
  } catch (e) {
    if (e.code === 'NO_TOKEN') {
      console.log('[auth] REJECT (no token) →', req.originalUrl);
      return res.status(401).json({ error: 'Не авторизован' });
    }
    console.log('[auth] REJECT (invalid token) →', req.originalUrl, e.message);
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

// не требует входа: если токен валиден — заполняет req.user, иначе req.user = null
async function optionalAuth(req, res, next) {
  try {
    req.user = await verifyRequest(req);
  } catch (_) {
    req.user = null;
  }
  next();
}

// сразу забыть закэшированную версию (после смены пароля в этом же процессе)
function forgetUser(userId) {
  tvCache.delete(String(userId));
}

module.exports = auth;
module.exports.optional = optionalAuth;
module.exports.forgetUser = forgetUser;
module.exports.verifyToken = verifyToken;
