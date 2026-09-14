// roomSocket.js 
const jwt = require('jsonwebtoken');
const config = require('../config');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');

async function updateRoomActivity(io, code) {
  const size = io.sockets.adapter.rooms.get(code)?.size || 0;
  await Room.findOneAndUpdate({ code }, { emptySince: size === 0 ? new Date() : null });
}

function getParticipants(io, code) {
  const roomSet = io.sockets.adapter.rooms.get(code);
  if (!roomSet) return [];

  const byUsername = new Map();
  for (const socketId of roomSet) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    const entry = byUsername.get(s.user.username) || { username: s.user.username, isOwner: false, socketIds: [] };
    entry.isOwner = entry.isOwner || !!s.data.isOwner;
    entry.socketIds.push(socketId);
    byUsername.set(s.user.username, entry);
  }
  return [...byUsername.values()];
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
      socket.data.roomId = room._id;
      socket.data.isOwner = String(room.owner) === String(socket.user.id);

      await updateRoomActivity(io, code);

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const history = await ChatMessage.find({ room: room._id, createdAt: { $gte: oneHourAgo } })
        .sort({ createdAt: 1 })
        .limit(200);
      socket.emit('chat:history', history.map((m) => ({ username: m.username, text: m.text, at: m.createdAt.getTime() })));

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

      let targetUserId = null;
      for (const socketId of target.socketIds) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (!targetSocket) continue;
        targetUserId = targetSocket.user.id;
        targetSocket.emit('room:kicked');
        targetSocket.disconnect(true);
      }

      if (targetUserId) {
        await Room.findOneAndUpdate({ code }, { $addToSet: { bannedUsers: targetUserId } });
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
    
      socket.on('player_capture:streams', async ({ code, season, episode, voice, streams, playerIframes, meta }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;
      if (!streams?.length) return;

      const playerCaptureCache = require('../services/playerCaptureCache');
      playerCaptureCache.set(code, episode, {
        success: true,
        streams,
        playerIframes: playerIframes || [],
        meta: meta || {},
        message: `Найдено потоков: ${streams.length}`,
      });

      await Room.findOneAndUpdate(
        { code },
        {
          'video.meta.currentSeason': season || 1,
          'video.meta.currentEpisode': episode || 1,
          'video.meta.currentVoice': voice || null,
          playback: { isPlaying: false, positionSeconds: 0, updatedAt: new Date() },
        }
      );

      socket.to(code).emit('playback:update', { isPlaying: false, positionSeconds: 0 });
      socket.to(code).emit('player_capture:streams', {
        season,
        episode,
        voice,
        streams,
        playerIframes: playerIframes || [],
        meta: meta || {},
        by: socket.user.username,
      });
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

    socket.on('chat:message', async ({ code, text }) => {
      const trimmed = text?.trim();
      if (!trimmed) return;

      if (socket.data.roomId) {
        await ChatMessage.create({ room: socket.data.roomId, username: socket.user.username, text: trimmed });
      }

      io.to(code).emit('chat:message', { username: socket.user.username, text: trimmed, at: Date.now() });
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