const jwt = require('jsonwebtoken');
const config = require('../config');
const Room = require('../models/Room');

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

      socket.emit('room:state', { video: room.video, playback: room.playback });
      socket.to(code).emit('room:user-joined', { username: socket.user.username });
    });

    socket.on('playback:update', async ({ code, isPlaying, positionSeconds }) => {
      const room = await Room.findOneAndUpdate(
        { code },
        { playback: { isPlaying, positionSeconds, updatedAt: new Date() } },
        { new: true }
      );
      if (!room) return;

      socket.to(code).emit('playback:update', { isPlaying, positionSeconds, from: socket.user.username });
    });

    socket.on('chat:message', ({ code, text }) => {
      if (!text?.trim()) return;
      io.to(code).emit('chat:message', { username: socket.user.username, text: text.trim(), at: Date.now() });
    });

    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      if (code) socket.to(code).emit('room:user-left', { username: socket.user?.username });
    });
  });
}

module.exports = registerRoomSocket;