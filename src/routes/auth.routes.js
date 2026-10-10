const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const config = require('../config');
const auth = require('../middleware/auth');
const { sendPasswordReset } = require('../services/mailer');
const rateLimit = require('express-rate-limit');

const RESET_TTL_MIN = 30;
const RESET_RESEND_MS = 2 * 60 * 1000; // одно письмо на аккаунт раз в 2 минуты

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

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyResets') }),
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
});

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyLogins') }),
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyRegs') }),
});
// для логинов, которых нет в базе: сравниваем с «пустышкой», чтобы время ответа не выдавало, что такого логина нет
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

function signToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role, tv: user.tokenVersion || 0 },
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
    domain: COOKIE_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// валидаторы возвращают ключ словаря ошибки (перевод — req.t) или null
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'server.auth.passShort';
  }
  if (!/^[A-Z]/.test(password)) {
    return 'server.auth.passUpper';
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'server.auth.passLetters';
  }
  if (!/\d/.test(password)) {
    return 'server.auth.passDigits';
  }
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return 'server.badEmail';
  const v = email.trim();
  if (!v) return 'server.auth.emailEmpty';
  if (v.includes(' ')) return 'server.auth.emailSpaces';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'server.auth.emailFormat';
  return null;
}

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
      return res.status(400).json({ error: req.t('server.auth.fillAll') });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: req.t('server.auth.usernameLen') });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: req.t('server.auth.usernameChars') });
    }

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: req.t(emailErr) });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: req.t(passErr) });

    const usernameLower = username.toLowerCase();
    const exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    if (exists) {
      if (exists.usernameLower === usernameLower) {
        return res.status(409).json({ error: req.t('server.auth.usernameTaken') });
      }
      return res.status(409).json({ error: req.t('server.auth.emailTaken') });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // streamerName не передаём — pre('validate') скопирует username
    const user = await User.create({ username, email, passwordHash });

    const token = signToken(user);
    setTokenCookie(res, token);
    res.status(201).json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/register]', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: req.t('server.auth.taken') });
    }
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const loginLower = String(req.body?.login ?? '').trim().toLowerCase(); // логин = username или email
    const password = req.body?.password;
    if (!loginLower || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: req.t('server.auth.loginEmpty') });
    }

    const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });

    const token = signToken(user);
    setTokenCookie(res, token);
    res.json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    domain: COOKIE_DOMAIN,
    path: '/',
  });
  res.json({ status: 'ok' });
});

// POST /auth/forgot { email } — письмо со ссылкой сброса.
// Ответ всегда одинаковый, чтобы по нему нельзя было проверить, зарегистрирована ли почта.
router.post('/forgot', forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (validateEmail(email)) return res.status(400).json({ error: req.t('server.badEmail') });

  const okAnswer = { status: 'ok', message: req.t('server.auth.forgotSent') };
  try {
    const user = await User.findOne({ email }).select('username email resetTokenExpires').lean();
    // повторный запрос раньше чем через 2 минуты молча игнорируем (защита ящика от флуда)
    const sentRecently =
      user?.resetTokenExpires &&
      user.resetTokenExpires.getTime() - RESET_TTL_MIN * 60 * 1000 > Date.now() - RESET_RESEND_MS;
    if (!user || sentRecently) return res.json(okAnswer);

    const token = crypto.randomBytes(32).toString('base64url');
    // updateOne, а не save(): документ загружен не целиком, и pre('validate') стёр бы streamerNameLower
    await User.updateOne(
      { _id: user._id },
      { $set: { resetTokenHash: hashResetToken(token), resetTokenExpires: new Date(Date.now() + RESET_TTL_MIN * 60 * 1000) } }
    );

    // токен во фрагменте (#): браузер не отправляет его на сервер, в логи Cloudflare/nginx и в Referer он не попадёт
    const link = `${config.publicUrl.replace(/\/$/, '')}/reset-password.html#t=${token}`;
    sendPasswordReset(user.email, user.username, link, RESET_TTL_MIN, req.lang).catch((e) => {
      console.error('[auth/forgot] письмо не отправлено:', e.message);
    });
    res.json(okAnswer);
  } catch (err) {
    console.error('[auth/forgot]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

// POST /auth/reset { token, password } — задать новый пароль по ссылке из письма
router.post('/reset', resetLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    return res.status(400).json({ error: req.t('server.auth.badLink') });
  }
  const passErr = validatePassword(password);
  if (passErr) return res.status(400).json({ error: req.t(passErr) });

  try {
    const user = await User.findOne({
      resetTokenHash: hashResetToken(token),
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: req.t('server.auth.badLink') });

    user.passwordHash = await bcrypt.hash(password, 12);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // выкидываем все старые сессии
    await user.save();
    auth.forgetUser(user._id);

    setTokenCookie(res, signToken(user)); // сразу входим с новым паролем
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[auth/reset]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('username role streamerName');
  if (!user) return res.status(401).json({ error: req.t('server.userNotFound') });
  res.json({ id: user._id, username: user.username, role: user.role, streamerName: user.streamerName || null });
});

module.exports = router;