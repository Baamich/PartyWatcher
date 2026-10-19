const { verifyToken } = require('../middleware/auth');
const StreamChatMessage = require('../models/StreamChatMessage');
const ChannelBan = require('../models/ChannelBan');
const ChannelTimeout = require('../models/ChannelTimeout');
const User = require('../models/User');
const chatBus = require('../services/chatBus');
const Follow = require('../models/Follow');
const mods = require('../services/channelMods');

// «чат только для подписчиков»: допустимые значения (null — выкл, 0 — сразу после подписки, иначе минуты)
const FOLLOW_MIN_VALUES = [null, 0, 10, 30, 60, 1440];
// фильтр слов (services/chatFilter: 0 — выкл … 4 — очень сильно) и медленный режим (секунды между сообщениями)
const FILTER_VALUES = [0, 1, 2, 3, 4];
const SLOW_VALUES = [0, 3, 5, 10, 30, 60, 120];
const chatFilter = require('../services/chatFilter');
const chatRules = require('../services/chatRules');
const emotes = require('../services/emotes');
const alerts = require('../services/alerts');
const points = require('../services/points');
const ChatCommand = require('../models/ChatCommand');
const { parseCommandLine, buildReply } = require('../services/chatCommands');
const i18n = require('../services/i18n');
const safeHandlers = require('./safeHandlers');
const chatColor = require('../services/chatColor');
const notify = require('../services/notify');

function roomName(streamerNameLower) {
  return `chat:${streamerNameLower}`;
}

// журнал действий канала (chatBus пишет запись и шлёт её стримеру в студию)
const logAction = (nsp, ...args) => chatBus.logAction(...args);
const pad2 = (n) => String(n).padStart(2, '0');
const hms = (sec) => `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`; // без слов: журнал читают на разных языках

function parseCookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function getUserFromSocket(socket) {
  try {
    const token = parseCookieToken(socket.handshake.headers.cookie);
    if (!token) return null;
    return await verifyToken(token); // токен, отозванный сменой пароля, = гость
  } catch {
    return null;
  }
}

async function getRestriction(streamerNameLower, userId) {
  const [ban, to] = await Promise.all([
    ChannelBan.findOne({ streamerNameLower, userId }).lean(),
    ChannelTimeout.findOne({ streamerNameLower, userId }).lean(),
  ]);
  if (ban) return { type: 'ban' };
  if (to && to.until > new Date()) return { type: 'timeout', until: to.until };
  return { type: 'none' };
}

// lang — язык того, кто вызвал команду (ответ бота уходит в общий чат на его языке)
function formatUptime(startedAt, isLive, lang) {
  if (!isLive || !startedAt) return i18n.t(lang, 'server.cmd.offline');
  const m = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? i18n.t(lang, 'server.cmd.uptimeHM', { h, m: m % 60 }) : i18n.t(lang, 'server.cmd.uptimeM', { m });
}

module.exports = function registerChatSocket(io) {
  const nsp = io.of('/chat');
  chatBus.init(nsp);

  // проверка токена асинхронная (версия в базе) — делаем её до connection,
  // чтобы обработчики навешивались сразу и первый chat:join не потерялся
  nsp.use(async (socket, next) => {
    socket.data.authUser = await getUserFromSocket(socket);
    next();
  });

  // streamerNameLower → Map<socketId, { username, userId }>
  const presence = new Map();
  // streamerNameLower → { followMin, filter, slowSec } (обновляется при входе в чат и при смене режима)
  const chatMode = new Map();
  const modeOf = (room) => chatMode.get(room) || { followMin: null, filter: 0, slowSec: 0 };
  // медленный режим: когда писал каждый зритель (канал:пользователь → время)
  const slowLast = new Map();
  // маска фильтра для сообщения (null — нечего прятать)
  const maskFor = (room, text) => chatFilter.mask(text, modeOf(room).filter);
  // правила чата: streamerNameLower → { text, ver } (читаются при входе зрителя, обновляются из студии)
  const rulesMap = new Map();
  const EMPTY_RULES = { text: '', ver: chatRules.versionOf('') };
  const rulesOf = (room) => rulesMap.get(room) || EMPTY_RULES;
  const setRules = (room, text) => rulesMap.set(room, { text: text || '', ver: chatRules.versionOf(text) });
  // писать можно: стример и модераторы — всегда, остальные — приняв текущие правила (не подписан — на сутки)
  const rulesOk = (socket, room, followed) =>
    !!socket.data.role || (socket.data.rulesVer === rulesOf(room).ver && chatRules.stillValid(socket.data.rulesAt, followed));
  const askRules = (socket, room) => socket.emit('chat:rules', rulesOf(room));

  async function refreshRoles(nameLower) {
    const ids = nsp.adapter.rooms.get(roomName(nameLower)) || new Set();
    for (const sid of ids) {
      const s2 = nsp.sockets.get(sid);
      if (!s2 || !s2.data.userId || s2.data.isOverlay) continue;
      const rp = await mods.permsOf(nameLower, s2.data.userId).catch(() => null);
      if (!rp) continue;
      s2.data.role = rp.role;
      s2.data.perms = rp.perms;
      s2.emit('chat:role', rp);
    }
  }
  chatBus.setRoleRefresher(refreshRoles);
  chatBus.setRulesRefresher((room, text) => {
    const ids = nsp.adapter.rooms.get(roomName(room));
    if (!ids) return rulesMap.delete(room);
    setRules(room, text);
    for (const sid of ids) {
      const s2 = nsp.sockets.get(sid);
      if (s2?.data.userId && !s2.data.isOverlay && !s2.data.role) askRules(s2, room);
    }
  });
  const hasPerm = (socket, perm) => Array.isArray(socket.data.perms) && socket.data.perms.includes(perm);

  // ---------- рейд: зрители канала через N секунд переходят на чужой эфир ----------
  // room → { to, timer, until }. Запускает стример или высший модератор с правом «рейд»
  const raids = new Map();
  const RAID_MIN = 5, RAID_MAX = 120;
  const avatarOf = (u) => (u.streamerAvatarUrl ? `/api/streamers/${encodeURIComponent(u.streamerNameLower)}/avatar?v=${Number(u.profileRev) || 0}` : null);

  async function finishRaid(room, ownerId, fromName, fromAvatar, to) {
    raids.delete(room);
    const viewers = chatBus.viewerCount(room, ownerId);
    nsp.to(roomName(room)).emit('chat:raid-go', { to: to.nameLower, from: room });
    // в чат того, к кому пришли: сообщение (видно и оверлею OBS) и баннер «Рейд от …»
    const text = `🚀 Рейд от ${fromName}: ${viewers}`; // запасной текст для API; сайт пишет его на языке зрителя по raid
    const msg = await StreamChatMessage.create({
      streamerNameLower: to.nameLower, senderId: null, senderUsername: fromName, text, external: true, source: 'raid', raidViewers: viewers,
    });
    const raid = { from: fromName, fromLower: room, viewers, avatarUrl: fromAvatar };
    nsp.to(roomName(to.nameLower)).emit('chat:message', {
      _id: msg._id, senderId: null, senderUsername: fromName, text, deleted: false, createdAt: msg.createdAt,
      external: true, source: 'raid', raid, isOwner: false,
    });
    nsp.to(roomName(to.nameLower)).emit('chat:raided', raid);
    alerts.fire(to.nameLower, 'raid', { streamer: fromName, viewers }).catch(() => {});
    console.log(`[raid] ${room} → ${to.nameLower}: ${viewers} зрителей`);
  }

  // бан/таймаут, а потом — режим «только подписчики» (стримера и модераторов не касается)
  async function fullRestriction(room, streamerId, userId, exempt) { // exempt — стример или модератор
    const r = await getRestriction(room, userId);
    if (r.type !== 'none' || exempt || !streamerId) return r;
    const min = modeOf(room).followMin;
    if (min === null || min === undefined) return r;
    const f = await Follow.findOne({ followerId: userId, streamerId }).select('createdAt').lean();
    if (!f) return { type: 'followers', min };
    const until = new Date(f.createdAt).getTime() + min * 60000;
    if (until > Date.now()) return { type: 'followers', min, until: new Date(until) };
    return r;
  }

  function getRoomPresence(nameLower) {
    if (!presence.has(nameLower)) presence.set(nameLower, new Map());
    return presence.get(nameLower);
  }

  function buildViewersPayload(nameLower) {
    const room = getRoomPresence(nameLower);
    // уникальные: залогиненные по userId, гости — по socketId
    const seenUsers = new Set();
    const list = [];
    let guestCount = 0;

    for (const [, info] of room) {
      if (info.userId) {
        if (seenUsers.has(info.userId)) continue;
        seenUsers.add(info.userId);
        list.push({ username: info.username, isGuest: false });
      } else {
        guestCount += 1;
      }
    }

    if (guestCount > 0) {
      list.push({
        username: guestCount === 1 ? 'Гость' : `Гости (${guestCount})`, // старые клиенты; новые пишут сами по guests
        isGuest: true,
        guests: guestCount,
      });
    }

    return { count: list.length, viewers: list };
  }

  // для каталога трансляций: число без списка имён
  chatBus.setViewerCounter((nameLower, excludeUserId) => {
    const room = presence.get(nameLower);
    if (!room) return 0;
    const users = new Set();
    let guests = 0;
    for (const [, info] of room) {
      if (info.userId) { if (info.userId !== String(excludeUserId || '')) users.add(info.userId); }
      else guests += 1;
    }
    return users.size + guests;
  });

  // список зрителей уходит всем в канале — при волне входов (рейд, начало эфира) это N рассылок по N человек.
  // Склеиваем: не чаще раза в 1,5 с на канал, со свежим списком на момент отправки
  const VIEWERS_EMIT_MS = 1500;
  const viewersTimers = new Map(); // канал → таймер (живёт до отправки)
  function emitViewers(nameLower) {
    if (viewersTimers.has(nameLower)) return;
    viewersTimers.set(nameLower, setTimeout(() => {
      viewersTimers.delete(nameLower);
      // все ушли — ноль (оверлеям и студии), не заводя пустую запись присутствия
      const payload = presence.has(nameLower) ? buildViewersPayload(nameLower) : { count: 0, viewers: [] };
      nsp.to(roomName(nameLower)).emit('chat:viewers', payload);
    }, VIEWERS_EMIT_MS));
  }

  const COMMAND_COOLDOWN_MS = 3000;
  const commandLastUsed = new Map(); // `${канал}:${команда}` → время последнего ответа

  async function runChatCommand(nameLower, text, username, lang) {
    const parsed = parseCommandLine(text);
    if (!parsed) return;

    const key = `${nameLower}:${parsed.name}`;
    const now = Date.now();
    if (now - (commandLastUsed.get(key) || 0) < COMMAND_COOLDOWN_MS) return; // защита от спама
    const cmd = await ChatCommand.findOne({
      streamerNameLower: nameLower,
      name: parsed.name,
      enabled: { $ne: false },
    }).lean();
    if (!cmd) return;
    if (commandLastUsed.size > 500) commandLastUsed.clear();
    commandLastUsed.set(key, now);
    alerts.fire(nameLower, 'command', { name: username, command: '!' + parsed.name }).catch(() => {});

    const streamer = await User.findOne({ streamerNameLower: nameLower })
      .select('streamerName streamTitle isLive liveStartedAt')
      .lean();

    const reply = buildReply(cmd, parsed.argv, {
      user: username,
      streamer: streamer?.streamerName || nameLower,
      title: streamer?.streamTitle || '',
      viewers: buildViewersPayload(nameLower).count,
      uptime: formatUptime(streamer?.liveStartedAt, streamer?.isLive, lang),
      count: (cmd.uses || 0) + 1,
      lang,
    });
    if (!reply.usage) {
      ChatCommand.updateOne({ _id: cmd._id }, { $inc: { uses: 1 } }).catch(() => {});
    }
    const out = reply.text;
    if (!out.trim()) return;

    const msg = await StreamChatMessage.create({
      streamerNameLower: nameLower,
      senderId: null,
      senderUsername: 'Бот',
      text: out,
      external: true,
      source: 'bot',
    });
    nsp.to(roomName(nameLower)).emit('chat:message', {
      _id: msg._id,
      senderId: null,
      senderUsername: 'Бот',
      text: out,
      deleted: false,
      createdAt: msg.createdAt,
      external: true,
      source: 'bot',
      nickColor: null,
      isOwner: false,
    });
  }

  // бан / разбан в чате канала — уведомление зрителю (таймауты — нет: короткие и частые). Имя канала — как пишет стример
  function banNotify(userId, type, room) {
    User.findOne({ streamerNameLower: room }).select('streamerName').lean()
      .then((s) => notify.send(userId, type, { channel: s?.streamerName || room }, { link: '/streamers/' + encodeURIComponent(room) }))
      .catch(() => {});
  }

  // ---------- модерация: кнопки чата и команды «/» (права проверяет вызывающий) ----------
  // ответ — ключ ошибки словаря или null
  const actorName = (socket) => socket.data.authUser?.username || '?';

  async function banUser(socket, room, userId, username) {
    if (!(await mods.outranks(room, socket.data.authUser.id, userId))) return 'server.modcmd.rank'; // модер не банит модера и стримера
    username = String(username || '').slice(0, 32);
    await ChannelBan.findOneAndUpdate(
      { streamerNameLower: room, userId },
      { streamerNameLower: room, userId, username, bannedAt: new Date() },
      { upsert: true }
    );
    nsp.to(roomName(room)).emit('chat:user-banned', { userId });
    chatBus.emitToUser(room, userId, 'chat:restriction', { type: 'ban' });
    banNotify(userId, 'chat.ban', room);
    alerts.fire(room, 'ban', { name: username }).catch(() => {});
    logAction(nsp, room, actorName(socket), 'ban', username);
    return null;
  }

  async function timeoutUser(socket, room, userId, username, seconds) {
    if (!(await mods.outranks(room, socket.data.authUser.id, userId))) return 'server.modcmd.rank';
    username = String(username || '').slice(0, 32);
    const sec = Math.min(30 * 24 * 3600, Math.max(1, Math.floor(Number(seconds) || 0)));
    const until = new Date(Date.now() + sec * 1000);
    await ChannelTimeout.findOneAndUpdate(
      { streamerNameLower: room, userId },
      { streamerNameLower: room, userId, username, until },
      { upsert: true }
    );
    nsp.to(roomName(room)).emit('chat:user-timeout', { userId, until });
    chatBus.emitToUser(room, userId, 'chat:restriction', { type: 'timeout', until });
    alerts.fire(room, 'ban', { name: username }).catch(() => {});
    logAction(nsp, room, actorName(socket), 'timeout', username, hms(sec));
    return null;
  }

  // снять бан (kind 'ban') или таймаут ('timeout'): зрителю — его новое ограничение (может остаться «только подписчики»)
  async function liftUser(socket, room, userId, username, kind) {
    const Model = kind === 'ban' ? ChannelBan : ChannelTimeout;
    const r = await Model.deleteOne({ streamerNameLower: room, userId });
    if (!r.deletedCount) return kind === 'ban' ? 'server.modcmd.notBanned' : 'server.modcmd.notTimedOut';
    fullRestriction(room, socket.data.streamerId, userId, false)
      .then((x) => chatBus.emitToUser(room, userId, 'chat:restriction', x))
      .catch(() => {});
    logAction(nsp, room, actorName(socket), kind === 'ban' ? 'unban' : 'untimeout', username);
    if (kind === 'ban') banNotify(userId, 'chat.unban', room);
    return null;
  }

  async function clearChat(socket, room) {
    // жёсткое удаление — после F5 чат пустой, не «Сообщение удалено»
    await StreamChatMessage.deleteMany({ streamerNameLower: room });
    nsp.to(roomName(room)).emit('chat:cleared');
    logAction(nsp, room, actorName(socket), 'clear_chat');
  }

  // режим чата: любое из полей { followMin } «только подписчики», { filter } фильтр слов, { slowSec } медленный режим.
  // false — неверное значение или нечего менять
  async function setMode(socket, room, body) {
    const prev = modeOf(room);
    const next = { ...prev };
    const set = {};
    if ('followMin' in body) {
      const v = body.followMin === null || body.followMin === '' ? null : Number(body.followMin);
      if (!FOLLOW_MIN_VALUES.includes(v)) return false;
      next.followMin = set.chatFollowMin = v;
    }
    if ('filter' in body) {
      const v = Number(body.filter);
      if (!FILTER_VALUES.includes(v)) return false;
      next.filter = set.chatFilter = v;
    }
    if ('slowSec' in body) {
      const v = Number(body.slowSec);
      if (!SLOW_VALUES.includes(v)) return false;
      next.slowSec = set.chatSlowSec = v;
    }
    if (!Object.keys(set).length) return false;
    await User.updateOne({ _id: socket.data.streamerId }, { $set: set });
    chatMode.set(room, next);
    nsp.to(roomName(room)).emit('chat:mode', next);
    // в журнал — только то, что правда поменялось: «chatSlowSec=30», «chatFollowMin=off»
    const was = { chatFollowMin: prev.followMin ?? null, chatFilter: prev.filter || 0, chatSlowSec: prev.slowSec || 0 };
    for (const [k, v] of Object.entries(set)) {
      if (was[k] !== v) logAction(nsp, room, actorName(socket), 'chat_mode', null, `${k}=${v === null ? 'off' : v}`);
    }
    if (!('chatFollowMin' in set)) return true;
    // каждому зрителю в чате — его новое ограничение
    const ids = nsp.adapter.rooms.get(roomName(room)) || new Set();
    for (const sid of ids) {
      const s2 = nsp.sockets.get(sid);
      if (!s2 || !s2.data.userId || s2.data.isOverlay || s2.data.role) continue;
      fullRestriction(room, socket.data.streamerId, s2.data.userId, false)
        .then((r) => s2.emit('chat:restriction', r))
        .catch(() => {});
    }
    return true;
  }

  // рейд на канал to через seconds секунд
  async function startRaid(socket, room, to, seconds) {
    if (raids.has(room)) return 'server.modcmd.raidActive';
    const toLower = String(to || '').trim().replace(/^@/, '').toLowerCase();
    if (!toLower || toLower === room || toLower.length > 40) return 'server.raid.badTarget';
    const sec = Math.min(RAID_MAX, Math.max(RAID_MIN, Math.round(Number(seconds) || 15)));
    const [target, me] = await Promise.all([
      User.findOne({ streamerNameLower: toLower }).select('streamerName streamerNameLower isLive streamTitle profileRev streamerAvatarUrl').lean(),
      User.findOne({ streamerNameLower: room }).select('_id streamerName streamerNameLower profileRev streamerAvatarUrl').lean(),
    ]);
    if (!target || !target.isLive) return 'server.raid.notLive';
    if (!me) return 'server.raid.badTarget';
    if (raids.has(room)) return 'server.modcmd.raidActive';
    const toInfo = { name: target.streamerName, nameLower: target.streamerNameLower, avatarUrl: avatarOf(target), title: target.streamTitle || '' };
    const until = Date.now() + sec * 1000;
    const timer = setTimeout(() => {
      finishRaid(room, String(me._id), me.streamerName, avatarOf(me), toInfo).catch((e) => console.warn('[raid]', e.message));
    }, sec * 1000);
    raids.set(room, { to: toInfo, timer, until });
    nsp.to(roomName(room)).emit('chat:raid', { to: toInfo, seconds: sec, until, by: actorName(socket) });
    logAction(nsp, room, actorName(socket), 'raid', toInfo.name, `${sec}s`);
    return null;
  }

  function cancelRaid(socket, room) {
    const r = raids.get(room);
    if (!r) return false;
    clearTimeout(r.timer);
    raids.delete(room);
    nsp.to(roomName(room)).emit('chat:raid-cancelled', { by: actorName(socket) });
    logAction(nsp, room, actorName(socket), 'raid_cancel', r.to.name);
    return true;
  }

  // ---------- команды модерации в чате: «/ban имя», «/timeout имя 10m» … ----------
  // у кого есть право; в чат не попадают, ответ — только написавшему (chat:cmd-result).
  // Список с подсказками у поля ввода — public/js/chat-slash.js (те же имена и права)
  const SLASH_PERM = {
    ban: 'ban', unban: 'ban', timeout: 'timeout', untimeout: 'timeout', clear: 'clearChat',
    slow: 'chatSettings', slowoff: 'chatSettings', followers: 'chatSettings', followersoff: 'chatSettings', filter: 'chatSettings',
    raid: 'raid', unraid: 'raid', title: 'editTitle',
    'sp+': 'points', 'sp-': 'points', // только владелец канала (channelMods.OWNER_PERMS)
  };
  // ключ подсказки в словаре (common.slash.<ключ>): «+» и «-» в ключах словаря не держим
  const SLASH_KEY = { 'sp+': 'spAdd', 'sp-': 'spSub' };
  const POINTS_CMD_MAX = 1000000; // за одну команду
  const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  // «90», «90s», «10m», «2h», «1d» (и по-русски с/м/ч/д) → секунды; без единицы — unit секунд
  function parseDuration(raw, unit = 1) {
    const m = /^(\d{1,7})(s|m|h|d|с|м|ч|д)?$/i.exec(String(raw || '').trim());
    if (!m) return null;
    const mult = { s: 1, 'с': 1, m: 60, 'м': 60, h: 3600, 'ч': 3600, d: 86400, 'д': 86400 }[(m[2] || '').toLowerCase()] || unit;
    return Number(m[1]) * mult;
  }
  async function findChatUser(name) {
    const n = String(name || '').replace(/^@/, '').trim().toLowerCase();
    if (!n || n.length > 32) return null;
    return User.findOne({ usernameLower: n }).select('_id username').lean();
  }

  async function slashCommand(socket, room, text) {
    const lang = socket.data.lang;
    const say = (ok, key, vars) => socket.emit('chat:cmd-result', { ok, text: i18n.t(lang, key, vars) });
    const body = text.slice(1).trim();
    const cmd = (body.split(/\s+/)[0] || '').toLowerCase();
    const rest = body.replace(/^\S+\s*/, '');
    const args = rest ? rest.split(/\s+/) : [];
    const perm = Object.hasOwn(SLASH_PERM, cmd) ? SLASH_PERM[cmd] : null;
    if (!perm) return say(false, 'server.modcmd.unknown', { cmd: '/' + cmd.slice(0, 20) });
    if (!hasPerm(socket, perm)) return say(false, 'server.modcmd.forbidden');
    const usage = () => say(false, 'server.modcmd.usage', { usage: i18n.t(lang, 'common.slash.' + (SLASH_KEY[cmd] || cmd) + '.use') });

    // /SP+ @ник 100 и /SP- @ник 100 (порядок «число, ник» тоже понимаем)
    if (cmd === 'sp+' || cmd === 'sp-') {
      let [who, num] = args;
      if (/^\d+$/.test(who || '') && num && !/^\d+$/.test(num)) [who, num] = [num, who];
      const n = Number(num);
      if (!who || !Number.isInteger(n) || n < 1 || n > POINTS_CMD_MAX) return usage();
      const u = await findChatUser(who);
      if (!u) return say(false, 'server.modcmd.noUser', { name: who.replace(/^@/, '').slice(0, 32) });
      const id = String(u._id);
      if (id === String(socket.data.streamerId)) return say(false, 'server.modcmd.pointsSelf');
      let delta, balance;
      if (cmd === 'sp+') {
        balance = await points.grant(socket.data.streamerId, id, n);
        delta = n;
      } else {
        const r = await points.take(socket.data.streamerId, id, n);
        if (!r.taken) return say(false, 'server.modcmd.spNone', { name: u.username }); // списывать нечего
        balance = r.balance;
        delta = -r.taken;
      }
      chatBus.emitToUser(room, id, 'chat:points', { delta, balance }); // зрителю: обновить счёт и показать, сколько
      logAction(nsp, room, actorName(socket), cmd === 'sp+' ? 'points_add' : 'points_sub', u.username, `${Math.abs(delta)} → ${balance}`);
      return say(true, cmd === 'sp+' ? 'server.modcmd.done.spAdd' : 'server.modcmd.done.spSub', { name: u.username, n: Math.abs(delta), balance });
    }

    if (cmd === 'ban' || cmd === 'unban' || cmd === 'timeout' || cmd === 'untimeout') {
      if (!args[0]) return usage();
      let sec = 600;
      if (cmd === 'timeout' && args[1]) {
        sec = parseDuration(args[1]);
        if (!sec) return usage();
        sec = Math.min(30 * 24 * 3600, sec);
      }
      const u = await findChatUser(args[0]);
      if (!u) return say(false, 'server.modcmd.noUser', { name: args[0].replace(/^@/, '').slice(0, 32) });
      const id = String(u._id);
      const err = cmd === 'ban' ? await banUser(socket, room, id, u.username)
        : cmd === 'timeout' ? await timeoutUser(socket, room, id, u.username, sec)
        : await liftUser(socket, room, id, u.username, cmd === 'unban' ? 'ban' : 'timeout');
      return say(!err, err || 'server.modcmd.done.' + cmd, { name: u.username, time: hms(sec) });
    }

    switch (cmd) {
      case 'clear':
        await clearChat(socket, room);
        return say(true, 'server.modcmd.done.clear');
      case 'slow': {
        const v = args[0] ? parseDuration(args[0]) : 30;
        if (v === null) return usage();
        const sec = v === 0 ? 0 : nearest(SLOW_VALUES.filter(Boolean), v);
        await setMode(socket, room, { slowSec: sec });
        return say(true, sec ? 'server.modcmd.done.slow' : 'server.modcmd.done.slowoff', { n: sec });
      }
      case 'slowoff':
        await setMode(socket, room, { slowSec: 0 });
        return say(true, 'server.modcmd.done.slowoff');
      case 'followers': {
        const v = args[0] ? parseDuration(args[0], 60) : 0; // без единицы — минуты
        if (v === null) return usage();
        const min = nearest(FOLLOW_MIN_VALUES.filter((x) => x !== null), Math.round(v / 60));
        await setMode(socket, room, { followMin: min });
        return say(true, min ? 'server.modcmd.done.followers' : 'server.modcmd.done.followersNow', { n: min });
      }
      case 'followersoff':
        await setMode(socket, room, { followMin: null });
        return say(true, 'server.modcmd.done.followersoff');
      case 'filter': {
        const v = Number(args[0]);
        if (!args[0] || !FILTER_VALUES.includes(v)) return usage();
        await setMode(socket, room, { filter: v });
        return say(true, v ? 'server.modcmd.done.filter' : 'server.modcmd.done.filteroff', { n: v });
      }
      case 'raid': {
        if (!args[0]) return usage();
        const sec = args[1] ? parseDuration(args[1]) : 15;
        if (!sec) return usage();
        const err = await startRaid(socket, room, args[0], sec);
        return say(!err, err || 'server.modcmd.done.raid', { name: args[0].replace(/^@/, '').slice(0, 40) });
      }
      case 'unraid':
        return cancelRaid(socket, room) ? say(true, 'server.modcmd.done.unraid') : say(false, 'server.modcmd.noRaid');
      case 'title': {
        const title = rest.trim().replace(/\s+/g, ' ');
        if (!title) return usage();
        if (title.length > 140) return say(false, 'server.wb.titleLong');
        await User.updateOne({ streamerNameLower: room }, { $set: { streamTitle: title } });
        logAction(nsp, room, actorName(socket), 'edit_title', null, title);
        return say(true, 'server.modcmd.done.title');
      }
      default:
        return say(false, 'server.modcmd.unknown', { cmd: '/' + cmd });
    }
  }

  nsp.on('connection', (socket) => {
    safeHandlers(socket, 'chatSocket'); // ошибка в обработчике (событие без данных и т.п.) не роняет процесс
    const authUser = socket.data.authUser;
    socket.data.userId = authUser?.id ? String(authUser.id) : null;
    // язык ответов этому сокету: с cookie при подключении, дальше — по lang:set (смена языка без перезагрузки)
    socket.data.lang = i18n.langFromHeaders(socket.handshake.headers);
    socket.on('lang:set', (l) => { socket.data.lang = i18n.normLang(l) || socket.data.lang; });
      let currentStreamerNameLower = null;
      let lastSendAt = 0;

    socket.on('chat:join', async ({ streamerName, chatKey, rulesAck } = {}) => {
      // если уже были в другой комнате — выходим
      if (currentStreamerNameLower) {
        if (!socket.data.isOverlay) getRoomPresence(currentStreamerNameLower).delete(socket.id);
        if (!socket.data.isOverlay && authUser) points.watchLeave(currentStreamerNameLower, String(authUser.id));
        socket.leave(roomName(currentStreamerNameLower));
        emitViewers(currentStreamerNameLower);
      }

      socket.data.isOverlay = false;
      socket.data.isOwner = false;
      socket.data.rulesAt = 0;
      socket.data.rulesVer = null;
      currentStreamerNameLower = null;

      let streamer = null;
      const keyStr = String(chatKey || '').trim();

      if (keyStr) {
        // вход по API-ключу (OBS-оверлей, бот): только чтение, в списке зрителей не светится
        streamer = await User.findOne({ chatApiKey: keyStr }).select('_id streamerNameLower chatFollowMin chatFilter chatSlowSec').lean();
        if (!streamer || !streamer.streamerNameLower) {
          return socket.emit('chat:overlay-error', { error: i18n.t(socket.data.lang, 'server.chatApi.badChatKey') });
        }
        currentStreamerNameLower = streamer.streamerNameLower;
        socket.data.isOverlay = true;
        // оверлею нужен фильтр слов (в эфир — с маской), даже если зрителей на странице канала нет
        if (!chatMode.has(currentStreamerNameLower)) {
          chatMode.set(currentStreamerNameLower, { followMin: streamer.chatFollowMin ?? null, filter: streamer.chatFilter || 0, slowSec: streamer.chatSlowSec || 0 });
        }
      } else {
        const name = String(streamerName || '').toLowerCase();
        if (!name) return;
        currentStreamerNameLower = name;
        streamer = await User.findOne({ streamerNameLower: name }).select('_id chatFollowMin chatFilter chatSlowSec chatRules').lean();
        socket.data.isOwner = !!(authUser && streamer && String(streamer._id) === String(authUser.id));
        if (streamer) {
          chatMode.set(name, { followMin: streamer.chatFollowMin ?? null, filter: streamer.chatFilter || 0, slowSec: streamer.chatSlowSec || 0 });
          setRules(name, streamer.chatRules);
        }
      }

      // отключился, пока искали стримера, — не оставляем «призрака» в комнате и в списке зрителей
      if (socket.disconnected) return;

      const room = currentStreamerNameLower;
      socket.join(roomName(room));

      if (!socket.data.isOverlay) {
        if (authUser) points.watchJoin(room, String(authUser.id)); // стрим-поинты: смотрит с этого момента
        getRoomPresence(room).set(socket.id, {
          username: authUser?.username || null,
          userId: authUser?.id ? String(authUser.id) : null,
        });
        emitViewers(room);
      }

      const ownerId = streamer ? String(streamer._id) : null;
      socket.data.streamerId = ownerId;
      socket.data.role = null;
      socket.data.perms = [];
      if (!socket.data.isOverlay && authUser) {
        const rp = await mods.permsOf(room, authUser.id);
        socket.data.role = rp.role;
        socket.data.perms = rp.perms;
        socket.emit('chat:role', rp);
      }
      const modsOf = await mods.load(room);
      if (!socket.data.isOverlay) socket.emit('chat:mode', modeOf(room));
      const raidNow = raids.get(room);
      if (raidNow && !socket.data.isOverlay) {
        socket.emit('chat:raid', { to: raidNow.to, seconds: Math.max(1, Math.round((raidNow.until - Date.now()) / 1000)), until: raidNow.until });
      }

      const history = await StreamChatMessage.find({
        streamerNameLower: room,
        deleted: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      socket.emit(
        'chat:history',
        history.reverse().map((m) => ({
          ...m,
          isOwner: !!ownerId && String(m.senderId) === ownerId,
          modLevel: m.senderId ? modsOf.mods.get(String(m.senderId))?.level || null : null,
          masked: maskFor(room, m.text),
          ...(m.source === 'raid' && { raid: { from: m.senderUsername, viewers: m.raidViewers || 0 } }),
        }))
      );

      if (authUser && !socket.data.isOverlay) {
        socket.emit('chat:restriction', await fullRestriction(room, ownerId, authUser.id, !!socket.data.role));
        // правила чата: отметка о согласии из localStorage зрителя ещё подходит — плашку не показываем
        if (ownerId && !socket.data.role) {
          const { ver } = rulesOf(room);
          const at = chatRules.acceptedAt(rulesAck, socket.data.userId, room, ver);
          if (at && chatRules.stillValid(at, await emotes.isFollower(ownerId, socket.data.userId))) {
            socket.data.rulesAt = at;
            socket.data.rulesVer = ver;
          } else askRules(socket, room);
        }
      }
    });

    // «Согласиться» на плашке правил: { ver } — версия, которую человек видел (правила могли смениться)
    socket.on('chat:rules-accept', ({ ver } = {}) => {
      const room = currentStreamerNameLower;
      if (!authUser || !room || socket.data.isOverlay || !socket.data.streamerId) return;
      const cur = rulesOf(room);
      if (ver !== cur.ver) return askRules(socket, room);
      const at = Date.now();
      // и другим вкладкам этого человека в этом чате
      for (const sid of nsp.adapter.rooms.get(roomName(room)) || []) {
        const s2 = nsp.sockets.get(sid);
        if (s2?.data.userId !== socket.data.userId) continue;
        s2.data.rulesAt = at;
        s2.data.rulesVer = cur.ver;
        s2.emit('chat:rules-ok', { room, ver: cur.ver, token: chatRules.sign(socket.data.userId, room, cur.ver, at) });
      }
    });

    // зритель только что подписался — проверить, можно ли уже писать
    socket.on('chat:check', async () => {
      if (!authUser || !currentStreamerNameLower || socket.data.isOverlay) return;
      socket.emit('chat:restriction', await fullRestriction(currentStreamerNameLower, socket.data.streamerId, authUser.id, !!socket.data.role));
    });

    // режим чата (⚙ у чата — в студии и у модераторов на странице канала): { followMin } | { filter } | { slowSec }
    socket.on('chat:set-mode', async (body = {}) => {
      if (!hasPerm(socket, 'chatSettings') || !currentStreamerNameLower || !body || typeof body !== 'object') return;
      await setMode(socket, currentStreamerNameLower, body);
    });

    // рейд: { to: имя канала, seconds }
    socket.on('chat:raid-start', async ({ to, seconds } = {}) => {
      if (!hasPerm(socket, 'raid') || !currentStreamerNameLower) return;
      const err = await startRaid(socket, currentStreamerNameLower, to, seconds);
      if (err) socket.emit('chat:raid-error', { error: i18n.t(socket.data.lang, err) });
    });

    socket.on('chat:raid-cancel', () => {
      if (!hasPerm(socket, 'raid') || !currentStreamerNameLower) return;
      cancelRaid(socket, currentStreamerNameLower);
    });

    // подсказка ника в командах «/ban @…», «/SP+ @…» (js/chat-slash.js): стримеру и модераторам, от 3 символов.
    // Сначала те, кто сейчас в чате, дальше аккаунты, чей логин начинается так же (уникальный индекс usernameLower)
    let lastUserSearchAt = 0;
    socket.on('chat:user-search', async ({ q } = {}, ack) => {
      if (typeof ack !== 'function') return;
      const room = currentStreamerNameLower;
      const s = String(q || '').trim().replace(/^@/, '').toLowerCase().slice(0, 32);
      const now = Date.now();
      if (!room || !socket.data.role || socket.data.isOverlay || s.length < 3 || now - lastUserSearchAt < 200) return ack({ users: [] });
      lastUserSearchAt = now;
      const out = new Map(); // usernameLower → { username, online }
      for (const [, info] of presence.get(room) || []) {
        const lower = String(info.username || '').toLowerCase();
        if (info.userId && lower.startsWith(s) && out.size < 8) out.set(lower, { username: info.username, online: true });
      }
      if (out.size < 8) {
        const re = new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const rows = await User.find({ usernameLower: re }).select('username usernameLower -_id').limit(8).lean();
        for (const u of rows) if (!out.has(u.usernameLower) && out.size < 8) out.set(u.usernameLower, { username: u.username, online: false });
      }
      ack({ users: [...out.values()] });
    });

    socket.on('chat:send', async ({ text }) => {
        if (!authUser || !currentStreamerNameLower || socket.data.isOverlay) return;
        const nowTs = Date.now();
        if (nowTs - lastSendAt < 700) return; // не чаще раза в 0,7 с
        lastSendAt = nowTs;
        const trimmed = String(text || '').trim().slice(0, 500);
      if (!trimmed) return;

      // «/команда» от стримера или модератора — действие модерации, в чат не уходит
      if (trimmed[0] === '/' && socket.data.role) return slashCommand(socket, currentStreamerNameLower, trimmed);

      const restriction = await fullRestriction(currentStreamerNameLower, socket.data.streamerId, authUser.id, !!socket.data.role);
      if (restriction.type !== 'none') return socket.emit('chat:restriction', restriction);
      const followed = !socket.data.role && (await emotes.isFollower(socket.data.streamerId, String(authUser.id)));
      // правила чата не приняты (или сутки прошли, или стример их поменял) — сообщение не уходит
      if (socket.data.streamerId && !rulesOk(socket, currentStreamerNameLower, followed)) return askRules(socket, currentStreamerNameLower);

      // медленный режим: стримера и модераторов не касается
      const slow = modeOf(currentStreamerNameLower).slowSec;
      if (slow && !socket.data.role) {
        const k = currentStreamerNameLower + ':' + authUser.id;
        const left = (slowLast.get(k) || 0) + slow * 1000 - nowTs;
        if (left > 0) return socket.emit('chat:slow', { wait: Math.ceil(left / 1000), slowSec: slow });
        if (slowLast.size > 20000) slowLast.clear();
        slowLast.set(k, nowTs);
      }

      // смайлы :code: — канала (стримеру, модераторам и подписчикам) и публичные (всем)
      const canChannel = !!socket.data.role || followed;
      const usedEmotes = await emotes.resolve(trimmed, currentStreamerNameLower, canChannel).catch(() => null);

      const nickColor = await chatColor.of(authUser.id).catch(() => null); // профиль → «Вид чата»
      const msg = await StreamChatMessage.create({
        streamerNameLower: currentStreamerNameLower,
        senderId: authUser.id,
        senderUsername: authUser.username,
        text: trimmed,
        nickColor,
        ...(usedEmotes && { emotes: usedEmotes }),
      });

      nsp.to(roomName(currentStreamerNameLower)).emit('chat:message', {
        _id: msg._id,
        senderId: msg.senderId,
        senderUsername: msg.senderUsername,
        text: msg.text,
        masked: maskFor(currentStreamerNameLower, msg.text),
        emotes: usedEmotes || undefined,
        deleted: false,
        createdAt: msg.createdAt,
        nickColor,
        isOwner: !!socket.data.isOwner,
        modLevel: socket.data.role === 'mod' || socket.data.role === 'senior' ? socket.data.role : null,
      });

      chatBus.countChatMessage(currentStreamerNameLower, authUser.id); // статистика эфира
      // алерты: первый раз в чате, разогрев чата, комбо смайлов
      alerts.chatMessage(currentStreamerNameLower, String(authUser.id), authUser.username, trimmed).catch(() => {});
      alerts.chatHype(currentStreamerNameLower).catch(() => {});
      alerts.emotes(currentStreamerNameLower, authUser.id, usedEmotes).catch(() => {});
      runChatCommand(currentStreamerNameLower, trimmed, authUser.username, socket.data.lang).catch((e) =>
        console.warn('[chat command]', e.message)
      );
    });

    socket.on('chat:delete', async ({ messageId }) => {
        if (!hasPerm(socket, 'deleteMsg') || !currentStreamerNameLower) return;
        if (!/^[a-f0-9]{24}$/i.test(String(messageId))) return;
        const msg = await StreamChatMessage.findOneAndUpdate(
        { _id: messageId, streamerNameLower: currentStreamerNameLower },
        { deleted: true },
        { new: true }
      );
      if (msg) {
        nsp.to(roomName(currentStreamerNameLower)).emit('chat:message-deleted', { messageId });
        logAction(nsp, currentStreamerNameLower, authUser.username, 'delete_message', msg.senderUsername);
      }
    });

    socket.on('chat:ban', async ({ userId, username } = {}) => {
      if (!hasPerm(socket, 'ban') || !currentStreamerNameLower) return;
      userId = String(userId || '');
      if (!/^[a-f0-9]{24}$/i.test(userId)) return;
      await banUser(socket, currentStreamerNameLower, userId, username);
    });

    socket.on('chat:timeout', async ({ userId, username, seconds } = {}) => {
      if (!hasPerm(socket, 'timeout') || !currentStreamerNameLower) return;
      userId = String(userId || '');
      if (!/^[a-f0-9]{24}$/i.test(userId)) return;
      await timeoutUser(socket, currentStreamerNameLower, userId, username, seconds);
    });

    socket.on('chat:clear', async () => {
      if (!hasPerm(socket, 'clearChat') || !currentStreamerNameLower) return;
      await clearChat(socket, currentStreamerNameLower);
    });

    socket.on('disconnect', () => {
      if (!currentStreamerNameLower) return;
      getRoomPresence(currentStreamerNameLower).delete(socket.id);
      if (!socket.data.isOverlay && authUser) points.watchLeave(currentStreamerNameLower, String(authUser.id));
      emitViewers(currentStreamerNameLower);
      if (getRoomPresence(currentStreamerNameLower).size === 0) {
        presence.delete(currentStreamerNameLower);
        chatMode.delete(currentStreamerNameLower); // режим перечитается из базы при следующем входе
        rulesMap.delete(currentStreamerNameLower);
      }
    });
  });
};