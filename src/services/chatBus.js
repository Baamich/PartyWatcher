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

// сколько человек сейчас на странице канала (аккаунты без повторов + гости); считает сокет-файл
let viewerCounter = () => 0;
function setViewerCounter(fn) {
  viewerCounter = fn;
}
function viewerCount(streamerNameLower) {
  return viewerCounter(streamerNameLower) || 0;
}

module.exports = { init, emitMessage, emitToUser, setViewerCounter, viewerCount };