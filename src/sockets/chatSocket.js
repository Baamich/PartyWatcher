const jwt = require('jsonwebtoken');
const config = require('../config');
const StreamChatMessage = require('../models/StreamChatMessage');
const ChannelBan = require('../models/ChannelBan');
const ChannelTimeout = require('../models/ChannelTimeout');
const ChannelActionLog = require('../models/ChannelActionLog');
const User = require('../models/User');

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

function getUserFromSocket(socket) {
  try {
    const token = parseCookieToken(socket.handshake.headers.cookie);
    if (!token) return null;
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}

module.exports = function registerChatSocket(io) {
  const nsp = io.of('/chat');

  nsp.on('connection', (socket) => {
    const authUser = getUserFromSocket(socket);
    let currentStreamerNameLower = null;

    socket.on('chat:join', async ({ streamerName }) => {
      currentStreamerNameLower = String(streamerName || '').toLowerCase();
      if (!currentStreamerNameLower) return;

      socket.join(roomName(currentStreamerNameLower));

      const streamer = await User.findOne({ streamerNameLower: currentStreamerNameLower }).select('_id').lean();
      socket.data.isOwner = !!(authUser && streamer && String(streamer._id) === String(authUser.id));

      const count = nsp.adapter.rooms.get(roomName(currentStreamerNameLower))?.size || 0;
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:viewers', count);

      // только живые сообщения — удалённые и после clear не попадают в историю
      const history = await StreamChatMessage.find({
        streamerNameLower: currentStreamerNameLower,
        deleted: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      socket.emit('chat:history', history.reverse());
    });

    socket.on('chat:send', async ({ text }) => {
      if (!authUser || !currentStreamerNameLower) return;
      const trimmed = String(text || '').trim().slice(0, 500);
      if (!trimmed) return;

      const banned = await ChannelBan.findOne({ streamerNameLower: currentStreamerNameLower, userId: authUser.id });
      if (banned) return socket.emit('chat:banned');

      const timeout = await ChannelTimeout.findOne({ streamerNameLower: currentStreamerNameLower, userId: authUser.id });
      if (timeout && timeout.until > new Date()) return socket.emit('chat:timeout-active', { until: timeout.until });

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
      });
    });

    socket.on('chat:delete', async ({ messageId }) => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
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
      await ChannelBan.findOneAndUpdate(
        { streamerNameLower: currentStreamerNameLower, userId },
        { streamerNameLower: currentStreamerNameLower, userId, username, bannedAt: new Date() },
        { upsert: true }
      );
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:user-banned', { userId });
      logAction(nsp, currentStreamerNameLower, authUser.username, 'ban', username);
    });

    socket.on('chat:timeout', async ({ userId, username, seconds }) => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      const until = new Date(Date.now() + Math.max(1, Number(seconds) || 0) * 1000);
      await ChannelTimeout.findOneAndUpdate(
        { streamerNameLower: currentStreamerNameLower, userId },
        { streamerNameLower: currentStreamerNameLower, userId, username, until },
        { upsert: true }
      );
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:user-timeout', { userId, until });
      const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
      logAction(nsp, currentStreamerNameLower, authUser.username, 'timeout', username, `${h}ч ${m}м ${s}с`);
    });

    socket.on('chat:clear', async () => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      // жёсткое удаление — после F5 чат пустой, не «Сообщение удалено»
      await StreamChatMessage.deleteMany({ streamerNameLower: currentStreamerNameLower });
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:cleared');
      logAction(nsp, currentStreamerNameLower, authUser.username, 'clear_chat');
    });

    socket.on('disconnect', () => {
      if (currentStreamerNameLower) {
        const count = Math.max((nsp.adapter.rooms.get(roomName(currentStreamerNameLower))?.size || 1) - 1, 0);
        nsp.to(roomName(currentStreamerNameLower)).emit('chat:viewers', count);
      }
    });
  });
};