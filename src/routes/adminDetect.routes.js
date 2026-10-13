// /api/admin/detect — 🕵️ Обнаружение: разные аккаунты с одного IP, браузера (did) или железа (hw) за 30 дней.
// Источник — UserSeen (analytics.js). «Игнорировать» запоминает набор аккаунтов (DetectIgnore): добавится
// новый аккаунт к тому же IP/устройству — совпадение вернётся. Ответ держим 60 с (бейдж опрашивается раз в минуту)
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const User = require('../models/User');
const UserSeen = require('../models/UserSeen');
const DetectIgnore = require('../models/DetectIgnore');
const bans = require('../services/bans');

const DAYS = 30;
const CACHE_MS = 60 * 1000;
const KINDS = ['ip', 'did', 'hw'];
let cache = null; // { at, items }

async function build() {
  const since = new Date(Date.now() - DAYS * 864e5);
  const group = (field) => [
    { $match: { [field]: { $nin: ['', null] } } },
    { $group: { _id: '$' + field, users: { $addToSet: '$userId' }, lastAt: { $max: '$lastAt' }, name: { $last: '$name' }, country: { $last: '$country' } } },
    { $match: { 'users.1': { $exists: true } } },
    { $sort: { lastAt: -1 } },
    { $limit: 200 },
  ];
  const [agg, ignores] = await Promise.all([
    UserSeen.aggregate([{ $match: { lastAt: { $gte: since } } }, { $facet: { ip: group('ip'), did: group('did'), hw: group('hw') } }]),
    DetectIgnore.find({}).lean(),
  ]);
  const ignored = new Map(ignores.map((x) => [x.kind + ':' + x.value, x.users]));
  const raw = [];
  for (const kind of KINDS) {
    for (const g of agg[0]?.[kind] || []) {
      const users = g.users.map(String).sort();
      if (ignored.get(kind + ':' + g._id) === users.join(',')) continue;
      raw.push({ kind, value: g._id, users, lastAt: g.lastAt, name: g.name || '', country: g.country || '' });
    }
  }
  const ids = [...new Set(raw.flatMap((x) => x.users))];
  const docs = ids.length ? await User.find({ _id: { $in: ids } }).select('username role banPerm banUntil lastSeenAt').lean() : [];
  const byId = new Map(docs.map((u) => [String(u._id), u]));
  const items = raw
    .map((x) => ({
      ...x,
      banned: bans.active(x.kind, x.value),
      users: x.users.filter((id) => byId.has(id)).map((id) => {
        const u = byId.get(id);
        return {
          id, username: u.username, role: u.role, lastSeenAt: u.lastSeenAt || null,
          banned: !!u.banPerm || (!!u.banUntil && new Date(u.banUntil) > new Date()),
        };
      }),
    }))
    .filter((x) => x.users.length > 1);
  items.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  return items;
}

async function items(fresh) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  cache = { at: Date.now(), items: await build() };
  return cache.items;
}

// GET /admin/detect/count — для красного кружка на кнопке меню
router.get('/detect/count', auth, adminOnly, async (req, res) => {
  res.json({ count: (await items(false)).length });
});

// GET /admin/detect — список совпадений (новые сверху)
router.get('/detect', auth, adminOnly, async (req, res) => {
  const list = await items(req.query.fresh === '1');
  res.json({ items: list, days: DAYS });
});

// POST /admin/detect/ignore { kind, value, users: [id] } — «Игнорировать» (пока не добавится новый аккаунт)
router.post('/detect/ignore', auth, adminOnly, async (req, res) => {
  const kind = String(req.body?.kind || '');
  const value = String(req.body?.value || '').slice(0, 100);
  const users = Array.isArray(req.body?.users) ? req.body.users.map(String).filter((id) => mongoose.isValidObjectId(id)).sort() : [];
  if (!KINDS.includes(kind) || !value || users.length < 2) return res.status(400).json({ error: req.t('server.error') });
  await DetectIgnore.updateOne({ kind, value }, { $set: { users: users.join(','), by: req.user.username || '', at: new Date() } }, { upsert: true });
  cache = null;
  res.json({ ok: true });
});

module.exports = router;
