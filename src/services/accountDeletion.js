// Удаление аккаунта из профиля (Безопасность → «Удалить аккаунт»).
// Запрос: аккаунт замораживается (все сеансы выходят, ключи эфира и API чата сбрасываются), через 3 дня
// удаляется сам — раньше может удалить админ из обращения. Вход с паролем в эти 3 дня отменяет удаление.
// В обращение кладём снимок «что он делал за сутки до запроса» (вдруг натворил и решил сменить аккаунт) —
// снимок живёт ещё 30 дней после удаления, потом стирается.
// Удаление: свои данные и файлы — долой; сообщения в чужих чатах эфиров остаются без автора («Удалён»)
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Session = require('../models/Session');
const SupportTicket = require('../models/SupportTicket');
const sessions = require('./sessions');
const accountLog = require('./accountLog');
const streamKeyCache = require('./streamKeyCache');

const DELETE_AFTER_MS = 3 * 24 * 3600 * 1000;
const LOG_WINDOW_MS = 24 * 3600 * 1000;
const LOGS_KEEP_MS = 30 * 24 * 3600 * 1000;
const LIMIT = 200; // строк на раздел снимка
// автор обезличенного сообщения — как «Бот»/«Система»: браузер переводит через I18N.sysName (common.sys.deleted)
const DELETED_NAME = 'Удалён';
const MEDIA = path.join(process.cwd(), 'media');
const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';

const M = (name) => require('../models/' + name);
const rm = (abs) => { try { fs.unlinkSync(abs); } catch (_) {} };

// ---------- снимок за сутки до запроса ----------
async function snapshot(user, until) {
  const since = new Date(until.getTime() - LOG_WINDOW_MS);
  const range = { $gte: since, $lte: until };
  const [roomMsgs, streamMsgs, rooms, logins, seen, events, modActions] = await Promise.all([
    M('ChatMessage').find({ username: user.username, createdAt: range }).sort({ createdAt: 1 }).limit(LIMIT).lean(),
    M('StreamChatMessage').find({ senderId: user._id, createdAt: range }).sort({ createdAt: 1 }).limit(LIMIT).lean(),
    M('Room').find({ owner: user._id, createdAt: range }).sort({ createdAt: 1 }).limit(LIMIT).lean(),
    Session.find({ userId: user._id }).sort({ createdAt: 1 }).limit(LIMIT).lean(),
    M('UserSeen').find({ userId: user._id, lastAt: { $gte: since } }).sort({ lastAt: 1 }).limit(LIMIT).lean(),
    M('AccountEvent').find({ userId: user._id, at: range }).sort({ at: 1 }).limit(LIMIT).lean(),
    M('ChannelActionLog').find({ actorUsername: user.username, createdAt: range }).sort({ createdAt: 1 }).limit(LIMIT).lean(),
  ]);
  return {
    since, until,
    roomMessages: roomMsgs.map((m) => ({ at: m.createdAt, room: String(m.room), text: m.text })),
    streamMessages: streamMsgs.map((m) => ({ at: m.createdAt, channel: m.streamerNameLower, text: m.text, deleted: !!m.deleted })),
    rooms: rooms.map((r) => ({ at: r.createdAt, name: r.name, code: r.code, public: !!r.isPublic, video: r.video ? r.video.type + ' ' + (r.video.url || '') : '' })),
    logins: logins.map((s) => ({ at: s.createdAt, last: s.lastSeenAt, ip: s.ip, device: s.device, country: s.country, did: s.did })),
    seen: seen.map((s) => ({ at: s.lastAt, ip: s.ip, device: s.name, country: s.country, did: s.did, hits: s.hits || 0 })),
    events: events.map((e) => ({ at: e.at, type: e.type, from: e.from, to: e.to, ip: e.ip, device: e.device })),
    modActions: modActions.map((a) => ({ at: a.createdAt, channel: a.streamerNameLower, action: a.action, target: a.targetUsername, details: a.details })),
  };
}

// ---------- запрос / отмена ----------
// createTicket(req, user, request, description) — из routes/support.routes.js (там уведомление админов)
async function request(req, user, createTicket) {
  const now = new Date();
  const deleteAt = new Date(now.getTime() + DELETE_AFTER_MS);
  const logs = await snapshot(user, now);
  await User.updateOne({ _id: user._id }, {
    $set: { deleteRequestedAt: now, deleteAt },
    $inc: { tokenVersion: 1 },
    $unset: { streamKey: 1, chatApiKey: 1 }, // замороженный аккаунт не выходит в эфир и не пишет в чат через API
  });
  if (user.streamKey) streamKeyCache.remove(user.streamKey);
  require('../middleware/auth').forgetUser(user._id);
  await sessions.revokeWhere({ userId: user._id });
  accountLog.record(user._id, 'deleteRequest', { to: deleteAt.toISOString() }, req);
  const ticket = await createTicket(req, user, { kind: 'deletion', deleteAt, logs },
    req.t('server.account.deleteRequestText', { name: user.username, date: deleteAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }));
  console.log(`[account] ${user.username}: запрос на удаление, удалится ${deleteAt.toISOString()} (обращение #${ticket.number})`);
  return deleteAt;
}

async function cancel(req, userId) {
  await User.updateOne({ _id: userId }, { $unset: { deleteRequestedAt: 1, deleteAt: 1 } });
  await SupportTicket.updateMany({ userId, 'request.kind': 'deletion', 'request.cancelled': { $ne: true } }, { $set: { 'request.cancelled': true } });
  accountLog.record(userId, 'deleteCancel', {}, req);
  console.log(`[account] ${userId}: удаление отменено (вошёл с паролем)`);
}

// ---------- само удаление ----------
async function purge(userId, by = '') {
  const user = await User.findById(userId).lean();
  if (!user) return false;
  const uid = user._id;
  const ch = user.streamerNameLower || null;
  const del = (name, filter) => M(name).deleteMany(filter);

  // подписки: счётчики подписчиков у тех, на кого был подписан
  const follows = await M('Follow').find({ followerId: uid }).select('streamerId').lean();
  if (follows.length) await User.updateMany({ _id: { $in: follows.map((f) => f.streamerId) }, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } });
  // лайки и добавления пре-сетов: счётчики у чужих пре-сетов
  const [likes, adds] = await Promise.all([
    M('PresetLike').find({ userId: uid }).select('presetId').lean(),
    M('PresetAdd').find({ userId: uid }).select('presetId').lean(),
  ]);
  if (likes.length) await M('Preset').updateMany({ _id: { $in: likes.map((x) => x.presetId) }, likes: { $gt: 0 } }, { $inc: { likes: -1 } });
  if (adds.length) await M('Preset').updateMany({ _id: { $in: adds.map((x) => x.presetId) }, adds: { $gt: 0 } }, { $inc: { adds: -1 } });

  // свои пре-сеты: лайки и добавления других людей к ним
  const own = await M('Preset').find({ authorId: uid }).select('_id').lean();
  if (own.length) {
    const ids = own.map((p) => p._id);
    await Promise.all([del('PresetLike', { presetId: { $in: ids } }), del('PresetAdd', { presetId: { $in: ids } })]);
  }

  // комнаты: свои — целиком (с чатом и превью), сообщения в чужих — долой (чат комнат и так живёт 3 дня)
  const rooms = await M('Room').find({ owner: uid }).select('_id code').lean();
  if (rooms.length) {
    await del('ChatMessage', { room: { $in: rooms.map((r) => r._id) } });
    await del('Room', { _id: { $in: rooms.map((r) => r._id) } });
    for (const r of rooms) rm(path.join(THUMB_DIR, `${r.code}.jpg`));
  }
  await del('ChatMessage', { username: user.username });

  // чаты эфиров: в чужих каналах — без автора, в своём канале — всё долой
  await M('StreamChatMessage').updateMany(
    { senderId: uid, ...(ch ? { streamerNameLower: { $ne: ch } } : {}) },
    { $set: { senderId: null, senderUsername: DELETED_NAME, nickColor: null } }
  );

  // файлы клипов и записей эфиров
  const [clips, vods] = await Promise.all([
    M('Clip').find({ streamerId: uid }).select('fileRel thumbRel').lean(),
    M('StreamVod').find({ userId: uid }).select('fileRel').lean(),
  ]);
  for (const c of clips) for (const rel of [c.fileRel, c.thumbRel]) if (rel) rm(path.join(MEDIA, rel));
  for (const v of vods) rm(path.join(MEDIA, v.fileRel));

  await Promise.all([
    del('Session', { userId: uid }),
    del('AccountEvent', { userId: uid }),
    del('UserSeen', { userId: uid }),
    del('Follow', { $or: [{ followerId: uid }, { streamerId: uid }] }),
    del('ChannelPoints', { $or: [{ userId: uid }, { streamerId: uid }] }),
    del('ChannelSeen', ch ? { $or: [{ userId: uid }, { streamerNameLower: ch }] } : { userId: uid }),
    del('ChannelMod', ch ? { $or: [{ userId: uid }, { streamerNameLower: ch }] } : { userId: uid }),
    del('ChannelBan', ch ? { $or: [{ userId: uid }, { streamerNameLower: ch }] } : { userId: uid }),
    del('ChannelTimeout', ch ? { $or: [{ userId: uid }, { streamerNameLower: ch }] } : { userId: uid }),
    del('Redemption', { $or: [{ userId: uid }, { streamerId: uid }] }),
    del('Reward', { streamerId: uid }),
    del('AlertSettings', { userId: uid }),
    del('AlertMedia', { userId: uid }),
    del('Emote', { ownerId: uid }),
    del('PresetLike', { userId: uid }),
    del('PresetAdd', { userId: uid }),
    del('Preset', { authorId: uid }),
    del('Clip', { streamerId: uid }),
    del('StreamVod', { userId: uid }),
    del('StreamSession', { streamerId: uid }),
    del('WorkbenchLayout', { userId: uid }),
    ch ? del('StreamChatMessage', { streamerNameLower: ch }) : null,
    ch ? del('ChatCommand', { streamerNameLower: ch }) : null,
    // статистика посещений (была с согласием) остаётся без привязки к человеку
    M('VisitDay').updateMany({ userId: uid }, { $set: { userId: null, username: '' } }),
  ]);
  if (user.streamKey) streamKeyCache.remove(user.streamKey);
  await User.deleteOne({ _id: uid });
  require('../middleware/auth').forgetUser(uid);
  await SupportTicket.updateMany({ userId: uid, 'request.kind': 'deletion' }, { $set: { 'request.done': true, 'request.doneAt': new Date(), 'request.doneBy': by } });
  console.log(`[account] аккаунт ${user.username} (${uid}) удалён${by ? ', удалил ' + by : ' по сроку'}`);
  return true;
}

// раз в час: срок вышел — удаляем; снимки логов старше 30 дней после удаления — стираем
let timer = null;
async function tick() {
  try {
    const due = await User.find({ deleteAt: { $lte: new Date() } }).select('_id').limit(20).lean();
    for (const u of due) await purge(u._id).catch((e) => console.error('[account] purge', u._id, e.message));
    await SupportTicket.updateMany(
      { 'request.kind': 'deletion', 'request.deleteAt': { $lte: new Date(Date.now() - LOGS_KEEP_MS) }, 'request.logs': { $exists: true } },
      { $unset: { 'request.logs': 1 } }
    );
  } catch (e) {
    console.error('[account] tick', e.message);
  }
}
function start() {
  if (timer) return;
  timer = setInterval(tick, 3600 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = { request, cancel, purge, start, DELETED_NAME };
