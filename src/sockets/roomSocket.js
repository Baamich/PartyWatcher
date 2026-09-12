const jwt = require('jsonwebtoken');
const config = require('../config');
const Room = require('../models/Room');

async function updateRoomActivity(io, code) {
  const size = io.sockets.adapter.rooms.get(code)?.size || 0;
  await Room.findOneAndUpdate({ code }, { emptySince: size === 0 ? new Date() : null });
}

function getParticipants(io, code) {
  const roomSet = io.sockets.adapter.rooms.get(code);
  if (!roomSet) return [];
  return [...roomSet]
    .map((socketId) => {
      const s = io.sockets.sockets.get(socketId);
      return s ? { username: s.user.username, isOwner: !!s.data.isOwner, socketId } : null;
    })
    .filter(Boolean);
}

function broadcastParticipants(io, code) {
  io.to(code).emit('room:participants', getParticipants(io, code));
}

function registerRoomSocket(io) {
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.cookie?.match(/token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Не авторизован'));
    try {
      socket.user = jwt.verify(token, config.jwt.secret);
      next();
    } catch {
      next(new Error('Невалидный токен'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('room:join', async ({ code }) => {
      const room = await Room.findOne({ code });
      if (!room) return socket.emit('room:error', { error: 'Комната не найдена' });

      const isBanned = room.bannedUsers.some((id) => String(id) === String(socket.user.id));
      if (isBanned) return socket.emit('room:banned');

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.isOwner = String(room.owner) === String(socket.user.id);

      await updateRoomActivity(io, code);

      socket.emit('room:state', {
        video: room.video,
        playback: room.playback,
        isOwner: socket.data.isOwner,
      });
      socket.to(code).emit('room:user-joined', { username: socket.user.username });
      broadcastParticipants(io, code);
    });

    socket.on('room:participants', ({ code }) => {
      socket.emit('room:participants', getParticipants(io, code));
    });

    socket.on('room:kick', async ({ code, targetUsername }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;

      const target = getParticipants(io, code).find((p) => p.username === targetUsername && !p.isOwner);
      if (!target) return;

      const targetSocket = io.sockets.sockets.get(target.socketId);
      const targetUserId = targetSocket?.user?.id;

      if (targetUserId) {
        await Room.findOneAndUpdate({ code }, { $addToSet: { bannedUsers: targetUserId } });
      }

      if (targetSocket) {
        targetSocket.emit('room:kicked');
        targetSocket.disconnect(true);
      }

      broadcastParticipants(io, code);
    });

    socket.on('room:banned-list', async ({ code }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;
      const room = await Room.findOne({ code }).populate('bannedUsers', 'username');
      socket.emit('room:banned-list', (room?.bannedUsers || []).map((u) => ({ id: u._id, username: u.username })));
    });

    socket.on('room:unban', async ({ code, userId }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;
      await Room.findOneAndUpdate({ code }, { $pull: { bannedUsers: userId } });
      const room = await Room.findOne({ code }).populate('bannedUsers', 'username');
      socket.emit('room:banned-list', (room?.bannedUsers || []).map((u) => ({ id: u._id, username: u.username })));
    });

    socket.on('playback:update', async ({ code, isPlaying, positionSeconds }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;

      const room = await Room.findOneAndUpdate(
        { code },
        { playback: { isPlaying, positionSeconds, updatedAt: new Date() } },
        { new: true }
      );
      if (!room) return;

      socket.to(code).emit('playback:update', { isPlaying, positionSeconds });
    });

    socket.on('room:resync', async ({ code }) => {
      const room = await Room.findOne({ code });
      if (!room) return;
      socket.emit('playback:update', {
        isPlaying: room.playback.isPlaying,
        positionSeconds: room.playback.positionSeconds,
      });
    });

    socket.on('chat:message', ({ code, text }) => {
      if (!text?.trim()) return;
      io.to(code).emit('chat:message', { username: socket.user.username, text: text.trim(), at: Date.now() });
    });

    socket.on('disconnect', async () => {
      const code = socket.data.roomCode;
      if (code) {
        socket.to(code).emit('room:user-left', { username: socket.user?.username });
        await updateRoomActivity(io, code);
        broadcastParticipants(io, code);
      }
    });
  });
}

module.exports = registerRoomSocket;