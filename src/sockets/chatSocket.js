const { verifyToken } = require('../middleware/auth');
const StreamChatMessage = require('../models/StreamChatMessage');
const ChannelBan = require('../models/ChannelBan');
const ChannelTimeout = require('../models/ChannelTimeout');
const ChannelActionLog = require('../models/ChannelActionLog');
const User = require('../models/User');
const chatBus = require('../services/chatBus');
const ChatCommand = require('../models/ChatCommand');
const { parseCommandLine, buildReply } = require('../services/chatCommands');
const i18n = require('../services/i18n');

function roomName(streamerNameLower) {
  return `chat:${streamerNameLower}`;
}

async function logAction(nsp, streamerNameLower, actorUsername, action, targetUsername, details) {
  const entry = await ChannelActionLog.create({
    streamerNameLower, actorUsername, action, targetUsername: targetUsername || null, details: details || '',
  });
  const roomSockets = nsp.adapter.rooms.get(roomName(streamerNameLower));
  if (!roomSockets) return;
  roomSockets.forEach((sid) => {
    const s = nsp.sockets.get(sid);
    if (s?.data?.isOwner) s.emit('action:logged', entry);
  });
}

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

  function emitViewers(nameLower) {
    const payload = buildViewersPayload(nameLower);
    nsp.to(roomName(nameLower)).emit('chat:viewers', payload);
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

  nsp.on('connection', (socket) => {
    const authUser = socket.data.authUser;
    socket.data.userId = authUser?.id ? String(authUser.id) : null;
      let currentStreamerNameLower = null;
      let lastSendAt = 0;

    socket.on('chat:join', async ({ streamerName, chatKey } = {}) => {
      // если уже были в другой комнате — выходим
      if (currentStreamerNameLower) {
        if (!socket.data.isOverlay) getRoomPresence(currentStreamerNameLower).delete(socket.id);
        socket.leave(roomName(currentStreamerNameLower));
        emitViewers(currentStreamerNameLower);
      }

      socket.data.isOverlay = false;
      socket.data.isOwner = false;
      currentStreamerNameLower = null;

      let streamer = null;
      const keyStr = String(chatKey || '').trim();

      if (keyStr) {
        // вход по API-ключу (OBS-оверлей, бот): только чтение, в списке зрителей не светится
        streamer = await User.findOne({ chatApiKey: keyStr }).select('_id streamerNameLower').lean();
        if (!streamer || !streamer.streamerNameLower) {
          return socket.emit('chat:overlay-error', { error: i18n.t(i18n.langFromHeaders(socket.handshake.headers), 'server.chatApi.badChatKey') });
        }
        currentStreamerNameLower = streamer.streamerNameLower;
        socket.data.isOverlay = true;
      } else {
        const name = String(streamerName || '').toLowerCase();
        if (!name) return;
        currentStreamerNameLower = name;
        streamer = await User.findOne({ streamerNameLower: name }).select('_id').lean();
        socket.data.isOwner = !!(authUser && streamer && String(streamer._id) === String(authUser.id));
      }

      // отключился, пока искали стримера, — не оставляем «призрака» в комнате и в списке зрителей
      if (socket.disconnected) return;

      const room = currentStreamerNameLower;
      socket.join(roomName(room));

      if (!socket.data.isOverlay) {
        getRoomPresence(room).set(socket.id, {
          username: authUser?.username || null,
          userId: authUser?.id ? String(authUser.id) : null,
        });
        emitViewers(room);
      }

      const ownerId = streamer ? String(streamer._id) : null;

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
        }))
      );

      if (authUser && !socket.data.isOverlay) {
        socket.emit('chat:restriction', await getRestriction(room, authUser.id));
      }
    });

    socket.on('chat:send', async ({ text }) => {
        if (!authUser || !currentStreamerNameLower || socket.data.isOverlay) return;
        const nowTs = Date.now();
        if (nowTs - lastSendAt < 700) return; // не чаще раза в 0,7 с
        lastSendAt = nowTs;
        const trimmed = String(text || '').trim().slice(0, 500);
      if (!trimmed) return;

      const restriction = await getRestriction(currentStreamerNameLower, authUser.id);
      if (restriction.type !== 'none') return socket.emit('chat:restriction', restriction);

      const msg = await StreamChatMessage.create({
        streamerNameLower: currentStreamerNameLower,
        senderId: authUser.id,
        senderUsername: authUser.username,
        text: trimmed,
      });

      nsp.to(roomName(currentStreamerNameLower)).emit('chat:message', {
        _id: msg._id,
        senderId: msg.senderId,
        senderUsername: msg.senderUsername,
        text: msg.text,
        deleted: false,
        createdAt: msg.createdAt,
        isOwner: !!socket.data.isOwner,
      });

      runChatCommand(currentStreamerNameLower, trimmed, authUser.username, i18n.langFromHeaders(socket.handshake.headers)).catch((e) =>
        console.warn('[chat command]', e.message)
      );
    });

    socket.on('chat:delete', async ({ messageId }) => {
        if (!socket.data.isOwner || !currentStreamerNameLower) return;
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

    socket.on('chat:ban', async ({ userId, username }) => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      userId = String(userId || '');
      if (!/^[a-f0-9]{24}$/i.test(userId)) return;
      username = String(username || '').slice(0, 32);
      await ChannelBan.findOneAndUpdate(
        { streamerNameLower: currentStreamerNameLower, userId },
        { streamerNameLower: currentStreamerNameLower, userId, username, bannedAt: new Date() },
        { upsert: true }
      );
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:user-banned', { userId });
      chatBus.emitToUser(currentStreamerNameLower, userId, 'chat:restriction', { type: 'ban' });
      logAction(nsp, currentStreamerNameLower, authUser.username, 'ban', username);
    });

    socket.on('chat:timeout', async ({ userId, username, seconds }) => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      userId = String(userId || '');
      if (!/^[a-f0-9]{24}$/i.test(userId)) return;
      username = String(username || '').slice(0, 32);
      const sec = Math.min(30 * 24 * 3600, Math.max(1, Math.floor(Number(seconds) || 0)));
      const until = new Date(Date.now() + sec * 1000);
      await ChannelTimeout.findOneAndUpdate(
        { streamerNameLower: currentStreamerNameLower, userId },
        { streamerNameLower: currentStreamerNameLower, userId, username, until },
        { upsert: true }
      );
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:user-timeout', { userId, until });
      chatBus.emitToUser(currentStreamerNameLower, userId, 'chat:restriction', { type: 'timeout', until });
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      logAction(nsp, currentStreamerNameLower, authUser.username, 'timeout', username, `${pad(h)}:${pad(m)}:${pad(s)}`); // без слов: журнал читают на разных языках
    });

    socket.on('chat:clear', async () => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      // жёсткое удаление — после F5 чат пустой, не «Сообщение удалено»
      await StreamChatMessage.deleteMany({ streamerNameLower: currentStreamerNameLower });
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:cleared');
      logAction(nsp, currentStreamerNameLower, authUser.username, 'clear_chat');
    });

    socket.on('disconnect', () => {
      if (!currentStreamerNameLower) return;
      getRoomPresence(currentStreamerNameLower).delete(socket.id);
      emitViewers(currentStreamerNameLower);
      if (getRoomPresence(currentStreamerNameLower).size === 0) {
        presence.delete(currentStreamerNameLower);
      }
    });
  });
};