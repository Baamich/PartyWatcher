// Мост между HTTP-роутами и сокет-неймспейсом /chat
let nsp = null;

function init(namespace) {
  nsp = namespace;
}

// имя комнаты должно совпадать с roomName() в сокет-файле
function emitMessage(streamerNameLower, payload) {
  if (!nsp) return false;
  nsp.to(`chat:${streamerNameLower}`).emit('chat:message', payload);
  return true;
}

// отправить событие только сокетам конкретного пользователя в чате канала
function emitToUser(streamerNameLower, userId, event, payload) {
  if (!nsp) return;
  const sockets = nsp.adapter.rooms.get(`chat:${streamerNameLower}`);
  if (!sockets) return;
  sockets.forEach((sid) => {
    const s = nsp.sockets.get(sid);
    if (s && s.data && s.data.userId === String(userId)) s.emit(event, payload);
  });
}

// сколько человек сейчас на странице канала (аккаунты без повторов + гости); считает сокет-файл.
// excludeUserId — не считать самого стримера
let viewerCounter = () => 0;
function setViewerCounter(fn) {
  viewerCounter = fn;
}
function viewerCount(streamerNameLower, excludeUserId) {
  return viewerCounter(streamerNameLower, excludeUserId) || 0;
}

// статистика чата за эфир: счётчик заводит rtmpServer при старте эфира и забирает в конце
// (считаем на лету — после «Очистить чат» сообщений в базе уже нет)
const liveChat = new Map(); // streamerNameLower → { n, users: Set }
function chatStatsStart(streamerNameLower) {
  if (!liveChat.has(streamerNameLower)) liveChat.set(streamerNameLower, { n: 0, users: new Set() });
}
function countChatMessage(streamerNameLower, userId) {
  const s = liveChat.get(streamerNameLower);
  if (!s) return; // эфира нет — не считаем
  s.n += 1;
  if (userId && s.users.size < 20000) s.users.add(String(userId));
}
function chatStatsTake(streamerNameLower) {
  const s = liveChat.get(streamerNameLower);
  liveChat.delete(streamerNameLower);
  return { chatMessages: s ? s.n : 0, chatters: s ? s.users.size : 0 };
}

module.exports = { init, emitMessage, emitToUser, setViewerCounter, viewerCount, chatStatsStart, countChatMessage, chatStatsTake };