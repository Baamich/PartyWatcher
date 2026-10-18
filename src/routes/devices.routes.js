// Профиль → «Устройства»: где открыт аккаунт и главное устройство (с которого регистрировались).
// С главного можно завершить любой сеанс и сделать главным другое устройство; с остальных — завершать
// только неглавные сеансы. Главное устройство потеряно — меняет поддержка (админка)
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const User = require('../models/User');
const sessions = require('../services/sessions');
const accountLog = require('../services/accountLog');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.auth.tooManyAttempts') }),
});

// IP целиком не показываем: страницу профиля открывают и на стриме
function maskIp(ip) {
  const s = String(ip || '');
  if (s.includes('.')) return s.replace(/\.\d+$/, '.•••');
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + ':•••';
  return s;
}

async function load(req) {
  const user = await User.findById(req.user.id).select('tokenVersion mainDeviceId').lean();
  if (!user) return null;
  const mainDid = await sessions.ensureMain(user);
  const rows = await sessions.list(user);
  const cur = rows.find((r) => r.sid === req.user.sid) || null;
  return { user, mainDid, rows, cur, isMain: !!(cur && mainDid && cur.did === mainDid) };
}

const isMainRow = (ctx, r) => !!(ctx.mainDid && r.did === ctx.mainDid);

// GET /devices — сеансы: этот — первым, потом по «был активен»
router.get('/', auth, async (req, res) => {
  const ctx = await load(req);
  if (!ctx) return res.status(401).json({ error: req.t('server.userNotFound') });
  const out = ctx.rows
    .map((r) => ({
      sid: r.sid,
      device: r.device,
      ip: maskIp(r.ip),
      country: r.country,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      current: r.sid === req.user.sid,
      main: isMainRow(ctx, r),
      canMain: !!r.did, // главным можно сделать только устройство с id браузера
    }))
    .sort((a, b) => (b.current - a.current) || (b.main - a.main));
  res.json({ isMain: ctx.isMain, hasMain: !!ctx.mainDid, sessions: out });
});

// POST /devices/revoke { sid } — завершить сеанс (свой — это выход)
router.post('/revoke', auth, limiter, async (req, res) => {
  const ctx = await load(req);
  if (!ctx) return res.status(401).json({ error: req.t('server.userNotFound') });
  const row = ctx.rows.find((r) => r.sid === String(req.body?.sid || ''));
  if (!row) return res.status(404).json({ error: req.t('server.account.devices.notFound') });
  const own = row.sid === req.user.sid;
  if (!own && isMainRow(ctx, row) && !ctx.isMain) return res.status(403).json({ error: req.t('server.account.devices.mainOnly') });
  await sessions.revokeWhere({ _id: row._id });
  if (own) sessions.clearTokenCookie(res);
  res.json({ ok: true, self: own });
});

// POST /devices/revoke-others — завершить все сеансы, кроме этого (главный — только с главного)
router.post('/revoke-others', auth, limiter, async (req, res) => {
  const ctx = await load(req);
  if (!ctx) return res.status(401).json({ error: req.t('server.userNotFound') });
  const ids = ctx.rows.filter((r) => r.sid !== req.user.sid && (ctx.isMain || !isMainRow(ctx, r))).map((r) => r._id);
  const n = ids.length ? await sessions.revokeWhere({ _id: { $in: ids } }) : 0;
  res.json({ ok: true, count: n });
});

// POST /devices/main { sid } — сделать главным другое устройство (только с главного)
router.post('/main', auth, limiter, async (req, res) => {
  const ctx = await load(req);
  if (!ctx) return res.status(401).json({ error: req.t('server.userNotFound') });
  if (!ctx.isMain) return res.status(403).json({ error: req.t('server.account.devices.mainOnly') });
  const row = ctx.rows.find((r) => r.sid === String(req.body?.sid || ''));
  if (!row || !row.did) return res.status(404).json({ error: req.t('server.account.devices.notFound') });
  if (row.did === ctx.mainDid) return res.json({ ok: true });
  await User.updateOne({ _id: ctx.user._id }, { $set: { mainDeviceId: row.did } });
  accountLog.record(ctx.user._id, 'mainDevice', { from: (ctx.cur && ctx.cur.device) || '', to: row.device }, req);
  res.json({ ok: true });
});

module.exports = router;

