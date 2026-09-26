const jwt = require('jsonwebtoken');
const config = require('../config');
const StreamChatMessage = require('../models/StreamChatMessage');
const ChannelBan = require('../models/ChannelBan');
const ChannelTimeout = require('../models/ChannelTimeout');
const User = require('../models/User');

function roomName(streamerNameLower) {
  return `chat:${streamerNameLower}`;
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
    const authUser = getUserFromSocket(socket); // null = гость, может смотреть, не может писать
    let currentStreamerNameLower = null;

    socket.on('chat:join', async ({ streamerName }) => {
      currentStreamerNameLower = String(streamerName || '').toLowerCase();
      if (!currentStreamerNameLower) return;

      socket.join(roomName(currentStreamerNameLower));

      const streamer = await User.findOne({ streamerNameLower: currentStreamerNameLower }).select('_id').lean();
      socket.data.isOwner = !!(authUser && streamer && String(streamer._id) === String(authUser.id));

      const count = nsp.adapter.rooms.get(roomName(currentStreamerNameLower))?.size || 0;
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:viewers', count);

      const history = await StreamChatMessage.find({ streamerNameLower: currentStreamerNameLower })
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
      if (msg) nsp.to(roomName(currentStreamerNameLower)).emit('chat:message-deleted', { messageId });
    });

    socket.on('chat:ban', async ({ userId, username }) => {
      if (!socket.data.isOwner || !currentStreamerNameLower) return;
      await ChannelBan.findOneAndUpdate(
        { streamerNameLower: currentStreamerNameLower, userId },
        { streamerNameLower: currentStreamerNameLower, userId, username, bannedAt: new Date() },
        { upsert: true }
      );
      nsp.to(roomName(currentStreamerNameLower)).emit('chat:user-banned', { userId });
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
    });

    socket.on('disconnect', () => {
      if (currentStreamerNameLower) {
        const count = Math.max((nsp.adapter.rooms.get(roomName(currentStreamerNameLower))?.size || 1) - 1, 0);
        nsp.to(roomName(currentStreamerNameLower)).emit('chat:viewers', count);
      }
    });
  });
};