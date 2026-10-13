// Стрим-поинты и награды.
//   pointsRouter  → /api/points/:name — зритель: баланс и награды, бонус раз в 5 минут, покупка
//   rewardsRouter → /api/rewards — студия (/studio…) и API для ботов (/:канал/:награда, ключ событий в Authorization)
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const points = require('../../services/points');
const alerts = require('../../services/alerts');
const chatBus = require('../../services/chatBus');
const chatFilter = require('../../services/chatFilter');
const { hasProfanity, toLatin } = require('../../services/profanity');
const Reward = require('../../models/Reward');
const Redemption = require('../../models/Redemption');
const AlertSettings = require('../../models/AlertSettings');
const AlertMedia = require('../../models/AlertMedia');
const StreamChatMessage = require('../../models/StreamChatMessage');
const User = require('../../models/User');
const ChannelBan = require('../../models/ChannelBan');
const ChannelTimeout = require('../../models/ChannelTimeout');

const pointsRouter = express.Router();
const rewardsRouter = express.Router();
const ID_RE = /^[a-f0-9]{24}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_REWARDS = 30;
const RENAME_MS = 30 * 24 * 3600 * 1000;
const COST_MIN = 1, COST_MAX = 1000000;
const REPLY_MAX = 200;
// переменные ответа бота: {user} купивший, {reward} награда, {cost} цена, {message} текст зрителя, {points} название поинтов, {balance} остаток
const REPLY_VARS = ['user', 'reward', 'cost', 'message', 'points', 'balance'];
const fillReply = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (REPLY_VARS.includes(k) && vars[k] !== undefined ? String(vars[k]) : m));

const iconUrl = (ref) => (/^media:[a-f0-9]{24}$/i.test(ref || '') ? '/api/alerts/media/' + ref.slice(6) : null);
const viewerReward = (r) => ({
  id: String(r._id), title: r.title, description: r.description, cost: r.cost, color: r.color,
  image: iconUrl(r.image), needInput: !!r.needInput,
});
const studioReward = (r) => ({ ...viewerReward(r), slug: r.slug, kind: r.kind, enabled: !!r.enabled, imageRef: r.image || null, reply: r.reply || '' });

const limiter = (limit, windowMs) => rateLimit({
  windowMs, limit, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false,
  message: (req) => ({ error: req.t('server.points.tooMany') }),
});

async function channelOf(req, res) {
  const nameLower = String(req.params.name || req.params.channel || '').trim().toLowerCase();
  const s = nameLower && await User.findOne({ streamerNameLower: nameLower })
    .select('_id streamerName streamerNameLower isLive liveStartedAt pointsName pointsIcon chatFilter').lean();
  if (!s) { res.status(404).json({ error: req.t('server.streamers.notFound') }); return null; }
  return s;
}

// ================= зритель =================

// GET /points/:name — название и значок поинтов, награды, мой баланс и когда следующий бонус
pointsRouter.get('/:name', auth.optional, async (req, res) => {
  const s = await channelOf(req, res);
  if (!s) return;
  const rewards = await Reward.find({ streamerId: s._id, enabled: true }).sort({ cost: 1 }).lean();
  const out = {
    pointsName: s.pointsName || null, // null — «стрим-поинты» на языке зрителя
    icon: iconUrl(s.pointsIcon),
    rewards: rewards.map(viewerReward),
    isLive: !!s.isLive,
    own: !!req.user && String(req.user.id) === String(s._id),
    balance: 0,
    nextClaimAt: null,
  };
  if (req.user) {
    const acc = await points.account(s._id, req.user.id);
    out.balance = acc.balance;
    out.nextClaimAt = out.own ? null : points.nextClaimAt(s.streamerNameLower, String(req.user.id), !!s.isLive, acc.lastClaimAt, s.liveStartedAt);
  }
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

// POST /points/:name/claim — забрать бонус (раз в 5 минут просмотра)
pointsRouter.post('/:name/claim', auth, limiter(10, 60 * 1000), async (req, res) => {
  const s = await channelOf(req, res);
  if (!s) return;
  try {
    const r = await points.claim(s, req.user.id);
    // событие «накопил стрим-поинты»: баланс перешёл порог из настроек события
    const cfg = alerts.eventCfg(await alerts.settings(s.streamerNameLower).catch(() => null), 'pointsGoal');
    if (cfg && r.prevBalance < cfg.param && r.balance >= cfg.param) {
      alerts.fire(s.streamerNameLower, 'pointsGoal', { name: req.user.username, points: cfg.param }).catch(() => {});
    }
    res.json({ added: r.added, balance: r.balance, nextClaimAt: r.nextClaimAt });
  } catch (e) {
    if (!e.i18nKey) console.error('[points claim]', e);
    res.status(400).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.points.failed') });
  }
});

// сообщение в чат канала от имени сервера (выделенное сообщение зрителя или ответ бота)
async function chatPost(s, doc) {
  const msg = await StreamChatMessage.create({ streamerNameLower: s.streamerNameLower, ...doc });
  chatBus.emitMessage(s.streamerNameLower, {
    _id: msg._id, senderId: msg.senderId, senderUsername: msg.senderUsername, text: msg.text,
    masked: chatFilter.mask(msg.text, s.chatFilter || 0), deleted: false, createdAt: msg.createdAt,
    external: !!msg.external, source: msg.source || null, highlight: !!msg.highlight, isOwner: false,
  });
}

// POST /points/:name/redeem { rewardId, message } — купить награду
pointsRouter.post('/:name/redeem', auth, limiter(20, 60 * 1000), async (req, res) => {
  const s = await channelOf(req, res);
  if (!s) return;
  const rid = String(req.body?.rewardId || '');
  if (!ID_RE.test(rid)) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  const reward = await Reward.findOne({ _id: rid, streamerId: s._id, enabled: true }).lean();
  if (!reward) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  const message = String(req.body?.message || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (reward.needInput && !message) return res.status(400).json({ error: req.t('server.rewards.needText') });
  // забаненный или в таймауте ничего не покупает (иначе «Выделить сообщение» — обход бана)
  const [ban, to] = await Promise.all([
    ChannelBan.exists({ streamerNameLower: s.streamerNameLower, userId: req.user.id }),
    ChannelTimeout.exists({ streamerNameLower: s.streamerNameLower, userId: req.user.id, until: { $gt: new Date() } }),
  ]);
  if (ban || to) return res.status(403).json({ error: req.t('server.rewards.banned') });

  const acc = await points.spend(s._id, req.user.id, reward.cost);
  if (!acc) return res.status(400).json({ error: req.t('server.rewards.notEnough') });

  const red = await Redemption.create({
    streamerId: s._id, rewardId: reward._id, rewardSlug: reward.slug, rewardTitle: reward.title,
    userId: req.user.id, username: req.user.username, cost: reward.cost, message,
  });

  // действие стартовых наград
  if (reward.kind === 'highlight') {
    await chatPost(s, { senderId: req.user.id, senderUsername: req.user.username, text: message, highlight: true });
  } else if (reward.kind === 'coinflip') {
    const side = i18n.t(req.lang, Math.random() < 0.5 ? 'server.rewards.heads' : 'server.rewards.tails');
    await chatPost(s, { senderId: null, senderUsername: 'Бот', text: i18n.t(req.lang, 'server.rewards.coinflipResult', { name: req.user.username, side }), external: true, source: 'bot' });
  }
  // свой ответ бота в чат (маску фильтра слов накладывает chatPost)
  const reply = fillReply(reward.reply, {
    user: req.user.username, reward: reward.title, cost: reward.cost, message,
    points: s.pointsName || i18n.t(req.lang, 'server.rewards.pointsDefault'), balance: acc.balance,
  }).trim().slice(0, 500);
  if (reply) await chatPost(s, { senderId: null, senderUsername: 'Бот', text: reply, external: true, source: 'bot' });
  // в OBS и ботам: текст зрителя на экран — с маской фильтра слов канала
  alerts.fire(s.streamerNameLower, 'reward', {
    name: req.user.username, reward: reward.title, cost: reward.cost, message: chatFilter.mask(message, s.chatFilter || 0) || message,
    rewardSlug: reward.slug, redemptionId: String(red._id),
  }).catch(() => {});
  res.json({ balance: acc.balance, redemptionId: String(red._id) });
});

// ================= студия: награды канала =================

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id).select('_id streamerName streamerNameLower pointsName pointsNameAt pointsIcon rewardsSeeded').lean();
  if (!me || !me.streamerName) return res.status(403).json({ error: req.t('server.presets.noStreamer') });
  req.me = me;
  next();
}

function slugify(title) {
  return toLatin(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'reward';
}
async function uniqueSlug(streamerId, title, exceptId) {
  const base = slugify(title);
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const taken = await Reward.exists({ streamerId, slug, ...(exceptId && { _id: { $ne: exceptId } }) });
    if (!taken) return slug;
  }
  return base + '-' + Date.now().toString(36);
}

// поля награды из запроса (для создания — все обязательные, для правки — только присланные)
async function cleanRewardBody(req, partial) {
  const b = req.body || {};
  const out = {};
  if (!partial || b.title !== undefined) {
    const title = String(b.title || '').trim().replace(/\s+/g, ' ');
    if (title.length < 1 || title.length > 45) throw i18n.err('server.rewards.titleLen');
    if (hasProfanity(title)) throw i18n.err('server.rewards.titleBad');
    out.title = title;
  }
  if (!partial || b.description !== undefined) {
    out.description = String(b.description || '').trim().slice(0, 200);
    if (hasProfanity(out.description)) throw i18n.err('server.rewards.descBad');
  }
  if (!partial || b.cost !== undefined) {
    const cost = Math.round(Number(b.cost));
    if (!Number.isFinite(cost) || cost < COST_MIN || cost > COST_MAX) throw i18n.err('server.rewards.badCost');
    out.cost = cost;
  }
  if (b.color !== undefined) out.color = COLOR_RE.test(b.color) ? b.color : '#7c3aed';
  if (b.needInput !== undefined) out.needInput = !!b.needInput;
  if (b.reply !== undefined) {
    const reply = String(b.reply || '').trim().replace(/\s+/g, ' ');
    if (reply.length > REPLY_MAX) throw i18n.err('server.rewards.replyLen', { n: REPLY_MAX });
    if (hasProfanity(reply.replace(/\{\w+\}/g, ' '))) throw i18n.err('server.rewards.replyBad');
    out.reply = reply;
  }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.image !== undefined) {
    if (!b.image) out.image = null;
    else if (/^media:[a-f0-9]{24}$/i.test(b.image) && await AlertMedia.exists({ _id: b.image.slice(6), userId: req.me._id, kind: 'image' })) out.image = b.image;
    else throw i18n.err('server.rewards.badImage');
  }
  return out;
}

// GET /rewards/studio — награды (и выключенные), поинты, раскладка, последние покупки
rewardsRouter.get('/studio', auth, requireStreamer, async (req, res) => {
  const me = req.me;
  if (!me.rewardsSeeded) {
    await points.seedStarters(me, req.lang);
    await User.updateOne({ _id: me._id }, { $set: { rewardsSeeded: true } });
  }
  const [rewards, settings, reds] = await Promise.all([
    Reward.find({ streamerId: me._id }).sort({ createdAt: 1 }).lean(),
    AlertSettings.findOne({ userId: me._id }).select('key rewardsLayout').lean(),
    Redemption.find({ streamerId: me._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const at = me.pointsNameAt ? new Date(me.pointsNameAt).getTime() : 0;
  res.json({
    rewards: rewards.map(studioReward),
    max: MAX_REWARDS,
    points: { name: me.pointsName || null, nextRenameAt: at && at + RENAME_MS > Date.now() ? new Date(at + RENAME_MS) : null, icon: iconUrl(me.pointsIcon), iconRef: me.pointsIcon || null, claimEvery: points.CLAIM_MS / 60000, amount: points.AMOUNT },
    keyMasked: settings?.key ? '••••••••' + settings.key.slice(-4) : null,
    layout: settings?.rewardsLayout || null,
    redemptions: reds.map((r) => ({ id: String(r._id), slug: r.rewardSlug, title: r.rewardTitle, username: r.username, cost: r.cost, message: r.message, status: r.status, at: r.createdAt })),
  });
});

// POST /rewards/studio — новая награда
rewardsRouter.post('/studio', auth, requireStreamer, async (req, res) => {
  try {
    if ((await Reward.countDocuments({ streamerId: req.me._id })) >= MAX_REWARDS) throw i18n.err('server.rewards.limit', { n: MAX_REWARDS });
    const body = await cleanRewardBody(req, false);
    const r = await Reward.create({ ...body, streamerId: req.me._id, streamerNameLower: req.me.streamerNameLower, slug: await uniqueSlug(req.me._id, body.title) });
    res.status(201).json({ reward: studioReward(r) });
  } catch (e) {
    if (!e.i18nKey) console.error('[POST /rewards/studio]', e);
    res.status(400).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.error') });
  }
});

// PUT /rewards/studio/:id — правка (автосохранение): только присланные поля
rewardsRouter.put('/studio/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  try {
    const set = await cleanRewardBody(req, true);
    // «Выделить сообщение» и «Привет на экране» без текста не работают
    if (set.needInput === false && await Reward.exists({ _id: req.params.id, streamerId: req.me._id, kind: { $in: ['highlight', 'hello'] } })) delete set.needInput;
    const r = await Reward.findOneAndUpdate({ _id: req.params.id, streamerId: req.me._id }, { $set: set }, { new: true }).lean();
    if (!r) return res.status(404).json({ error: req.t('server.rewards.notFound') });
    res.json({ reward: studioReward(r) });
  } catch (e) {
    if (!e.i18nKey) console.error('[PUT /rewards/studio]', e);
    res.status(400).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.error') });
  }
});

rewardsRouter.delete('/studio/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  await Reward.deleteOne({ _id: req.params.id, streamerId: req.me._id });
  res.json({ status: 'ok' });
});

// PUT /rewards/studio-points { name } (раз в 30 дней) | { icon: 'media:<id>' | null }
rewardsRouter.put('/studio-points', auth, requireStreamer, async (req, res) => {
  const me = req.me;
  const set = {};
  if (req.body?.name !== undefined) {
    const at = me.pointsNameAt ? new Date(me.pointsNameAt).getTime() : 0;
    if (at && at + RENAME_MS > Date.now()) return res.status(400).json({ error: req.t('server.points.renameWait', { date: new Date(at + RENAME_MS).toLocaleDateString(req.lang === 'ru' ? 'ru-RU' : 'en-US') }) });
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 24) return res.status(400).json({ error: req.t('server.points.nameLen') });
    if (hasProfanity(name)) return res.status(400).json({ error: req.t('server.points.nameBad') });
    set.pointsName = name;
    set.pointsNameAt = new Date();
  }
  if (req.body?.icon !== undefined) {
    const ref = req.body.icon;
    if (ref && !(/^media:[a-f0-9]{24}$/i.test(ref) && await AlertMedia.exists({ _id: ref.slice(6), userId: me._id, kind: 'image' }))) {
      return res.status(400).json({ error: req.t('server.rewards.badImage') });
    }
    set.pointsIcon = ref || null;
  }
  if (!Object.keys(set).length) return res.json({ status: 'ok' });
  await User.updateOne({ _id: me._id }, { $set: set });
  res.json({ status: 'ok', name: set.pointsName, icon: set.pointsIcon !== undefined ? iconUrl(set.pointsIcon) : undefined });
});

// раскладка карточек наград
rewardsRouter.put('/studio-layout', auth, requireStreamer, async (req, res) => {
  const panels = {};
  for (const [id, r] of Object.entries(req.body?.panels || {}).slice(0, MAX_REWARDS + 2)) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || !r || typeof r !== 'object') continue;
    const n = (v, min, max) => Math.round(Math.min(max, Math.max(min, Number(v) || 0)));
    panels[id] = { x: n(r.x, 0, 4000), y: n(r.y, 0, 8000), w: n(r.w, 220, 1200), h: n(r.h, 200, 1200) };
  }
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { rewardsLayout: { panels } }, $setOnInsert: { streamerNameLower: req.me.streamerNameLower } }, { upsert: true });
  res.json({ status: 'ok' });
});
rewardsRouter.delete('/studio-layout', auth, requireStreamer, async (req, res) => {
  await AlertSettings.updateOne({ userId: req.me._id }, { $set: { rewardsLayout: null } });
  res.json({ status: 'ok' });
});

// PATCH /rewards/studio-redemptions/:id { status: done | refunded } — из очереди в студии
async function setStatus(streamerId, rid, status, slug) {
  // slug — только для API ботов: покупка должна быть именно этой награды
  const q = { _id: rid, streamerId, status: 'new', ...(slug && { rewardSlug: slug }) };
  const red = await Redemption.findOneAndUpdate(q, { $set: { status } }, { new: true }).lean();
  if (red && status === 'refunded') await points.refund(streamerId, red.userId, red.cost);
  return red;
}
rewardsRouter.patch('/studio-redemptions/:id', auth, requireStreamer, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  const status = req.body?.status === 'refunded' ? 'refunded' : 'done';
  const red = await setStatus(req.me._id, req.params.id, status);
  if (!red) return res.status(409).json({ error: req.t('server.rewards.alreadyHandled') });
  res.json({ status: red.status });
});

// ================= API для ботов: ключ событий в Authorization: Bearer <ключ> =================

async function botAuth(req, res, next) {
  const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const doc = /^[A-Za-z0-9_-]{20,80}$/.test(key) ? await AlertSettings.findOne({ key }).select('userId streamerNameLower').lean() : null;
  if (!doc || doc.streamerNameLower !== String(req.params.channel || '').toLowerCase()) {
    return res.status(401).json({ error: req.t('server.rewards.badKey') });
  }
  req.botStreamerId = doc.userId;
  next();
}

// GET /rewards/:channel/:slug?status=new&after=<ISO> — покупки награды (новые сверху, до 100)
rewardsRouter.get('/:channel/:slug', botAuth, async (req, res) => {
  const q = { streamerId: req.botStreamerId, rewardSlug: String(req.params.slug) };
  if (['new', 'done', 'refunded'].includes(req.query.status)) q.status = req.query.status;
  const after = req.query.after ? new Date(String(req.query.after)) : null;
  if (after && !isNaN(after)) q.createdAt = { $gt: after };
  const list = await Redemption.find(q).sort({ createdAt: -1 }).limit(100).lean();
  res.set('Cache-Control', 'no-store');
  res.json(list.map((r) => ({ id: String(r._id), reward: r.rewardSlug, user: r.username, userId: String(r.userId), cost: r.cost, message: r.message, status: r.status, createdAt: r.createdAt })));
});

// POST /rewards/:channel/:slug/:id/done | /refund — бот отметил покупку
rewardsRouter.post('/:channel/:slug/:id/:action', botAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id) || !['done', 'refund'].includes(req.params.action)) return res.status(404).json({ error: req.t('server.rewards.notFound') });
  const red = await setStatus(req.botStreamerId, req.params.id, req.params.action === 'refund' ? 'refunded' : 'done', String(req.params.slug));
  if (!red) return res.status(409).json({ error: req.t('server.rewards.alreadyHandled') });
  res.json({ id: String(red._id), status: red.status });
});

module.exports = { pointsRouter, rewardsRouter, COST_MIN, COST_MAX, COLOR_RE, MAX_REWARDS, REPLY_MAX, REPLY_VARS, fillReply, uniqueSlug };
