// Мост между HTTP-роутами и сокет-неймспейсом /chat
const ChannelActionLog = require('../models/ChannelActionLog');

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

// модераторы канала изменились — разослать всем в чате их новые роли и права (делает сокет-файл)
let roleRefresher = async () => {};
function setRoleRefresher(fn) {
  roleRefresher = fn;
}
function refreshRoles(streamerNameLower) {
  roleRefresher(streamerNameLower).catch((e) => console.warn('[chatBus] refreshRoles', e.message));
}

// стример сохранил правила чата — сокет-файл обновит их и попросит зрителей принять заново
let rulesRefresher = () => {};
function setRulesRefresher(fn) {
  rulesRefresher = fn;
}
function rulesChanged(streamerNameLower, text) {
  try { rulesRefresher(streamerNameLower, text); } catch (e) { console.warn('[chatBus] rulesChanged', e.message); }
}

// начался новый эфир (rtmpServer) — сокет-файл заведёт зрителям в чате отсчёт серии просмотров
let liveStartHandler = () => {};
function setLiveStartHandler(fn) {
  liveStartHandler = fn;
}
function liveStarted(streamerNameLower) {
  try { liveStartHandler(streamerNameLower); } catch (e) { console.warn('[chatBus] liveStarted', e.message); }
}

// журнал действий канала (студия → «Журнал действий»): пишем запись и сразу шлём её стримеру, если он в чате.
// details — без слов (журнал читают на разных языках): «00:10:00», «chatSlowSec=30», название категории
async function logAction(streamerNameLower, actorUsername, action, targetUsername, details) {
  const entry = await ChannelActionLog.create({
    streamerNameLower, actorUsername, action, targetUsername: targetUsername || null, details: details || '',
  });
  const room = nsp?.adapter.rooms.get(`chat:${streamerNameLower}`);
  if (!room) return;
  room.forEach((sid) => {
    const s = nsp.sockets.get(sid);
    if (s?.data?.isOwner) s.emit('action:logged', entry);
  });
}
const logActionQuiet = (...a) => logAction(...a).catch((e) => console.warn('[chatBus] logAction', e.message));

module.exports = { init, emitMessage, emitToUser, logAction: logActionQuiet, setViewerCounter, viewerCount, chatStatsStart, countChatMessage, chatStatsTake, setRoleRefresher, refreshRoles, setRulesRefresher, rulesChanged, setLiveStartHandler, liveStarted };