const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const User = require('../../models/User');
const Preset = require('../../models/Preset');
const PresetLike = require('../../models/PresetLike');
const PresetAdd = require('../../models/PresetAdd');
const ChatCommand = require('../../models/ChatCommand');
const Reward = require('../../models/Reward');
const rewardsApi = require('./rewards.routes');
const { hasProfanity } = require('../../services/profanity');
const PWStyle = require('../../public/js/pwstyle.js');
const { parseArgsInput, parseCommandLine, buildReply } = require('../../services/chatCommands');

const PAGE_LIMIT = 24;
const MAX_PUBLISHED = 20;
const MAX_COMMANDS = 50;
const LIKE_MIN_AGE_MS = 24 * 60 * 60 * 1000; // лайкать можно аккаунтам старше суток
const COMMAND_NAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ]{1,20}$/;

const TYPES = ['style', 'command', 'reward'];
const isId = (s) => /^[a-f0-9]{24}$/i.test(String(s));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 64);
const cleanCmdName = (v) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();

// ---------- ограничитель частоты ----------
const hits = new Map();
function limited(userId, max = 40, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(userId, arr); return true; }
  arr.push(now);
  hits.set(userId, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
const rate = (req, res, next) =>
  limited(String(req.user.id)) ? res.status(429).json({ error: req.t('server.presets.tooOften') }) : next();

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id).select('streamerName streamerNameLower createdAt role');
  if (!me || !me.streamerName) return res.status(403).json({ error: req.t('server.presets.noStreamer') });
  req.me = me;
  next();
}

// ---------- проверка данных ----------
function cleanMeta(body) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  // error — ключ словаря (перевод — req.t)
  if (name.length < 3 || name.length > 40) return { error: 'server.presets.nameLen' };
  if (/[\u0000-\u001f]/.test(name)) return { error: 'server.presets.nameChars' };
  const description = String(body?.description ?? '').trim();
  if (description.length > 200) return { error: 'server.presets.descLen' };
  return { name, description };
}

// пре-сет награды не должен повторять стартовые (они и так есть у всех каналов)
const squash = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
const STARTER_TITLES = new Set(['highlight', 'coinflip', 'hello'].flatMap((k) => ['ru', 'en'].map((l) => squash(i18n.t(l, `server.rewards.starter.${k}.title`)))));

function cleanReward(data) {
  const title = String(data?.title ?? '').trim().replace(/\s+/g, ' ');
  if (title.length < 1 || title.length > 45) return { error: 'server.rewards.titleLen' };
  if (hasProfanity(title)) return { error: 'server.rewards.titleBad' };
  if (STARTER_TITLES.has(squash(title))) return { error: 'server.presets.rewardStarter' };
  const description = String(data?.description ?? '').trim().slice(0, 200);
  if (hasProfanity(description)) return { error: 'server.rewards.descBad' };
  const cost = Math.round(Number(data?.cost));
  if (!Number.isFinite(cost) || cost < rewardsApi.COST_MIN || cost > rewardsApi.COST_MAX) return { error: 'server.rewards.badCost' };
  const reply = String(data?.reply ?? '').trim().replace(/\s+/g, ' ');
  if (reply.length > rewardsApi.REPLY_MAX) return { error: 'server.rewards.replyLen', vars: { n: rewardsApi.REPLY_MAX } };
  if (hasProfanity(reply.replace(/\{\w+\}/g, ' '))) return { error: 'server.rewards.replyBad' };
  const color = rewardsApi.COLOR_RE.test(data?.color) ? data.color : '#7c3aed';
  return { data: { title, description, cost, color, needInput: !!data?.needInput, reply } };
}

function cleanData(type, data) {
  if (type === 'reward') return cleanReward(data);
  if (type === 'style') {
    const s = PWStyle.sanitize(data);
    if (PWStyle.isDefault(s)) return { error: 'server.presets.defaultStyle' };
    return { data: s };
  }
  const name = cleanCmdName(data?.name);
  if (!COMMAND_NAME_RE.test(name)) return { error: 'server.presets.cmdName' };
  const response = String(data?.response ?? '').trim();
  if (!response) return { error: 'server.presets.cmdEmpty' };
  if (response.length > 400) return { error: 'server.presets.cmdLong' };
  const a = parseArgsInput(data?.args);
  if (a.error) return { error: a.error, vars: a.vars };
  return { data: { name, response, args: a.args } };
}

// ---------- ответ клиенту ----------
function sampleArgs(args, lang) {
  return (args || []).filter((a) => !a.optional).map((a) => (/чис|кол|num|count|^n$/i.test(a.name) ? '30' : i18n.t(lang, 'server.cmd.sampleArg'))).join(' ');
}

// пример ответа бота награды: переменные — как у настоящей покупки
function rewardPreview(p, lang) {
  const d = p.data || {};
  return d.reply ? rewardsApi.fillReply(d.reply, {
    user: 'Viewer1', reward: d.title, cost: d.cost, message: d.needInput ? i18n.t(lang, 'server.cmd.sampleArg') : '',
    points: i18n.t(lang, 'server.rewards.pointsDefault'), balance: 1250,
  }) : '';
}

function cmdPreview(p, lang) {
  const d = p.data;
  const line = ('!' + d.name + ' ' + sampleArgs(d.args, lang)).trim();
  let text = '…';
  try {
    const parsed = parseCommandLine(line) || { name: d.name, argv: [] };
    text = buildReply({ name: d.name, args: d.args, response: d.response }, parsed.argv, {
      user: 'Viewer1', streamer: p.authorName, title: i18n.t(lang, 'server.cmd.sampleTitle'), viewers: 12,
      uptime: i18n.t(lang, 'server.cmd.uptimeHM', { h: 1, m: '05' }), count: 7, lang,
    }).text;
  } catch (_) {}
  return { line, text };
}

async function decorate(rows, me, lang) {
  const ids = rows.map((r) => r._id);
  const [likes, adds] = await Promise.all([
    PresetLike.find({ userId: me._id, presetId: { $in: ids } }).select('presetId').lean(),
    PresetAdd.find({ userId: me._id, presetId: { $in: ids } }).select('presetId').lean(),
  ]);
  const liked = new Set(likes.map((x) => String(x.presetId)));
  const added = new Set(adds.map((x) => String(x.presetId)));
  const isAdmin = require('../../services/roles').isAdminRole(me.role);

  return rows.map((p) => {
    const id = String(p._id);
    const mine = String(p.authorId) === String(me._id);
    return {
      id,
      type: p.type,
      name: p.name,
      description: p.description || '',
      authorName: p.authorName,
      likes: p.likes || 0,
      adds: p.adds || 0,
      createdAt: p.createdAt,
      data: p.data,
      preview: p.type === 'command' ? cmdPreview(p, lang) : p.type === 'reward' ? { text: rewardPreview(p, lang) } : undefined,
      mine,
      liked: liked.has(id),
      added: added.has(id),
      canDelete: mine || isAdmin,
    };
  });
}

// ---------- список ----------
// GET /presets?type=style|command|reward&sort=likes|adds|new&q=текст&page=1
router.get('/', auth, requireStreamer, async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : null;
  const sorts = {
    likes: { likes: -1, adds: -1, createdAt: -1 },
    adds: { adds: -1, likes: -1, createdAt: -1 },
    new: { createdAt: -1 },
  };
  const sort = Object.hasOwn(sorts, req.query.sort) ? sorts[req.query.sort] : sorts.likes;
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const page = Math.min(200, Math.max(1, parseInt(req.query.page, 10) || 1));

  const filter = {};
  if (type) filter.type = type;
  if (q) filter.nameLower = { $regex: escapeRegex(q) };

  const total = await Preset.countDocuments(filter);
  const rows = await Preset.find(filter).sort(sort).skip((page - 1) * PAGE_LIMIT).limit(PAGE_LIMIT).lean();
  res.json({ items: await decorate(rows, req.me, req.lang), page, total, hasMore: page * PAGE_LIMIT < total });
});

// GET /presets/mine — мои опубликованные и добавленные
router.get('/mine', auth, requireStreamer, async (req, res) => {
  const published = await Preset.find({ authorId: req.me._id }).sort({ createdAt: -1 }).limit(MAX_PUBLISHED).lean();
  const recs = await PresetAdd.find({ userId: req.me._id }).sort({ createdAt: -1 }).limit(100).select('presetId').lean();
  const rows = await Preset.find({ _id: { $in: recs.map((r) => r.presetId) } }).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const addedRows = recs.map((r) => byId.get(String(r.presetId))).filter(Boolean);
  res.json({
    published: await decorate(published, req.me, req.lang),
    added: await decorate(addedRows, req.me, req.lang),
  });
});

// ---------- публикация ----------
router.post('/', auth, requireStreamer, rate, async (req, res) => {
  const type = req.body?.type;
  if (!TYPES.includes(type)) return res.status(400).json({ error: req.t('server.presets.unknownType') });

  const meta = cleanMeta(req.body);
  if (meta.error) return res.status(400).json({ error: req.t(meta.error) });
  const d = cleanData(type, req.body?.data);
  if (d.error) return res.status(400).json({ error: req.t(d.error, d.vars) });

  if ((await Preset.countDocuments({ authorId: req.me._id })) >= MAX_PUBLISHED) {
    return res.status(400).json({ error: req.t('server.presets.max', { n: MAX_PUBLISHED }) });
  }
  if (await Preset.exists({ authorId: req.me._id, type, nameLower: meta.name.toLowerCase() })) {
    return res.status(409).json({ error: req.t('server.presets.nameTaken') });
  }

  const p = await Preset.create({
    type, name: meta.name, description: meta.description, data: d.data,
    authorId: req.me._id, authorName: req.me.streamerName,
  });
  res.status(201).json({ id: String(p._id) });
});

// ---------- удаление ----------
router.delete('/:id', auth, requireStreamer, rate, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
  const p = await Preset.findById(req.params.id).select('authorId');
  if (!p) return res.status(404).json({ error: req.t('server.presets.notFound') });
  if (String(p.authorId) !== String(req.me._id) && !require('../../services/roles').isAdminRole(req.me.role)) {
    return res.status(403).json({ error: req.t('server.presets.notYours') });
  }
  await Promise.all([
    PresetLike.deleteMany({ presetId: p._id }),
    PresetAdd.deleteMany({ presetId: p._id }),
    p.deleteOne(),
  ]);
  res.json({ ok: true });
});

// ---------- лайк ----------
router.put('/:id/like', auth, requireStreamer, rate, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
  const p = await Preset.findById(req.params.id).select('authorId likes');
  if (!p) return res.status(404).json({ error: req.t('server.presets.notFound') });
  if (String(p.authorId) === String(req.me._id)) return res.status(400).json({ error: req.t('server.presets.selfLike') });

  const on = !!req.body?.on;
  let likes = p.likes;

  if (on) {
    if (Date.now() - new Date(req.me.createdAt).getTime() < LIKE_MIN_AGE_MS) {
      return res.status(403).json({ error: req.t('server.presets.likeAge') });
    }
    try {
      await PresetLike.create({ presetId: p._id, userId: req.me._id });
      likes = (await Preset.findByIdAndUpdate(p._id, { $inc: { likes: 1 } }, { new: true }).select('likes')).likes;
    } catch (e) {
      if (e.code !== 11000) throw e; // уже лайкнуто
    }
  } else {
    const r = await PresetLike.deleteOne({ presetId: p._id, userId: req.me._id });
    if (r.deletedCount) likes = (await Preset.findByIdAndUpdate(p._id, { $inc: { likes: -1 } }, { new: true }).select('likes')).likes;
  }
  res.json({ liked: on, likes: Math.max(0, likes) });
});

// ---------- добавить себе ----------
router.post('/:id/add', auth, requireStreamer, rate, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
  const p = await Preset.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: req.t('server.presets.notFound') });
  if (String(p.authorId) === String(req.me._id)) return res.status(400).json({ error: req.t('server.presets.own') });
  if (await PresetAdd.exists({ presetId: p._id, userId: req.me._id })) {
    return res.status(409).json({ error: req.t('server.presets.alreadyAdded') });
  }

  let commandId = null;
  let rewardId = null;
  if (p.type === 'reward') {
    const d = cleanReward(p.data); // данные старого пре-сета проверяем заново
    if (d.error) return res.status(400).json({ error: req.t(d.error, d.vars) });
    if ((await Reward.countDocuments({ streamerId: req.me._id })) >= rewardsApi.MAX_REWARDS) {
      return res.status(400).json({ error: req.t('server.rewards.limit', { n: rewardsApi.MAX_REWARDS }) });
    }
    const r = await Reward.create({
      ...d.data, streamerId: req.me._id, streamerNameLower: req.me.streamerNameLower,
      slug: await rewardsApi.uniqueSlug(req.me._id, d.data.title),
    });
    rewardId = r._id;
  } else if (p.type === 'command') {
    const nameLower = req.me.streamerNameLower;
    if ((await ChatCommand.countDocuments({ streamerNameLower: nameLower })) >= MAX_COMMANDS) {
      return res.status(400).json({ error: req.t('server.presets.maxCommands', { n: MAX_COMMANDS }) });
    }
    const name = cleanCmdName(req.body?.name) || p.data.name;
    if (!COMMAND_NAME_RE.test(name)) return res.status(400).json({ error: req.t('server.presets.cmdName') });
    try {
      const cmd = await ChatCommand.create({
        streamerNameLower: nameLower, name, response: p.data.response, args: p.data.args,
      });
      commandId = cmd._id;
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: req.t('server.presets.cmdExists', { name }) });
      throw e;
    }
  }

  try {
    await PresetAdd.create({ presetId: p._id, userId: req.me._id, commandId, rewardId });
  } catch (e) {
    if (commandId) await ChatCommand.deleteOne({ _id: commandId });
    if (rewardId) await Reward.deleteOne({ _id: rewardId });
    if (e.code === 11000) return res.status(409).json({ error: req.t('server.presets.alreadyAdded') });
    throw e;
  }

  const upd = await Preset.findByIdAndUpdate(p._id, { $inc: { adds: 1 } }, { new: true }).select('adds');
  res.status(201).json({ added: true, adds: upd ? upd.adds : (p.adds || 0) + 1, data: p.type === 'style' ? p.data : undefined, rewardId: rewardId ? String(rewardId) : undefined });
});

// ---------- убрать у себя ----------
router.delete('/:id/add', auth, requireStreamer, rate, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: req.t('server.badId') });
  const rec = await PresetAdd.findOneAndDelete({ presetId: req.params.id, userId: req.me._id });
  if (!rec) return res.json({ added: false });

  if (rec.commandId) {
    await ChatCommand.deleteOne({ _id: rec.commandId, streamerNameLower: req.me.streamerNameLower });
  }
  if (rec.rewardId) await Reward.deleteOne({ _id: rec.rewardId, streamerId: req.me._id });
  const upd = await Preset.findByIdAndUpdate(req.params.id, { $inc: { adds: -1 } }, { new: true }).select('adds');
  res.json({ added: false, adds: Math.max(0, upd?.adds || 0) });
});

module.exports = router;