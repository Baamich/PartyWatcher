const jwt = require('jsonwebtoken');
const config = require('../config');
const Room = require('../models/Room');

async function updateRoomActivity(io, code) {
  const size = io.sockets.adapter.rooms.get(code)?.size || 0;
  await Room.findOneAndUpdate({ code }, { emptySince: size === 0 ? new Date() : null });
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
    });

    // ключевой момент: обновлять состояние может ТОЛЬКО владелец комнаты
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

    // синхронизация доступна всем — просто подтягивает текущее состояние от хоста
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
      }
    });
  });
}

module.exports = registerRoomSocket;