// /api/streams/directory — всё для страницы трансляций одним запросом:
// подписки (слева), активные (часы эфира за 30 дней), категории со стримерами, все стримеры (справа).
// Общая часть собирается раз в 15 с и отдаётся всем; подписки — свои у каждого, это один лёгкий запрос
const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const Follow = require('../../models/Follow');
const Category = require('../../models/Category');
const StreamSession = require('../../models/StreamSession');
const auth = require('../../middleware/auth');
const chatBus = require('../../services/chatBus');
const categories = require('../../services/categories');
const streamKeyCache = require('../../services/streamKeyCache');
const fs = require('fs');
const path = require('path');

const SNAP_MS = 15 * 1000;
const MAX_STREAMERS = 2000;
const ACTIVE_DAYS = 30;

let snap = null;
let snapAt = 0;
let snapP = null;

// кадр эфира (делает rtmpServer раз в 30 с); t меняется так же — браузер не держит старый кадр
function thumbUrl(playbackId) {
  const key = playbackId && streamKeyCache.keyByPlaybackId(playbackId);
  if (!key || !fs.existsSync(path.join(process.cwd(), 'media', 'live', key, 'thumb.jpg'))) return null;
  return `/media/live/${encodeURIComponent(playbackId)}/thumb.jpg?t=${Math.floor(Date.now() / 30000)}`;
}

const avatarUrl = (nameLower, rev) => `/api/streamers/${encodeURIComponent(nameLower)}/avatar?v=${Number(rev) || 0}`;

async function buildSnapshot() {
  const rows = await User.aggregate([
    { $match: { streamerNameLower: { $ne: null } } },
    {
      $project: {
        streamerName: 1, streamerNameLower: 1, isLive: 1, liveStartedAt: 1, profileRev: 1, profileViews: 1,
        streamTitle: 1, streamCategoryId: 1, streamPlaybackId: 1, liveNotice: 1,
        hasAvatar: { $gt: ['$streamerAvatarUrl', null] },
      },
    },
    { $sort: { isLive: -1, profileViews: -1, streamerName: 1 } },
    { $limit: MAX_STREAMERS },
  ]);

  const catIds = [...new Set(rows.map((r) => r.streamCategoryId).filter(Boolean))];
  const cats = catIds.length ? await Category.find({ tid: { $in: catIds } }).select('-cover').lean() : [];
  const catById = new Map(cats.map((c) => [c.tid, categories.publicView(c)]));

  const since = new Date(Date.now() - ACTIVE_DAYS * 864e5);
  const hours = await StreamSession.aggregate([
    { $match: { endedAt: { $gte: since } } },
    { $group: { _id: '$streamerId', sec: { $sum: '$sec' } } },
  ]);
  const secById = new Map(hours.map((h) => [String(h._id), h.sec]));

  const now = Date.now();
  const cards = rows.map((r) => {
    const live = !!r.isLive;
    const cat = r.streamCategoryId ? catById.get(r.streamCategoryId) || null : null;
    const liveSec = live && r.liveStartedAt ? Math.max(0, (now - new Date(r.liveStartedAt).getTime()) / 1000) : 0;
    return {
      id: String(r._id), // только для сервера, наружу не уходит
      catId: cat ? r.streamCategoryId : null,
      views: r.profileViews || 0,
      sec: (secById.get(String(r._id)) || 0) + liveSec,
      startedAt: live ? r.liveStartedAt || null : null, // для уведомлений подписчикам
      notice: live ? r.liveNotice || '' : '',
      card: {
        streamerName: r.streamerName,
        avatarUrl: r.hasAvatar ? avatarUrl(r.streamerNameLower, r.profileRev) : null,
        isLive: live,
        viewers: live ? chatBus.viewerCount(r.streamerNameLower, r._id) : 0,
        thumb: live ? thumbUrl(r.streamPlaybackId) : null,
        title: live ? r.streamTitle || '' : '',
        category: cat ? { slug: cat.slug, name: cat.name, ru: cat.ru } : null,
      },
    };
  });

  // эфир первым (по зрителям), потом чаще открываемые профили
  const byPopularity = (a, b) => (b.card.isLive - a.card.isLive) || (b.card.viewers - a.card.viewers) || (b.views - a.views);
  cards.sort(byPopularity);

  const active = cards.filter((c) => c.sec >= 60).sort((a, b) => b.sec - a.sec);

  const groups = new Map();
  for (const c of cards) {
    const cat = c.card.category;
    if (!cat) continue;
    if (!groups.has(cat.slug)) groups.set(cat.slug, { ...catById.get(c.catId), live: 0, list: [] });
    const g = groups.get(cat.slug);
    if (c.card.isLive) g.live += 1;
    g.list.push(c);
  }
  // категории, где сейчас кто-то в эфире, — выше; потом по числу стримеров
  const cats2 = [...groups.values()].sort((a, b) => b.live - a.live || b.list.length - a.list.length);

  return { cards, byId: new Map(cards.map((c) => [c.id, c])), active, cats: cats2, bySlug: groups };
}

async function snapshot() {
  if (snap && Date.now() - snapAt < SNAP_MS) return snap;
  if (!snapP) {
    snapP = buildSnapshot()
      .then((s) => { snap = s; snapAt = Date.now(); return s; })
      .finally(() => { snapP = null; });
  }
  return snapP;
}

const cardsOf = (list, n) => list.slice(0, n).map((c) => c.card);
const catHead = (g) => ({ slug: g.slug, name: g.name, ru: g.ru, cover: g.cover, live: g.live, total: g.list.length });

async function followingOf(user, s) {
  if (!user) return null;
  const rows = await Follow.find({ followerId: user.id }).select('streamerId -_id').limit(500).lean();
  const list = rows.map((r) => s.byId.get(String(r.streamerId))).filter(Boolean).map((c) => c.card);
  return list.sort((a, b) => (b.isLive - a.isLive) || (b.viewers - a.viewers) || a.streamerName.localeCompare(b.streamerName));
}

// GET /streams/live-follows — кто из моих подписок сейчас в эфире (опрос раз в минуту со всех страниц сайта,
// для уведомления «вышел в эфир»). Гостю — пусто, без 401: скрипт просто перестаёт спрашивать
router.get('/live-follows', auth.optional, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ guest: true, list: [] });
    const s = await snapshot();
    const rows = await Follow.find({ followerId: req.user.id }).select('streamerId -_id').limit(500).lean();
    const list = rows
      .map((r) => s.byId.get(String(r.streamerId)))
      .filter((c) => c && c.card.isLive && c.startedAt)
      .map((c) => ({ ...c.card, startedAt: c.startedAt, notice: c.notice }));
    res.json({ list });
  } catch (err) {
    console.error('[GET /streams/live-follows]', err);
    res.status(500).json({ error: req.t('server.error') });
  }
});

// GET /streams/directory                — главная: подписки, активные, категории, все
// GET /streams/directory?view=all|active — полный список
// GET /streams/directory?cat=<slug>      — все стримеры категории
router.get('/directory', auth.optional, async (req, res) => {
  try {
    const s = await snapshot();
    const following = await followingOf(req.user, s);
    res.set('Cache-Control', 'no-store');

    if (req.query.cat) {
      const g = s.bySlug.get(String(req.query.cat));
      if (!g) return res.status(404).json({ error: req.t('server.cat.notFound'), following });
      return res.json({ following, category: catHead(g), list: cardsOf(g.list, 500) });
    }
    if (req.query.view === 'all') return res.json({ following, list: cardsOf(s.cards, 500), total: s.cards.length });
    if (req.query.view === 'active') return res.json({ following, list: cardsOf(s.active, 100) });

    res.json({
      following,
      active: cardsOf(s.active, 30),
      categories: s.cats.slice(0, 30).map((g) => ({ ...catHead(g), streamers: cardsOf(g.list, 20) })),
      all: cardsOf(s.cards, 40),
      total: s.cards.length,
    });
  } catch (err) {
    console.error('[GET /streams/directory]', err);
    res.status(500).json({ error: req.t('server.streamers.listFailed') });
  }
});

module.exports = router;
