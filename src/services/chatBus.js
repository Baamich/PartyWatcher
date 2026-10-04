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

module.exports = { init, emitMessage };