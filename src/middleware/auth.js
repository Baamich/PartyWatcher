const jwt = require('jsonwebtoken');
const config = require('../config');

function auth(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  try {
    req.user = jwt.verify(token, config.jwt.secret); // { id, username, role }
    next();
  } catch {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

module.exports = auth;