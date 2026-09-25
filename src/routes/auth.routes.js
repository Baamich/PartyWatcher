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
  const isHttps =
    config.publicUrl?.startsWith('https://') ||
    process.env.FORCE_SECURE_COOKIE === '1';

  res.cookie('token', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    domain: '.partywatcher.de',   // ← вот это ключевое
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Пароль должен быть не короче 8 символов';
  }
  if (!/^[A-Z]/.test(password)) {
    return 'Пароль должен начинаться с заглавной латинской буквы (A–Z)';
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'Пароль должен содержать буквы';
  }
  if (!/\d/.test(password)) {
    return 'Пароль должен содержать цифры';
  }
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return 'Некорректная почта';
  const v = email.trim();
  if (!v) return 'Введите почту';
  if (v.includes(' ')) return 'Почта не должна содержать пробелы';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Некорректный формат почты';
  return null;
}

router.post('/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Заполни все поля' });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Логин: от 3 до 32 символов' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Логин: только латиница, цифры и _' });
    }

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    const usernameLower = username.toLowerCase();
    const exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    if (exists) {
      if (exists.usernameLower === usernameLower) {
        return res.status(409).json({ error: 'Такой логин уже занят' });
      }
      return res.status(409).json({ error: 'Такая почта уже зарегистрирована' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email, passwordHash });

    const token = signToken(user);
    setTokenCookie(res, token);
    res.status(201).json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/login', async (req, res) => {
  const { login, password } = req.body; // логин = username или email
  const loginLower = String(login || '').trim().toLowerCase();
  const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });

  const token = signToken(user);
  setTokenCookie(res, token);
  res.json({ id: user._id, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    domain: '.partywatcher.de',
    path: '/',
  });
  res.json({ status: 'ok' });
});

router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('username role streamerName');
  if (!user) return res.status(401).json({ error: 'Юзер не найден' });
  res.json({ id: user._id, username: user.username, role: user.role, streamerName: user.streamerName || null });
});

module.exports = router;