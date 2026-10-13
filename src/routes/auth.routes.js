const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { hasProfanity } = require('../services/profanity');
const router = express.Router();
const User = require('../models/User');
const config = require('../config');
const auth = require('../middleware/auth');
const { meOf } = require('../services/me');
const { TERMS_VERSION } = require('../services/terms');
const { clientIp, parseUA } = require('../services/clientInfo');
const { sendPasswordReset, sendVerifyEmail, isMailConfigured, maskEmail } = require('../services/mailer');
const rateLimit = require('express-rate-limit');

const RESET_TTL_MIN = 30;
const VERIFY_TTL_MIN = 30; // столько живёт неподтверждённая регистрация (потом её удаляет TTL-индекс User)
const VERIFY_RESEND_MS = 2 * 60 * 1000;
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
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
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
    if (req.body.acceptTerms !== true) {
      return res.status(400).json({ error: req.t('server.terms.mustAccept') });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: req.t('server.auth.usernameLen') });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: req.t('server.auth.usernameChars') });
    }
    if (hasProfanity(username)) return res.status(400).json({ error: req.t('server.auth.usernameBad') });

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: req.t(emailErr) });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: req.t(passErr) });

    const usernameLower = username.toLowerCase();
    let exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    // неподтверждённая регистрация, срок которой вышел (TTL-индекс удаляет с задержкой до минуты), — место свободно
    if (exists && isExpiredPending(exists)) {
      await User.deleteOne({ _id: exists._id, verifyPending: true });
      exists = await User.findOne({ $or: [{ usernameLower }, { email }] });
    }
    if (exists && exists.verifyPending) {
      return res.status(409).json({ error: req.t('server.auth.pendingExists', { n: VERIFY_TTL_MIN }) });
    }
    if (exists) {
      if (exists.usernameLower === usernameLower) {
        return res.status(409).json({ error: req.t('server.auth.usernameTaken') });
      }
      return res.status(409).json({ error: req.t('server.auth.emailTaken') });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // без настроенной почты (локальная разработка) подтверждать нечем — аккаунт сразу активен
    const needVerify = isMailConfigured();
    const verifyToken = needVerify ? crypto.randomBytes(32).toString('base64url') : null;
    // streamerName не передаём — pre('validate') скопирует username
    const user = await User.create({
      username, email, passwordHash,
      termsVersion: TERMS_VERSION, termsAt: new Date(),
      regIp: clientIp(req), regDevice: parseUA(req.headers).name,
      ...(needVerify
        ? { verifyPending: true, verifyTokenHash: hashResetToken(verifyToken), verifyExpires: new Date(Date.now() + VERIFY_TTL_MIN * 60000), verifySentAt: new Date() }
        : {}),
    });

    if (needVerify) {
      sendVerify(user, verifyToken, req.lang).catch((e) => console.error('[auth/register] письмо подтверждения не отправлено:', e.message));
      // входа нет, пока не подтвердит почту: cookie не ставим
      return res.status(201).json({
        pending: true,
        message: req.t('server.auth.verifySent', { email: maskEmail(email), n: VERIFY_TTL_MIN }),
      });
    }
    console.warn('[auth/register] SMTP не настроен — аккаунт активирован без подтверждения почты');
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
    if (user.verifyPending) {
      if (isExpiredPending(user)) {
        await User.deleteOne({ _id: user._id, verifyPending: true });
        return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }), code: 'verifyExpired' });
      }
      return res.status(403).json({ error: req.t('server.auth.unverified', { email: maskEmail(user.email) }), code: 'unverified' });
    }
    // про бан говорим только тому, кто знает пароль
    if (user.banPerm) {
      return res.status(403).json({ error: banText(req, null, user.banReason), code: 'banned' });
    }
    if (user.banUntil && user.banUntil.getTime() > Date.now()) {
      return res.status(403).json({ error: banText(req, user.banUntil, user.banReason), code: 'banned' });
    }

    const token = signToken(user);
    setTokenCookie(res, token);
    res.json({ id: user._id, username: user.username, role: user.role });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: req.t('server.serverError') });
  }
});

function isExpiredPending(u) {
  return !!u.verifyPending && (!u.verifyExpires || new Date(u.verifyExpires).getTime() <= Date.now());
}

// ссылка подтверждения: токен во фрагменте (#t=), как у сброса пароля — в логи и Referer не попадает
function sendVerify(user, token, lang) {
  const link = `${config.publicUrl.replace(/\/$/, '')}/verify-email.html#t=${token}`;
  return sendVerifyEmail(user.email, user.username, link, VERIFY_TTL_MIN, lang);
}

// POST /auth/verify { token } — подтвердить почту по ссылке из письма: аккаунт активен, сразу входим
router.post('/verify', resetLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(400).json({ error: req.t('server.auth.verifyBadLink') });
  const user = await User.findOne({ verifyTokenHash: hashResetToken(token), verifyPending: true });
  if (!user) return res.status(400).json({ error: req.t('server.auth.verifyBadLink') });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  await User.updateOne({ _id: user._id }, { $unset: { verifyPending: 1, verifyTokenHash: 1, verifyExpires: 1, verifySentAt: 1 } });
  setTokenCookie(res, signToken(user));
  res.json({ ok: true, username: user.username });
});

// POST /auth/verify/resend { login, password } — письмо ещё раз (не чаще раза в 2 мин). С паролем: иначе по
// чужому логину можно было бы засыпать человека письмами. Срок 30 минут не продлевается
router.post('/verify/resend', resendLimiter, async (req, res) => {
  const loginLower = String(req.body?.login ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });
  if (!user.verifyPending) return res.json({ ok: true, already: true });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  if (user.verifySentAt && Date.now() - new Date(user.verifySentAt).getTime() < VERIFY_RESEND_MS) {
    return res.status(429).json({ error: req.t('server.auth.forgotWait') });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await User.updateOne({ _id: user._id }, { $set: { verifyTokenHash: hashResetToken(token), verifySentAt: new Date() } });
  try {
    await sendVerify(user, token, req.lang);
  } catch (e) {
    console.error('[auth/verify/resend] письмо не отправлено:', e.message);
    return res.status(502).json({ error: req.t('server.sendFailed') });
  }
  const left = Math.max(1, Math.ceil((new Date(user.verifyExpires).getTime() - Date.now()) / 60000));
  res.json({ ok: true, message: req.t('server.auth.verifySent', { email: maskEmail(user.email), n: left }) });
});

// POST /auth/verify/change-email { login, password, email } — ошибся в почте при регистрации: новая почта, новое
// письмо, и 30 минут на подтверждение отсчитываются заново. Только для неподтверждённого аккаунта и с паролем
router.post('/verify/change-email', resendLimiter, async (req, res) => {
  const loginLower = String(req.body?.login ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const user = await User.findOne({ $or: [{ usernameLower: loginLower }, { email: loginLower }] });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: req.t('server.auth.badLogin') });
  if (!user.verifyPending) return res.status(400).json({ error: req.t('server.auth.alreadyVerified') });
  if (isExpiredPending(user)) {
    await User.deleteOne({ _id: user._id, verifyPending: true });
    return res.status(410).json({ error: req.t('server.auth.verifyExpired', { n: VERIFY_TTL_MIN }) });
  }
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: req.t(emailErr) });
  if (email !== user.email) {
    const other = await User.findOne({ email, _id: { $ne: user._id } }).select('verifyPending verifyExpires').lean();
    if (other && isExpiredPending(other)) await User.deleteOne({ _id: other._id, verifyPending: true });
    else if (other) return res.status(409).json({ error: req.t('server.auth.emailTaken') });
  }
  if (user.verifySentAt && Date.now() - new Date(user.verifySentAt).getTime() < VERIFY_RESEND_MS) {
    return res.status(429).json({ error: req.t('server.auth.forgotWait') });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  user.email = email;
  await User.updateOne({ _id: user._id }, {
    $set: { email, verifyTokenHash: hashResetToken(token), verifySentAt: new Date(), verifyExpires: new Date(Date.now() + VERIFY_TTL_MIN * 60000) },
  });
  try {
    await sendVerify(user, token, req.lang);
  } catch (e) {
    console.error('[auth/verify/change-email] письмо не отправлено:', e.message);
    return res.status(502).json({ error: req.t('server.sendFailed') });
  }
  res.json({ ok: true, message: req.t('server.auth.verifySent', { email: maskEmail(email), n: VERIFY_TTL_MIN }) });
});

// «Аккаунт заблокирован до 14.10.2026, 18:00. Причина: …» — дата в часовом поясе UTC (у сервера нет зоны человека)
function banText(req, until, reason) {
  const base = until
    ? req.t('server.ban.accountUntil', { until: until.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' })
    : req.t('server.ban.accountPerm');
  return reason ? base + ' ' + req.t('server.ban.reason', { reason }) : base;
}

// POST /auth/terms { accept: true } — принять текущие условия пользования (окно js/terms-gate.js)
router.post('/terms', auth, async (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: req.t('server.terms.mustAccept') });
  await User.updateOne({ _id: req.user.id }, { $set: { termsVersion: TERMS_VERSION, termsAt: new Date() } });
  auth.forgetUser(req.user.id);
  res.json({ ok: true, version: TERMS_VERSION });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    domain: COOKIE_DOMAIN,
    path: '/',
  });
  res.json({ status: 'ok' });
});

// POST /auth/forgot { email } — письмо со ссылкой сброса.
// Говорим прямо, если аккаунта с такой почтой нет или письмо уже ушло: регистрация и так сообщает «почта занята»,
// так что новой утечки нет, а человек сразу видит опечатку. От перебора — forgotLimiter (5 в час с IP)
router.post('/forgot', forgotLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (validateEmail(email)) return res.status(400).json({ error: req.t('server.badEmail') });

  const okAnswer = { status: 'ok', message: req.t('server.auth.forgotSent') };
  try {
    const user = await User.findOne({ email }).select('username email resetTokenExpires verifyPending').lean();
    // повторный запрос раньше чем через 2 минуты молча игнорируем (защита ящика от флуда)
    const sentRecently =
      user?.resetTokenExpires &&
      user.resetTokenExpires.getTime() - RESET_TTL_MIN * 60 * 1000 > Date.now() - RESET_RESEND_MS;
    if (!user) {
      console.log(`[auth/forgot] аккаунта с почтой ${maskEmail(email)} нет — письмо не отправлялось`);
      return res.status(404).json({ error: req.t('server.auth.forgotNoAccount') });
    }
    if (user.verifyPending) {
      return res.status(403).json({ error: req.t('server.auth.unverified', { email: maskEmail(email) }) });
    }
    if (sentRecently) {
      console.log(`[auth/forgot] ${maskEmail(email)}: письмо уже уходило меньше 2 мин назад — повтор пропущен`);
      return res.status(429).json({ error: req.t('server.auth.forgotWait') });
    }

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
  const me = await meOf(req.user.id);
  if (!me) return res.status(401).json({ error: req.t('server.userNotFound') });
  res.json(me);
});

// 18+: { confirmed: true } — подтвердил возраст (отменить нельзя); { showAdult } — галочка «18+» в публичных комнатах.
// Показывать 18+ можно только после подтверждения возраста
router.patch('/adult', auth, async (req, res) => {
  const set = {};
  if (req.body?.confirmed === true) set.adultConfirmed = true;
  if (typeof req.body?.showAdult === 'boolean') set.showAdult = req.body.showAdult;
  if (!Object.keys(set).length) return res.status(400).json({ error: req.t('server.error') });
  const filter = { _id: req.user.id };
  if (set.showAdult === true && !set.adultConfirmed) filter.adultConfirmed = true;
  const r = await User.updateOne(filter, { $set: set });
  if (!r.matchedCount) return res.status(403).json({ error: req.t('server.adult.notConfirmed') });
  res.json({ ok: true });
});

module.exports = router;