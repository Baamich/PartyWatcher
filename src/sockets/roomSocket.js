// roomSocket.js 
const fs = require('fs');
const path = require('path');
const { verifyToken } = require('../middleware/auth');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');
const SupportTicket = require('../models/SupportTicket');

const THUMB_DIR = process.env.THUMB_DIR || '/home/ubuntu/PartyWatcher/thumbnails';
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const YT_CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
// ключ комнаты — ровно 6 символов 0-9a-f (см. generateCode в room.routes.js)
const ROOM_CODE_RE = /^[a-f0-9]{6}$/;

// code -> Map(socketId -> { username, isOwner }) — кто сейчас в голосовом звонке этой комнаты
const voiceRooms = new Map();

function getVoiceParticipants(code) {
  const map = voiceRooms.get(code);
  if (!map) return [];
  return [...map.entries()].map(([socketId, info]) => ({
    socketId,
    username: info.username,
    isOwner: info.isOwner,
    muted: !!info.muted,
  }));
}

function broadcastVoiceParticipants(io, code) {
  io.to(code).emit('voice:participants', getVoiceParticipants(code));
}

function removeFromVoice(io, socket, code) {
  const map = voiceRooms.get(code);
  if (!map || !map.has(socket.id)) return;
  map.delete(socket.id);
  if (map.size === 0) voiceRooms.delete(code);
  socket.to(code).emit('voice:user-left', { socketId: socket.id });
  broadcastVoiceParticipants(io, code);
}

async function updateRoomActivity(io, code) {
  const size = io.sockets.adapter.rooms.get(code)?.size || 0;
  await Room.findOneAndUpdate(
    { code },
    {
      emptySince: size === 0 ? new Date() : null,
      viewerCount: size,
    }
  );
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
  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.cookie?.match(/(?:^|;\s*)token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Не авторизован'));
    try {
      socket.user = await verifyToken(token); // заодно отсекает токены, отозванные сменой пароля
      next();
    } catch {
      next(new Error('Невалидный токен'));
    }
  });

    io.on('connection', (socket) => {
    // админы сразу в комнату support-событий
    if (socket.user?.role === 'admin') {
      socket.join('admins');
      SupportTicket.countDocuments({ status: 'unread' })
        .then((unreadCount) => {
          socket.emit('support:count', { unreadCount });
        })
        .catch(() => {});
    }

    socket.on('room:thumbnail', async ({ code, dataUrl }) => {
    if (!socket.data.isOwner || socket.data.roomCode !== code) return;
    if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) return;

    try {
      const base64 = dataUrl.slice('data:image/jpeg;base64,'.length);
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 300 * 1024) return; // защита от слишком тяжёлых кадров

      fs.writeFileSync(path.join(THUMB_DIR, `${code}.jpg`), buffer);

      const thumbnailUrl = `/media/thumbnails/${code}.jpg?v=${Date.now()}`;
      await Room.findOneAndUpdate({ code }, { thumbnailUrl });
    } catch (e) {
      console.warn('[room:thumbnail] ошибка сохранения:', e.message);
    }
  });

    // все, кто на главной странице, сидят в lobby
    socket.on('lobby:join', () => {
      socket.join('lobby');
      // дополнительно — личная комната пользователя (для "Мои комнаты")
      if (socket.user?.id) {
        socket.join(`user:${socket.user.id}`);
      }
    });

    socket.on('lobby:leave', () => {
      socket.leave('lobby');
    });

    socket.on('room:join', async (payload) => {
      const code = payload && payload.code;
      // Только строка из 6 символов. Объект вроде { $regex: '^a' } иначе позволил бы перебором
      // «угадать» чужую приватную комнату и прочитать её чат и ссылку на видео.
      if (typeof code !== 'string' || !ROOM_CODE_RE.test(code)) {
        return socket.emit('room:error', { error: 'Комната не найдена' });
      }
      const room = await Room.findOne({ code });
      if (!room) return socket.emit('room:error', { error: 'Комната не найдена' });

      const isBanned = room.bannedUsers.some((id) => String(id) === String(socket.user.id));
      if (isBanned) return socket.emit('room:banned');

      // обязательно ждём join, иначе размер комнаты ещё 0
      await socket.join(code);

      socket.data.roomCode = code;
      socket.data.roomId = room._id;
      socket.data.isOwner = String(room.owner) === String(socket.user.id);

      // сразу обновляем кэш в Mongo (viewerCount + emptySince)
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
        name: room.name,
        username: socket.user.username,
      });
      socket.to(code).emit('room:user-joined', { username: socket.user.username });
      broadcastParticipants(io, code);

      // если в комнате уже идёт звонок — новый участник сразу видит панель
      socket.emit('voice:participants', getVoiceParticipants(code));
    });

    const MAX_VOICE_PARTICIPANTS = 8;

    socket.on('voice:join', ({ code }) => {
      if (socket.data.roomCode !== code) return;

      let map = voiceRooms.get(code);
      if (!map) {
        map = new Map();
        voiceRooms.set(code, map);
      }
      if (map.has(socket.id)) return; // уже в звонке

      if (map.size >= MAX_VOICE_PARTICIPANTS) {
        socket.emit('voice:join-rejected', { reason: 'full', max: MAX_VOICE_PARTICIPANTS });
        return;
      }

      const existing = getVoiceParticipants(code); // список ДО добавления себя — кому звонить первым
      map.set(socket.id, { username: socket.user.username, isOwner: !!socket.data.isOwner });

      socket.emit('voice:existing-participants', existing);
      broadcastVoiceParticipants(io, code);
    });

    socket.on('voice:leave', ({ code }) => {
      removeFromVoice(io, socket, code);
    });

    socket.on('voice:mute', ({ code, muted }) => {
      if (socket.data.roomCode !== code) return;
      const info = voiceRooms.get(code)?.get(socket.id);
      if (!info) return;
      info.muted = !!muted;
      broadcastVoiceParticipants(io, code);
    });

    socket.on('voice:signal', ({ code, to, data }) => {
      if (socket.data.roomCode !== code || !to || !data) return;
      // сигналить можно только тем, кто сейчас в звонке этой же комнаты
      const map = voiceRooms.get(code);
      if (!map || !map.has(socket.id) || !map.has(to)) return;
      io.to(to).emit('voice:signal', { from: socket.id, data });
    });

    socket.on('room:participants', ({ code }) => {
      if (socket.data.roomCode !== code) return; // список участников видят только те, кто сидит в этой комнате
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

      const seasonNum = Number(season) || 1;
      const episodeNum = Number(episode) || 1;

      const playerCaptureCache = require('../services/playerCaptureCache');
      playerCaptureCache.set(code, episodeNum, {
        success: true,
        streams,
        playerIframes: playerIframes || [],
        meta: meta || {},
        message: `Найдено потоков: ${streams.length}`,
      }, seasonNum);

      const room = await Room.findOne({ code }).select('video.meta playback').lean();
      if (!room) return;

      // Та же серия (хост обновил протухшую ссылку или перезагрузил страницу) — позицию сохраняем.
      // Раньше любой новый поток сбрасывал всех на 0:00.
      const sameEpisode =
        (Number(room.video?.meta?.currentSeason) || 1) === seasonNum &&
        (Number(room.video?.meta?.currentEpisode) || 1) === episodeNum;
      const playback = sameEpisode && room.playback
        ? { isPlaying: !!room.playback.isPlaying, positionSeconds: Number(room.playback.positionSeconds) || 0 }
        : { isPlaying: false, positionSeconds: 0 };

      await Room.updateOne(
        { code },
        {
          'video.meta.currentSeason': seasonNum,
          'video.meta.currentEpisode': episodeNum,
          'video.meta.currentVoice': voice || null,
          playback: { ...playback, updatedAt: new Date() },
        }
      );

      if (!sameEpisode) socket.to(code).emit('playback:update', playback);
      socket.to(code).emit('player_capture:streams', {
        season: seasonNum,
        episode: episodeNum,
        voice,
        streams,
        playerIframes: playerIframes || [],
        meta: meta || {},
        sameEpisode,
        playback,
        by: socket.user.username,
      });
    });

    // адрес берём из базы, а не из запроса хоста: клиент не может подсунуть зрителям чужую ссылку
    socket.on('youtube:age-restricted-stream', async ({ code }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;
      const room = await Room.findOne({ code }).select('video.directUrl').lean();
      const url = room?.video?.directUrl;
      if (!url) return;
      socket.to(code).emit('youtube:age-restricted-stream', { url });
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

    socket.on('playback:force-sync', async ({ code, isPlaying, positionSeconds }) => {
      if (!socket.data.isOwner || socket.data.roomCode !== code) return;

      const pos = Number(positionSeconds) || 0;
      const playing = !!isPlaying;

      await Room.findOneAndUpdate(
        { code },
        { playback: { isPlaying: playing, positionSeconds: pos, updatedAt: new Date() } }
      );

      socket.to(code).emit('playback:force-sync', {
        isPlaying: playing,
        positionSeconds: pos,
      });
    });

    socket.on('room:resync', async ({ code }) => {
      if (socket.data.roomCode !== code) return; // только для своей комнаты (заодно закрывает подмену кода объектом)
      const room = await Room.findOne({ code });
      if (!room) return;
      socket.emit('playback:update', {
        isPlaying: room.playback.isPlaying,
        positionSeconds: room.playback.positionSeconds,
      });
    });

    let lastChatAt = 0;
    socket.on('chat:message', async ({ code, text }) => {
      if (socket.data.roomCode !== code) return;
      const now = Date.now();
      if (now - lastChatAt < 300) return; // антифлуд
      lastChatAt = now;
      const trimmed = String(text ?? '').trim().slice(0, 500);
      if (!trimmed) return;

      if (socket.data.roomId) {
        await ChatMessage.create({ room: socket.data.roomId, username: socket.user.username, text: trimmed });
      }

      io.to(code).emit('chat:message', { username: socket.user.username, text: trimmed, at: Date.now() });
    });

    socket.on('disconnect', async () => {
      const code = socket.data.roomCode;
      if (code) {
        removeFromVoice(io, socket, code);
        socket.to(code).emit('room:user-left', { username: socket.user?.username });
        await updateRoomActivity(io, code);
        broadcastParticipants(io, code);
      }
    });
  });
}

module.exports = registerRoomSocket;