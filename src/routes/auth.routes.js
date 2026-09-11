const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const config = require('../config');
const auth = require('../middleware/auth');

function signToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Заполни все поля' });
  }

  const exists = await User.findOne({ $or: [{ username }, { email }] });
  if (exists) return res.status(409).json({ error: 'Юзер уже существует' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email, passwordHash });

  const token = signToken(user);
  setTokenCookie(res, token);
  res.status(201).json({ id: user._id, username: user.username, role: user.role });
});

router.post('/login', async (req, res) => {
  const { login, password } = req.body; // логин = username или email
  const user = await User.findOne({ $or: [{ username: login }, { email: login }] });
  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });

  const token = signToken(user);
  setTokenCookie(res, token);
  res.json({ id: user._id, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ status: 'ok' });
});

router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('username role');
  if (!user) return res.status(401).json({ error: 'Юзер не найден' });
  res.json({ id: user._id, username: user.username, role: user.role });
});

module.exports = router;