// /api/admin/users и /api/admin/bans — аккаунты в админке: список (поиск, сортировка), карточка
// (IP и устройства, с которых заходил), блокировка на время, бан навсегда, бан IP и устройства.
// Админов и самого себя забанить нельзя. Бан аккаунта убивает его сессии (tokenVersion + 1)
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const User = require('../models/User');
const UserSeen = require('../models/UserSeen');
const Ban = require('../models/Ban');
const bans = require('../services/bans');
const { TERMS_VERSION } = require('../services/terms');

const PAGE = 50;
const BLOCK_HOURS = [1, 6, 24, 72, 168, 720];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanReason = (v) => String(v || '').trim().slice(0, 300);
const IP_RE = /^[0-9a-f.:]{3,64}$/i;

function view(u) {
  return {
    id: u._id, username: u.username, email: u.email, role: u.role, streamerName: u.streamerName || '',
    createdAt: u.createdAt, lastSeenAt: u.lastSeenAt || null, lastIp: u.lastIp || '', regIp: u.regIp || '', regDevice: u.regDevice || '',
    banPerm: !!u.banPerm, banUntil: u.banUntil && new Date(u.banUntil) > new Date() ? u.banUntil : null,
    banReason: u.banReason || '', banBy: u.banBy || '', banAt: u.banAt || null,
    termsOk: u.termsVersion === TERMS_VERSION, isLive: !!u.isLive,
  };
}
const FIELDS = 'username email role streamerName createdAt lastSeenAt lastIp regIp regDevice banPerm banUntil banReason banBy banAt termsVersion isLive';

// GET /admin/users?sort=new|old|name|seen&q=&filter=all|banned|online&page=1
router.get('/users', auth, adminOnly, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sorts = { new: { createdAt: -1 }, old: { createdAt: 1 }, name: { usernameLower: 1 }, seen: { lastSeenAt: -1, createdAt: -1 } };
  const sort = sorts[req.query.sort] || sorts.new;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const filter = {};
  if (q) {
    const re = { $regex: escapeRegex(q.toLowerCase()), $options: 'i' };
    const or = [{ usernameLower: re }, { email: re }, { streamerNameLower: re }];
    if (IP_RE.test(q) && /[.:]/.test(q)) {
      // поиск по IP: и последний/при регистрации, и все, с которых заходил
      const ids = await UserSeen.distinct('userId', { ip: q });
      or.push({ lastIp: q }, { regIp: q }, { _id: { $in: ids } });
    }
    if (mongoose.isValidObjectId(q)) or.push({ _id: q });
    filter.$or = or;
  }
  if (req.query.filter === 'banned') {
    const ban = { $or: [{ banPerm: true }, { banUntil: { $gt: new Date() } }] };
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, ban];
      delete filter.$or;
    } else {
      Object.assign(filter, ban);
    }
  } else if (req.query.filter === 'online') {
    filter.lastSeenAt = { $gte: new Date(Date.now() - 5 * 60000) };
  }
  const [total, rows] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort(sort).skip((page - 1) * PAGE).limit(PAGE).select(FIELDS).lean(),
  ]);
  res.json({ users: rows.map(view), total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
});

// GET /admin/users/:id — карточка: IP и устройства, баны по ним
router.get('/users/:id', auth, adminOnly, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: req.t('server.notFound') });
  const u = await User.findById(req.params.id).select(FIELDS).lean();
  if (!u) return res.status(404).json({ error: req.t('server.notFound') });
  const seen = await UserSeen.find({ userId: u._id }).sort({ lastAt: -1 }).limit(100).lean();
  // IP регистрации тоже показываем, даже если с него больше не заходил
  if (u.regIp && !seen.some((s) => s.ip === u.regIp)) seen.push({ ip: u.regIp, name: u.regDevice, firstAt: u.createdAt, lastAt: u.createdAt, hits: 0, did: '', hw: '' });
  res.json({
    user: view(u),
    seen: seen.map((s) => ({
      ip: s.ip, did: s.did || '', hw: s.hw || '', name: s.name || '', country: s.country || '',
      firstAt: s.firstAt, lastAt: s.lastAt, hits: s.hits || 0,
      banned: { ip: bans.active('ip', s.ip), did: bans.active('did', s.did), hw: bans.active('hw', s.hw) },
    })),
    blockHours: BLOCK_HOURS,
  });
});

async function target(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: req.t('server.notFound') });
    return null;
  }
  const u = await User.findById(req.params.id).select('username role').lean();
  if (!u) {
    res.status(404).json({ error: req.t('server.notFound') });
    return null;
  }
  if (u.role === 'admin' || String(u._id) === String(req.user.id)) {
    res.status(400).json({ error: req.t('server.ban.notAdmin') });
    return null;
  }
  return u;
}

async function setAccountBan(req, res, set) {
  const u = await target(req, res);
  if (!u) return;
  await User.updateOne({ _id: u._id }, { $set: set, ...(set.banPerm || set.banUntil ? { $inc: { tokenVersion: 1 } } : {}) });
  auth.forgetUser(u._id); // сессии забаненного умирают сразу (в админ-сервере — у сайта через минуту)
  res.json({ ok: true });
}

// POST /admin/users/:id/block { hours, reason } — временная блокировка
router.post('/users/:id/block', auth, adminOnly, async (req, res) => {
  const hours = Number(req.body?.hours);
  if (!BLOCK_HOURS.includes(hours)) return res.status(400).json({ error: req.t('server.error') });
  await setAccountBan(req, res, {
    banPerm: false, banUntil: new Date(Date.now() + hours * 3600000),
    banReason: cleanReason(req.body?.reason), banAt: new Date(), banBy: req.user.username || '',
  });
});

// POST /admin/users/:id/ban { reason } — навсегда
router.post('/users/:id/ban', auth, adminOnly, async (req, res) => {
  await setAccountBan(req, res, {
    banPerm: true, banUntil: null, banReason: cleanReason(req.body?.reason), banAt: new Date(), banBy: req.user.username || '',
  });
});

// POST /admin/users/:id/unban — снять блокировку/бан аккаунта (баны IP и устройств — отдельно)
router.post('/users/:id/unban', auth, adminOnly, async (req, res) => {
  await setAccountBan(req, res, { banPerm: false, banUntil: null, banReason: '', banAt: null, banBy: '' });
});

// POST /admin/users/:id/ban-ip { reason, ip? } — один IP или все, с которых заходил аккаунт
router.post('/users/:id/ban-ip', auth, adminOnly, async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const one = String(req.body?.ip || '').trim();
  if (one && !IP_RE.test(one)) return res.status(400).json({ error: req.t('server.error') });
  let ips = one ? [one] : await UserSeen.distinct('ip', { userId: u._id });
  if (!one) {
    const full = await User.findById(u._id).select('regIp lastIp').lean();
    ips = [...new Set([...ips, full?.regIp, full?.lastIp].filter(Boolean))];
  }
  const meta = { userId: u._id, username: u.username, reason: cleanReason(req.body?.reason), by: req.user.username || '', until: null };
  for (const ip of ips) await bans.add('ip', ip, meta);
  res.json({ ok: true, count: ips.length });
});

// POST /admin/users/:id/ban-device { reason, did?, hw? } — одно устройство или все: и браузер (did), и железо (hw)
router.post('/users/:id/ban-device', auth, adminOnly, async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const HEX = /^[0-9a-f]{16}$/;
  let devs;
  if (req.body?.did || req.body?.hw) {
    const did = HEX.test(req.body.did || '') ? req.body.did : '';
    const hw = HEX.test(req.body.hw || '') ? req.body.hw : '';
    const s = await UserSeen.findOne({ userId: u._id, ...(did ? { did } : { hw }) }).select('name').lean();
    devs = [{ did, hw, name: s?.name || '' }];
  } else {
    devs = await UserSeen.find({ userId: u._id, $or: [{ did: { $ne: '' } }, { hw: { $ne: '' } }] }).select('did hw name').lean();
  }
  const meta = { userId: u._id, username: u.username, reason: cleanReason(req.body?.reason), by: req.user.username || '', until: null };
  let count = 0;
  for (const d of devs) {
    if (d.did) { await bans.add('did', d.did, { ...meta, name: d.name || '' }); count++; }
    if (d.hw) { await bans.add('hw', d.hw, { ...meta, name: d.name || '' }); count++; }
  }
  res.json({ ok: true, count });
});

// GET /admin/bans — баны IP и устройств
router.get('/bans', auth, adminOnly, async (req, res) => {
  const rows = await Ban.find({}).sort({ at: -1 }).limit(500).lean();
  res.json({
    bans: rows.map((b) => ({
      id: b._id, kind: b.kind, value: b.value, username: b.username || '', userId: b.userId || null,
      name: b.name || '', reason: b.reason || '', by: b.by || '', at: b.at, until: b.until,
    })),
  });
});

// DELETE /admin/bans/:id — снять бан IP/устройства
router.delete('/bans/:id', auth, adminOnly, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: req.t('server.notFound') });
  const b = await bans.remove(req.params.id);
  if (!b) return res.status(404).json({ error: req.t('server.notFound') });
  res.json({ ok: true });
});

module.exports = router;
