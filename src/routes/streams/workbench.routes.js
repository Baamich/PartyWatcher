const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const User = require('../../models/User');
const ChannelBan = require('../../models/ChannelBan');
const WorkbenchLayout = require('../../models/WorkbenchLayout');
const ChannelActionLog = require('../../models/ChannelActionLog');
const auth = require('../../middleware/auth');
const streamKeyCache = require('../../services/streamKeyCache');
const StreamVod = require('../../models/StreamVod');
const chatBus = require('../../services/chatBus');

// Проверяем реальность по диску: обновляется ли index.m3u8 прямо сейчас,
// а не полагаемся только на флаг isLive в базе (который мог не долететь/не записаться).
function isCurrentlyLive(streamKey) {
  if (!streamKey) return false;
  const base = path.join(process.cwd(), 'media', 'live', streamKey);
  for (const rel of ['source/index.m3u8', '720/index.m3u8', '480/index.m3u8']) {
    try {
      if (Date.now() - fs.statSync(path.join(base, rel)).mtimeMs < 15000) return true;
    } catch (_) {}
  }
  return false;
}

async function requireStreamer(req, res, next) {
  const me = await User.findById(req.user.id);
  if (!me || !me.streamerName) return res.status(403).json({ error: 'У тебя ещё нет профиля стримера' });
  req.streamerUser = me;
  next();
}

function maskKey(key) {
  if (!key) return null;
  return '•'.repeat(Math.max(key.length - 4, 8)) + key.slice(-4);
}

function maskChatKey(key) {
  if (!key) return null;
  return '****' + key.slice(-4);
}

// GET /workbench/me — текущие настройки (ключ только замаскированный)
router.get('/me', auth, requireStreamer, async (req, res) => {
  const me = req.streamerUser;
  const liveNow = isCurrentlyLive(me.streamKey);

  // подчищаем рассинхрон флага в базе, раз уж всё равно проверили диск
  if (liveNow !== me.isLive) {
    me.isLive = liveNow;
    // liveStartedAt чистит только rtmpServer.finalizeStop — не диск
    await me.save();
  }

  res.json({
    streamTitle: me.streamTitle || '',
    streamDescription: me.streamDescription || '',
    streamKeyMasked: maskKey(me.streamKey),
    chatApiKeyMasked: maskChatKey(me.chatApiKey),
    streamPlaybackId: me.streamPlaybackId || null,
    isLive: liveNow,
    // отдаём всегда, пока finalizeStop не обнулил — чтобы таймер пережил краткий offline
    liveStartedAt: me.liveStartedAt || null,
  });
});



// POST /workbench/stream-key/generate — сгенерировать (или перевыпустить) пару ключ+playbackId
router.post('/stream-key/generate', auth, requireStreamer, async (req, res) => {
  const oldKey = req.streamerUser.streamKey;
  const key = crypto.randomBytes(20).toString('hex');
  const playbackId = crypto.randomBytes(12).toString('hex');

  req.streamerUser.streamKey = key;
  req.streamerUser.streamPlaybackId = playbackId;
  await req.streamerUser.save();

  streamKeyCache.set(oldKey, key, {
    userId: String(req.streamerUser._id),
    playbackId,
    streamerNameLower: req.streamerUser.streamerNameLower,
  });

  res.json({ streamKey: key, streamKeyMasked: maskKey(key) });
});

// POST /workbench/stream-key/reveal — получить полный ключ для копирования
router.post('/stream-key/reveal', auth, requireStreamer, async (req, res) => {
  if (!req.streamerUser.streamKey) return res.status(404).json({ error: 'Ключ ещё не создан' });
  res.json({ streamKey: req.streamerUser.streamKey });
});

// PATCH /workbench/settings — название и описание трансляции
router.patch('/settings', auth, requireStreamer, async (req, res) => {
  const { streamTitle, streamDescription } = req.body;
  if (streamTitle !== undefined) {
    if (String(streamTitle).length > 140) return res.status(400).json({ error: 'Название слишком длинное (максимум 140 символов)' });
    req.streamerUser.streamTitle = String(streamTitle).trim();
  }
  if (streamDescription !== undefined) {
    if (String(streamDescription).length > 2000) return res.status(400).json({ error: 'Описание слишком длинное (максимум 2000 символов)' });
    req.streamerUser.streamDescription = String(streamDescription).trim();
  }
  await req.streamerUser.save();
  res.json({ streamTitle: req.streamerUser.streamTitle, streamDescription: req.streamerUser.streamDescription });
});

// GET /workbench/bans — список заблокированных в чате этого канала
router.get('/bans', auth, requireStreamer, async (req, res) => {
  const bans = await ChannelBan.find({ streamerNameLower: req.streamerUser.streamerNameLower })
    .sort({ bannedAt: -1 })
    .lean();
  res.json(bans);
});

// DELETE /workbench/bans/:userId — разблокировать
router.delete('/bans/:userId', auth, requireStreamer, async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.userId)) return res.status(400).json({ error: 'Некорректный id' });
  await ChannelBan.deleteOne({ streamerNameLower: req.streamerUser.streamerNameLower, userId: req.params.userId });
  chatBus.emitToUser(req.streamerUser.streamerNameLower, req.params.userId, 'chat:restriction', { type: 'none' });
  res.json({ status: 'ok' });
});

// GET /workbench/layout — сохранённое расположение окон этого пользователя
router.get('/layout', auth, requireStreamer, async (req, res) => {
  const layout = await WorkbenchLayout.findOne({ userId: req.streamerUser._id }).lean();
  res.json({ panels: layout?.panels || null });
});

// PUT /workbench/layout — сохранить расположение окон
router.put('/layout', auth, requireStreamer, async (req, res) => {
  const { panels } = req.body;
  if (panels !== null && typeof panels !== 'object') {
    return res.status(400).json({ error: 'Некорректный формат расположения' });
  }
  await WorkbenchLayout.findOneAndUpdate(
    { userId: req.streamerUser._id },
    { panels, updatedAt: new Date() },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});

// DELETE /workbench/layout — сбросить к расположению по умолчанию
router.delete('/layout', auth, requireStreamer, async (req, res) => {
  await WorkbenchLayout.deleteOne({ userId: req.streamerUser._id });
  res.json({ status: 'ok' });
});

// GET /workbench/action-log — последние действия модерации в этом канале
router.get('/action-log', auth, requireStreamer, async (req, res) => {
  const entries = await ChannelActionLog.find({ streamerNameLower: req.streamerUser.streamerNameLower })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(entries);
});
// GET /workbench/vods
router.get('/vods', auth, requireStreamer, async (req, res) => {
  const vods = await StreamVod.find({ userId: req.streamerUser._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(
    vods.map((v) => ({
      id: v._id,
      title: v.title,
      description: v.description,
      published: v.published,
      status: v.status,
      createdAt: v.createdAt,
      expiresAt: v.expiresAt,
      durationSec: v.durationSec,
      url: v.status === 'ready' ? `/media/${v.fileRel}` : null,
    }))
  );
});

// PATCH /workbench/vods/:id
router.patch('/vods/:id', auth, requireStreamer, async (req, res) => {
  const vod = await StreamVod.findOne({ _id: req.params.id, userId: req.streamerUser._id });
  if (!vod) return res.status(404).json({ error: 'Не найдено' });
  if (req.body.title !== undefined) vod.title = String(req.body.title).slice(0, 140);
  if (req.body.description !== undefined) vod.description = String(req.body.description).slice(0, 2000);
  if (req.body.published !== undefined) vod.published = !!req.body.published;
  await vod.save();
  res.json({ ok: true, published: vod.published, title: vod.title, description: vod.description });
});

// DELETE /workbench/vods/:id
router.delete('/vods/:id', auth, requireStreamer, async (req, res) => {
  const vod = await StreamVod.findOne({ _id: req.params.id, userId: req.streamerUser._id });
  if (!vod) return res.status(404).json({ error: 'Не найдено' });
  try {
    fs.unlinkSync(path.join(process.cwd(), 'media', vod.fileRel));
  } catch (_) {}
  await vod.deleteOne();
  res.json({ ok: true });
});

// POST /workbench/chat-key/generate — сгенерировать (или перевыпустить) API-ключ чата
router.post('/chat-key/generate', auth, requireStreamer, async (req, res) => {
  const key = 'pwc_' + crypto.randomBytes(24).toString('hex');
  req.streamerUser.chatApiKey = key;
  await req.streamerUser.save();
  res.json({ chatApiKey: key, chatApiKeyMasked: maskChatKey(key) });
});

// POST /workbench/chat-key/reveal — получить полный ключ для копирования
router.post('/chat-key/reveal', auth, requireStreamer, async (req, res) => {
  if (!req.streamerUser.chatApiKey) return res.status(404).json({ error: 'Ключ чата ещё не создан' });
  res.json({ chatApiKey: req.streamerUser.chatApiKey });
});

const ChatCommand = require('../../models/ChatCommand');
const { parseArgsInput, parseCommandLine, buildReply } = require('../../services/chatCommands');
const COMMAND_NAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ]{1,20}$/;
const MAX_COMMANDS = 50;
const cleanCommandName = (v) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();

// GET /workbench/commands
router.get('/commands', auth, requireStreamer, async (req, res) => {
  const list = await ChatCommand.find({ streamerNameLower: req.streamerUser.streamerNameLower })
    .sort({ name: 1 })
    .lean();
  res.json(list);
});

// POST /workbench/commands/preview — как ответил бы на такое сообщение (для конструктора)
router.post('/commands/preview', auth, requireStreamer, (req, res) => {
  const name = cleanCommandName(req.body?.name) || 'команда';
  const argsRes = parseArgsInput(req.body?.args);
  if (argsRes.error) return res.json({ text: '⚠ ' + argsRes.error, usage: false });
  const response = String(req.body?.response ?? '').slice(0, 400);
  const parsed = parseCommandLine(req.body?.line) || { name, argv: [] };
  const out = buildReply({ name, args: argsRes.args, response }, parsed.argv, {
    user: 'Viewer1',
    streamer: req.streamerUser.streamerName,
    title: req.streamerUser.streamTitle || 'Играем с друзьями',
    viewers: 12,
    uptime: '1ч 05м',
    count: 7,
  });
  res.json(out);
});

// POST /workbench/commands { name, response, args }
router.post('/commands', auth, requireStreamer, async (req, res) => {
  const nameLower = req.streamerUser.streamerNameLower;
  const name = cleanCommandName(req.body?.name);
  const response = String(req.body?.response ?? '').trim();
  const argsRes = parseArgsInput(req.body?.args);

  if (!COMMAND_NAME_RE.test(name)) return res.status(400).json({ error: 'Команда: 1–20 символов, буквы, цифры и _' });
  if (argsRes.error) return res.status(400).json({ error: argsRes.error });
  if (!response) return res.status(400).json({ error: 'Напиши, что должен ответить бот' });
  if (response.length > 400) return res.status(400).json({ error: 'Ответ слишком длинный (максимум 400 символов)' });
  if ((await ChatCommand.countDocuments({ streamerNameLower: nameLower })) >= MAX_COMMANDS) {
    return res.status(400).json({ error: `Можно создать не больше ${MAX_COMMANDS} команд` });
  }

  try {
    const cmd = await ChatCommand.create({ streamerNameLower: nameLower, name, response, args: argsRes.args });
    res.status(201).json(cmd);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Такая команда уже есть' });
    throw err;
  }
});

// PATCH /workbench/commands/:id { name?, response?, args?, enabled? }
router.patch('/commands/:id', auth, requireStreamer, async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ error: 'Некорректный id' });
  const cmd = await ChatCommand.findOne({ _id: req.params.id, streamerNameLower: req.streamerUser.streamerNameLower });
  if (!cmd) return res.status(404).json({ error: 'Команда не найдена' });

  if (req.body?.name !== undefined) {
    const name = cleanCommandName(req.body.name);
    if (!COMMAND_NAME_RE.test(name)) return res.status(400).json({ error: 'Команда: 1–20 символов, буквы, цифры и _' });
    cmd.name = name;
  }
  if (req.body?.response !== undefined) {
    const response = String(req.body.response).trim();
    if (!response) return res.status(400).json({ error: 'Напиши, что должен ответить бот' });
    if (response.length > 400) return res.status(400).json({ error: 'Ответ слишком длинный (максимум 400 символов)' });
    cmd.response = response;
  }
  if (req.body?.args !== undefined) {
    const argsRes = parseArgsInput(req.body.args);
    if (argsRes.error) return res.status(400).json({ error: argsRes.error });
    cmd.args = argsRes.args;
  }
  if (req.body?.enabled !== undefined) cmd.enabled = !!req.body.enabled;

  try {
    await cmd.save();
    res.json(cmd);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Такая команда уже есть' });
    throw err;
  }
});

// DELETE /workbench/commands/:id
router.delete('/commands/:id', auth, requireStreamer, async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ error: 'Некорректный id' });
  await ChatCommand.deleteOne({ _id: req.params.id, streamerNameLower: req.streamerUser.streamerNameLower });
  res.json({ ok: true });
});

module.exports = router;