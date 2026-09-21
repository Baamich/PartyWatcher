const jwt = require('jsonwebtoken');
const config = require('../config');

function auth(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');

  // ВРЕМЕННЫЙ ДЕБАГ — убрать после диагностики
  console.log(
    '[auth]',
    req.method,
    req.originalUrl,
    '| hasCookieToken:', !!req.cookies?.token,
    '| hasAuthHeader:', !!req.headers.authorization,
    '| UA:', (req.headers['user-agent'] || '').slice(0, 80),
    '| IP:', req.ip || req.headers['x-forwarded-for']
  );

  if (!token) {
    console.log('[auth] REJECT (no token) →', req.originalUrl);
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    req.user = jwt.verify(token, config.jwt.secret); // { id, username, role }
    next();
  } catch (e) {
    console.log('[auth] REJECT (invalid token) →', req.originalUrl, e.message);
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

module.exports = auth;