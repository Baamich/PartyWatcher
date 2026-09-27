let socket;
let myStreamerNameLower;
let fullStreamKey = null;
let timeoutTarget = null;
let hlsPlayer = null;

const DEFAULT_LAYOUT = {
  keyPanel:       { x: 220,  y: 20,  w: 480, h: 130 },
  playerPanel:    { x: 220,  y: 170, w: 480, h: 320 },
  settingsPanel:  { x: 220,  y: 510, w: 480, h: 300 },
  actionLogPanel: { x: 720,  y: 20,  w: 260, h: 420 },
  chatPanel:      { x: 1000, y: 20,  w: 320, h: 680 },
};

let currentLayout = null;

function applyLayout(layout) {
  Object.entries(layout).forEach(([id, rect]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  });
}

function readCurrentRect(el) {
  return {
    x: parseInt(el.style.left, 10) || 0,
    y: parseInt(el.style.top, 10) || 0,
    w: el.offsetWidth,
    h: el.offsetHeight,
  };
}

let saveLayoutTimer = null;
function scheduleSaveLayout() {
  clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(async () => {
    try {
      await api('/workbench/layout', { method: 'PUT', body: { panels: currentLayout } });
    } catch (err) {
      console.warn('[saveLayout]', err.message);
    }
  }, 500);
}

function makeDraggable(panelId) {
  const el = document.getElementById(panelId);
  if (!el) return;
  const handle = el.querySelector('.wb-window-titlebar');
  const resizer = el.querySelector('.wb-resize-handle');

  let dragging = false, dragStartX = 0, dragStartY = 0, startLeft = 0, startTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // не мешаем кнопкам внутри заголовка (кнопка очистки чата)
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    startLeft = el.offsetLeft; startTop = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let newLeft = Math.max(0, startLeft + e.clientX - dragStartX);
    let newTop = Math.max(0, startTop + e.clientY - dragStartY);

    // нельзя перекрывать кнопки навигации — но можно ставить окно НИЖЕ них в той же колонке
    const navEl = document.getElementById('wbNavFixed');
    if (navEl) {
      const navW = navEl.offsetWidth;
      const navH = navEl.offsetHeight;
      if (newLeft < navW && newTop < navH) {
        newTop = navH + 12;
      }
    }

    el.style.left = newLeft + 'px';
    el.style.top = newTop + 'px';
  });
  handle.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    currentLayout[panelId] = readCurrentRect(el);
    scheduleSaveLayout();
  });

  let resizing = false, resizeStartX = 0, resizeStartY = 0, startW = 0, startH = 0;
  resizer.addEventListener('pointerdown', (e) => {
    resizing = true;
    resizeStartX = e.clientX; resizeStartY = e.clientY;
    startW = el.offsetWidth; startH = el.offsetHeight;
    resizer.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    el.style.width = Math.max(220, startW + e.clientX - resizeStartX) + 'px';
    el.style.height = Math.max(120, startH + e.clientY - resizeStartY) + 'px';
  });
  resizer.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = false;
    currentLayout[panelId] = readCurrentRect(el);
    scheduleSaveLayout();
  });
}

async function loadLayout() {
  try {
    const data = await api('/workbench/layout');
    currentLayout = data.panels || JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  } catch {
    currentLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  }
  applyLayout(currentLayout);
}

function initDraggablePanels() {
  ['keyPanel', 'playerPanel', 'settingsPanel', 'actionLogPanel', 'chatPanel'].forEach(makeDraggable);
}

function onResetLayoutClick() {
  document.getElementById('resetLayoutModal').classList.remove('hidden');
}
function closeResetLayoutModal() {
  document.getElementById('resetLayoutModal').classList.add('hidden');
}
async function confirmResetLayout() {
  closeResetLayoutModal();
  try {
    await api('/workbench/layout', { method: 'DELETE' });
  } catch (err) {
    console.warn('[resetLayout]', err.message);
  }
  currentLayout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  applyLayout(currentLayout);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function actionLogLabel(entry) {
  switch (entry.action) {
    case 'clear_chat': return 'очистил(а) чат';
    case 'delete_message': return `удалил(а) сообщение пользователя ${entry.targetUsername || ''}`;
    case 'ban': return `заблокировал(а) пользователя ${entry.targetUsername || ''}`;
    case 'timeout': return `ограничил(а) чат пользователю ${entry.targetUsername || ''} (${entry.details || ''})`;
    default: return entry.action;
  }
}

function renderActionLogEntry(entry, atTop = false) {
  const box = document.getElementById('actionLogList');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'wb-actionlog-row';
  const time = new Date(entry.createdAt || Date.now()).toLocaleTimeString();
  row.innerHTML = `<span class="wb-actionlog-time">${time}</span><b>${escapeHtml(entry.actorUsername)}</b> — ${escapeHtml(actionLogLabel(entry))}`;
  if (atTop && box.firstChild) box.insertBefore(row, box.firstChild);
  else box.appendChild(row);
}

async function loadActionLog() {
  try {
    const entries = await api('/workbench/action-log');
    document.getElementById('actionLogList').innerHTML = '';
    entries.forEach((e) => renderActionLogEntry(e, false));
  } catch (err) {
    console.warn('[loadActionLog]', err.message);
  }
}

function showToast(type, message) {
  const el = document.getElementById('saveToast');
  if (!el) return;
  el.textContent = message;
  el.className = `save-toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function loadSettings() {
  try {
    const data = await api('/workbench/me?_=' + Date.now());
    document.getElementById('streamTitleInput').value = data.streamTitle || '';
    document.getElementById('streamDescInput').value = data.streamDescription || '';
    document.getElementById('streamKeyInput').value = data.streamKeyMasked || '';
    setGenerateBtnState(!!data.streamKeyMasked);
    updatePlayer(data.isLive, data.streamPlaybackId);
  } catch (err) {
    console.warn('[loadSettings]', err.message);
  }
}

function setGenerateBtnState(hasKey) {
  const btn = document.getElementById('generateKeyBtn');
  btn.textContent = hasKey ? '🔄' : '🔄 Сгенерировать';
}

function onGenerateKeyClick() {
  if (fullStreamKey || document.getElementById('streamKeyInput').value) {
    document.getElementById('regenConfirmModal').classList.remove('hidden');
  } else {
    doGenerateKey();
  }
}

function closeRegenConfirm() {
  document.getElementById('regenConfirmModal').classList.add('hidden');
}

function confirmRegenerateKey() {
  closeRegenConfirm();
  doGenerateKey();
}

async function doGenerateKey() {
  try {
    const data = await api('/workbench/stream-key/generate', { method: 'POST' });
    fullStreamKey = data.streamKey;
    document.getElementById('streamKeyInput').value = data.streamKeyMasked;
    setGenerateBtnState(true);
    showToast('success', 'Ключ сгенерирован — скопируй его сейчас, полностью он больше не покажется');
  } catch (err) {
    showToast('error', err.message || 'Не удалось сгенерировать ключ');
  }
}

let currentPlayerLiveState = null; // чтобы не пересоздавать плеер на каждый тик поллинга

function updatePlayer(isLive, playbackId) {
  const stateKey = isLive ? `live:${playbackId}` : 'offline';
  if (stateKey === currentPlayerLiveState) return; // ничего не изменилось — не трогаем видео
  currentPlayerLiveState = stateKey;

  const video = document.getElementById('playerVideo');
  const offline = document.getElementById('playerOffline');

  if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }

  if (!isLive || !playbackId) {
    video.classList.add('hidden');
    offline.classList.remove('hidden');
    return;
  }

  offline.classList.add('hidden');
  video.classList.remove('hidden');
  const src = `/media/live/${playbackId}/index.m3u8`;

  if (window.Hls && Hls.isSupported()) {
    hlsPlayer = new Hls();
    hlsPlayer.loadSource(src);
    hlsPlayer.attachMedia(video);

    const playerReconnectScheduler = createReconnectScheduler(
      () => new Promise((resolve) => {
        hlsPlayer.loadSource(src);
        hlsPlayer.once(Hls.Events.MANIFEST_PARSED, () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      }),
      () => { offline.classList.remove('hidden'); video.classList.add('hidden'); }
    );

    hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        playerReconnectScheduler.start();
      }
    });
  } else {
    video.src = src;
  }
  video.play().catch(() => {});
}

async function copyStreamKey() {
  try {
    if (!fullStreamKey) {
      const data = await api('/workbench/stream-key/reveal', { method: 'POST' });
      fullStreamKey = data.streamKey;
    }
    await navigator.clipboard.writeText(fullStreamKey);
    showToast('success', 'Ключ скопирован');
  } catch (err) {
    showToast('error', err.message || 'Не удалось скопировать — возможно, ключ ещё не создан');
  }
}

async function saveSettings() {
  const body = {
    streamTitle: document.getElementById('streamTitleInput').value,
    streamDescription: document.getElementById('streamDescInput').value,
  };
  try {
    await api('/workbench/settings', { method: 'PATCH', body });
    showToast('success', 'Сохранено');
  } catch (err) {
    showToast('error', err.message || 'Не удалось сохранить');
  }
}

// ---- чат ----

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildMessageHtml(msg) {
  if (msg.deleted) return `<span class="wb-msg-deleted">Сообщение удалено администратором</span>`;
  return `
    <button type="button" class="wb-mod-btn" title="Удалить" onclick="deleteMessage('${msg._id}')">🗑️</button>
    <button type="button" class="wb-mod-btn" title="Заблокировать" onclick="openBanConfirm('${msg.senderId}', '${escapeHtml(msg.senderUsername)}')">🚫</button>
    <button type="button" class="wb-mod-btn" title="Ограничить чат" onclick="openTimeoutModal('${msg.senderId}', '${escapeHtml(msg.senderUsername)}')">⏱️</button>
    <span class="wb-msg-author">${escapeHtml(msg.senderUsername)}:</span>
    <span class="wb-msg-text">${escapeHtml(msg.text)}</span>
  `;
}

function renderMessage(msg) {
  const box = document.getElementById('chatMessages');
  const row = document.createElement('div');
  row.className = 'wb-chat-msg';
  row.dataset.id = msg._id;
  row.innerHTML = buildMessageHtml(msg);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function handleChatKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChatMessage();
  }
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { text });
  input.value = '';
}

function deleteMessage(messageId) {
  socket?.emit('chat:delete', { messageId });
}

function onClearChatClick() {
  if (confirm('Очистить весь чат для всех зрителей?')) {
    socket?.emit('chat:clear');
  }
}

function copyRtmpUrl() {
  navigator.clipboard.writeText('rtmp://live.partywatcher.de/live')
    .then(() => showToast('success', 'Адрес сервера скопирован'))
    .catch(() => showToast('error', 'Не удалось скопировать'));
}

function openBanConfirm(userId, username) {
  if (confirm(`Заблокировать пользователя ${username} навсегда?`)) {
    socket?.emit('chat:ban', { userId, username });
  }
}

function openTimeoutModal(userId, username) {
  timeoutTarget = { userId, username };
  document.getElementById('timeoutModalName').textContent = `Ограничить чат: ${username}`;
  document.getElementById('timeoutModal').classList.remove('hidden');
}

function closeTimeoutModal() {
  document.getElementById('timeoutModal').classList.add('hidden');
  timeoutTarget = null;
}

function confirmTimeout() {
  if (!timeoutTarget) return;
  const h = parseInt(document.getElementById('timeoutHours').value, 10) || 0;
  const m = parseInt(document.getElementById('timeoutMinutes').value, 10) || 0;
  const s = parseInt(document.getElementById('timeoutSeconds').value, 10) || 0;
  const seconds = h * 3600 + m * 60 + s;
  if (seconds <= 0) return;
  socket.emit('chat:timeout', { userId: timeoutTarget.userId, username: timeoutTarget.username, seconds });
  closeTimeoutModal();
}

let chatReconnectScheduler = null;

function initChat(streamerNameLower) {
  // reconnection: false — отключаем встроенную схему socket.io, управляем сами по своему графику
  socket = io('/chat', { reconnection: false });

  const bindSocketEvents = () => {
    socket.on('chat:history', (messages) => {
      document.getElementById('chatMessages').innerHTML = '';
      messages.forEach(renderMessage);
    });

    socket.on('chat:message', renderMessage);

    socket.on('chat:message-deleted', ({ messageId }) => {
      const row = document.querySelector(`.wb-chat-msg[data-id="${messageId}"]`);
      if (row) row.innerHTML = buildMessageHtml({ deleted: true });
    });

    socket.on('chat:viewers', (count) => {
      document.getElementById('viewersCount').textContent = count;
    });

    socket.on('chat:cleared', () => {
      document.getElementById('chatMessages').innerHTML = '';
    });

    socket.on('action:logged', (entry) => renderActionLogEntry(entry, true));
  };

  socket.on('connect', () => {
    chatReconnectScheduler?.reset();
    socket.emit('chat:join', { streamerName: streamerNameLower });
  });

  socket.on('disconnect', () => {
    chatReconnectScheduler?.start();
  });

  bindSocketEvents();

  chatReconnectScheduler = createReconnectScheduler(
    () => new Promise((resolve) => {
      socket.connect();
      socket.once('connect', () => resolve(true));
      setTimeout(() => resolve(socket.connected), 1500); // не ждём вечно один попыточный тик
    }),
    () => showToast('error', 'Не удалось восстановить соединение с чатом. Обнови страницу.')
  );
}

let liveStatusPollTimer = null;

function startLiveStatusPolling() {
  clearInterval(liveStatusPollTimer);
  liveStatusPollTimer = setInterval(async () => {
    try {
      const data = await api('/workbench/me?_=' + Date.now());
      updatePlayer(data.isLive, data.streamPlaybackId);
    } catch (err) {
      console.warn('[liveStatusPoll]', err.message);
    }
  }, 5000);
}

function goToMyStreamerProfile() {
  if (myStreamerNameLower) location.href = `/streamers/${encodeURIComponent(myStreamerNameLower)}`;
}

async function init() {
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    location.href = '/index.html';
    return;
  }
  if (!me.streamerName) {
    location.href = '/streamers/edit.html';
    return;
  }
  myStreamerNameLower = me.streamerName.toLowerCase();

  await loadLayout();
  initDraggablePanels();
  await loadSettings();
  await loadActionLog();
  initChat(myStreamerNameLower);
  startLiveStatusPolling();
}

init();