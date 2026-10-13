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

let chatApiOpen = false;
let chatApiExtraH = 0;

function readCurrentRect(el) {
  // пока API-блок раскрыт, окно чата выше на его высоту — в layout это не сохраняем
  const extra = el.id === 'chatPanel' && chatApiOpen ? chatApiExtraH : 0;
  return {
    x: parseInt(el.style.left, 10) || 0,
    y: parseInt(el.style.top, 10) || 0,
    w: el.offsetWidth,
    h: Math.max(120, el.offsetHeight - extra),
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

  // API-блок над чатом сворачиваем без пересчёта высоты: applyLayout уже вернул окну исходный размер
  if (chatApiOpen) {
    document.getElementById('chatApiBlock')?.classList.add('hidden');
    document.getElementById('chatApiToggle')?.classList.remove('open');
    chatApiOpen = false;
    chatApiExtraH = 0;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// режим чата в журнале: details = «chatSlowSec=30» | «chatFollowMin=off» | «chatFilter=2»
function chatModeLogLabel(details) {
  const [field, raw] = String(details || '').split('=');
  const off = raw === 'off' || raw === '0' && field !== 'chatFollowMin';
  const n = Number(raw);
  if (field === 'chatFollowMin') return off ? t('workbench.log.mode.followersOff') : n ? t('workbench.log.mode.followers', { n }) : t('workbench.log.mode.followersNow');
  if (field === 'chatSlowSec') return off ? t('workbench.log.mode.slowOff') : t('workbench.log.mode.slow', { n });
  if (field === 'chatFilter') return off ? t('workbench.log.mode.filterOff') : t('workbench.log.mode.filter', { n });
  return details;
}

function actionLogLabel(entry) {
  const name = entry.targetUsername || '';
  const details = entry.details || '';
  switch (entry.action) {
    case 'clear_chat': return t('workbench.log.clear_chat');
    case 'delete_message': return t('workbench.log.delete_message', { name });
    case 'ban': return t('workbench.log.ban', { name });
    case 'unban': return t('workbench.log.unban', { name });
    case 'timeout': return t('workbench.log.timeout', { name, details });
    case 'untimeout': return t('workbench.log.untimeout', { name });
    case 'raid': return t('workbench.log.raid', { name, details });
    case 'raid_cancel': return t('workbench.log.raid_cancel', { name });
    case 'chat_mode': return chatModeLogLabel(details);
    case 'edit_title': return t('workbench.log.edit_title', { details });
    case 'edit_desc': return t('workbench.log.edit_desc');
    case 'edit_category': return details ? t('workbench.log.edit_category', { details }) : t('workbench.log.clear_category');
    default: return entry.action;
  }
}

function renderActionLogEntry(entry, atTop = false) {
  const box = document.getElementById('actionLogList');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'wb-actionlog-row';
  const time = new Date(entry.createdAt || Date.now()).toLocaleTimeString(I18N.locale);
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
    const data = await api('/workbench/me?full=1&_=' + Date.now());
    document.getElementById('streamTitleInput').value = data.streamTitle || '';
    document.getElementById('streamDescInput').value = data.streamDescription || '';
    setCategory(data.category || null);
    document.getElementById('liveNoticeInput').value = data.liveNotice || '';
    document.getElementById('streamKeyInput').value = data.streamKeyMasked || '';
    setGenerateBtnState(!!data.streamKeyMasked);
    setChatApiKeyUi(data.chatApiKeyMasked);
    updatePlayer(data.isLive, data.streamPlaybackId, data.liveStartedAt);
  } catch (err) {
    console.warn('[loadSettings]', err.message);
  }
}

function setGenerateBtnState(hasKey) {
  const btn = document.getElementById('generateKeyBtn');
  btn.textContent = hasKey ? '🔄' : t('workbench.key.generate');
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
    showToast('success', t('workbench.key.generated'));
  } catch (err) {
    showToast('error', err.message || t('workbench.key.generateFailed'));
  }
}

let currentPlayerLiveState = null;
let playerReconnectScheduler = null;
let liveStatusPollTimer = null;
let liveSinceTs = null;       // timestamp старта текущего эфира (для таймера)
let liveTimerInterval = null;

function formatLiveDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function setLiveBadge(mode) {
  // mode: 'offline' | 'live' | 'reconnecting'
  const badge = document.getElementById('liveStatusBadge');
  const label = document.getElementById('liveStatusLabel');
  const timer = document.getElementById('liveStatusTimer');
  if (!badge || !label || !timer) return;

  badge.classList.remove('is-live', 'is-reconnecting');
  if (mode === 'live') {
    badge.classList.add('is-live');
    label.textContent = t('workbench.status.live');
  } else if (mode === 'reconnecting') {
    badge.classList.add('is-reconnecting');
    label.textContent = t('workbench.status.reconnecting');
  } else {
    label.textContent = t('workbench.status.offline');
    timer.textContent = '00:00:00';
  }
}

function startLiveTimer() {
  stopLiveTimer();
  if (!liveSinceTs) liveSinceTs = Date.now();
  const tick = () => {
    const el = document.getElementById('liveStatusTimer');
    if (el && liveSinceTs) el.textContent = formatLiveDuration(Date.now() - liveSinceTs);
  };
  tick();
  liveTimerInterval = setInterval(tick, 1000);
}

function stopLiveTimer() {
  if (liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
}

function showReconnectingOverlay(show) {
  const el = document.getElementById('playerReconnecting');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

function destroyPlayer({ soft = false } = {}) {
  if (playerReconnectScheduler) {
    try { playerReconnectScheduler.reset?.(); } catch (_) {}
    playerReconnectScheduler = null;
  }
  if (hlsPlayer) {
    try { hlsPlayer.destroy(); } catch (_) {}
    hlsPlayer = null;
  }
  const video = document.getElementById('playerVideo');
  if (video && !soft) {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch (_) {}
  }
}

function isPlayerStuck() {
  const video = document.getElementById('playerVideo');
  if (!video || video.classList.contains('hidden')) return false;
  if (video.error) return true;
  if (video.ended) return true;
  if (video.duration > 0 && video.duration < 2.5 && video.readyState >= 1) return true;
  if (video.readyState === 0 && currentPlayerLiveState?.startsWith('live:')) return true;
  return false;
}

function lockToLiveEdge(video) {
  if (video.dataset.liveLockAttached) return;
  video.dataset.liveLockAttached = '1';
  video.addEventListener('seeking', () => {
    if (!video.seekable.length) return;
    const liveEdge = video.seekable.end(video.seekable.length - 1);
    const minAllowed = Math.max(0, liveEdge - 3); // не даём уйти дальше 3с от края
    if (video.currentTime < minAllowed) {
      video.currentTime = liveEdge;
    }
  });
}

function attachHls(playbackId) {
  const video = document.getElementById('playerVideo');
  const offline = document.getElementById('playerOffline');
  lockToLiveEdge(video);
  const src = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;

  hlsPlayer = new Hls({
    enableWorker: true,
    // превью в студии маленькое: не декодируем «источник» во время собственного эфира (меньше нагрузки на ПК стримера)
    capLevelToPlayerSize: true,
    lowLatencyMode: false,
    liveSyncDurationCount: 2,        // ближе к живому краю (было 3)
    liveMaxLatencyDurationCount: 4,  // было 8 — раньше давали отставать почти на весь плейлист
    maxLiveSyncPlaybackRate: 1.15,   // если отстали — тихо ускоряется и догоняет эфир вместо рывка
    backBufferLength: 6,             // не копим старый буфер — скраблить назад по сути нечего
    liveDurationInfinity: true,      // помечаем поток как «живой», а не VOD с концом
    manifestLoadingMaxRetry: 8,
    levelLoadingMaxRetry: 8,
    fragLoadingMaxRetry: 8,
    manifestLoadingRetryDelay: 1000,
    levelLoadingRetryDelay: 1000,
  });
  hlsPlayer.loadSource(src);
  hlsPlayer.attachMedia(video);

  hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
    showReconnectingOverlay(false);
    setLiveBadge('live');
    video.play().catch(() => {});
  });

  playerReconnectScheduler = createReconnectScheduler(
    () =>
      new Promise((resolve) => {
        if (!hlsPlayer) return resolve(false);
        setLiveBadge('reconnecting');
        showReconnectingOverlay(true);
        const retrySrc = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;
        hlsPlayer.loadSource(retrySrc);
        const onParsed = () => {
          cleanup();
          showReconnectingOverlay(false);
          setLiveBadge('live');
          video.play().catch(() => {});
          resolve(true);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, 4000);
        function cleanup() {
          clearTimeout(timer);
          hlsPlayer?.off(Hls.Events.MANIFEST_PARSED, onParsed);
        }
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, onParsed);
      }),
    () => {
      // исчерпали попытки — не прячем плеер сразу; поллинг решит offline/live
      showReconnectingOverlay(true);
      setLiveBadge('reconnecting');
    }
  );

  hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
    if (!data?.fatal) return;
    setLiveBadge('reconnecting');
    showReconnectingOverlay(true);
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      playerReconnectScheduler?.start();
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try {
        hlsPlayer.recoverMediaError();
      } catch (_) {
        // мягкий пересоздать без сброса offline UI
        destroyPlayer({ soft: true });
        attachHls(playbackId);
      }
    } else {
      destroyPlayer({ soft: true });
      attachHls(playbackId);
    }
  });
}

function updatePlayer(isLive, playbackId, liveStartedAt) {
  const stateKey = isLive && playbackId ? `live:${playbackId}` : 'offline';
  const video = document.getElementById('playerVideo');
  const offline = document.getElementById('playerOffline');
  if (!video || !offline) return;

  if (stateKey === currentPlayerLiveState) {
    // live→live: только если реально залипли — мягкий reload HLS, без мигания offline
    if (stateKey !== 'offline' && isPlayerStuck()) {
      console.warn('[player] залип — мягкий reload HLS');
      setLiveBadge('reconnecting');
      showReconnectingOverlay(true);
      destroyPlayer({ soft: true });
      offline.classList.add('hidden');
      video.classList.remove('hidden');
      if (window.Hls && Hls.isSupported()) {
        attachHls(playbackId);
      } else {
        video.src = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;
        video.play().catch(() => {});
      }
    }
    // подтянуть таймер с сервера, если пришёл liveStartedAt
    if (isLive && liveStartedAt) {
      liveSinceTs = new Date(liveStartedAt).getTime();
      if (!liveTimerInterval) startLiveTimer();
    }
    return;
  }

  const wasLive = currentPlayerLiveState?.startsWith('live:');
  currentPlayerLiveState = stateKey;

  if (!isLive || !playbackId) {
    destroyPlayer();
    video.classList.add('hidden');
    offline.classList.remove('hidden');
    showReconnectingOverlay(false);
    setLiveBadge('offline');
    // если сервер ещё держит liveStartedAt (grace) — помним точку старта, таймер не обнуляем
    if (liveStartedAt) {
      liveSinceTs = new Date(liveStartedAt).getTime();
    } else {
      liveSinceTs = null;
    }
    stopLiveTimer(); // не тикаем в офлайне; при возврате в эфир — продолжим с liveSinceTs
    return;
  }

  // offline → live или смена playbackId
  offline.classList.add('hidden');
  video.classList.remove('hidden');
  showReconnectingOverlay(false);

  if (liveStartedAt) {
    liveSinceTs = new Date(liveStartedAt).getTime();
  } else if (!wasLive || !liveSinceTs) {
    liveSinceTs = Date.now();
  }
  setLiveBadge('live');
  startLiveTimer();

  destroyPlayer({ soft: true });

  if (window.Hls && Hls.isSupported()) {
    attachHls(playbackId);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;
    video.play().catch(() => {});
  }
  video.play().catch(() => {});
}

function startLiveStatusPolling() {
  clearInterval(liveStatusPollTimer);
  liveStatusPollTimer = setInterval(async () => {
    try {
      const data = await api('/workbench/me?_=' + Date.now());
      updatePlayer(!!data.isLive, data.streamPlaybackId, data.liveStartedAt);
    } catch (err) {
      console.warn('[liveStatusPoll]', err.message);
    }
  }, 3000);
}

async function copyStreamKey() {
  try {
    if (!fullStreamKey) {
      const data = await api('/workbench/stream-key/reveal', { method: 'POST' });
      fullStreamKey = data.streamKey;
    }
    await navigator.clipboard.writeText(fullStreamKey);
    showToast('success', t('workbench.key.copied'));
  } catch (err) {
    showToast('error', err.message || t('workbench.key.copyFailed'));
  }
}

async function saveSettings() {
  const body = {
    streamTitle: document.getElementById('streamTitleInput').value,
    streamDescription: document.getElementById('streamDescInput').value,
    streamCategoryId: chosenCategory ? chosenCategory.id : '',
    liveNotice: document.getElementById('liveNoticeInput').value,
  };
  try {
    const r = await api('/workbench/settings', { method: 'PATCH', body });
    setCategory(r.category || null);
    showToast('success', t('common.saved'));
  } catch (err) {
    showToast('error', err.message || t('common.saveFailed'));
  }
}

// ---- категория эфира (поиск через сервер → Twitch; сохраняется кнопкой «Сохранить» вместе с названием) ----

let chosenCategory = null; // { id, name, ru, cover|box }
let catTimer = null;
let catSeq = 0;

const catTitle = (c) => (I18N.lang === 'ru' && c.ru) || c.name;

function catThumb(url) {
  const img = document.createElement(url ? 'img' : 'span');
  img.className = 'cat-thumb';
  if (url) { img.src = url; img.alt = ''; img.loading = 'lazy'; }
  return img;
}

function setCategory(c) {
  chosenCategory = c;
  const box = document.getElementById('catCurrent');
  if (!box) return;
  box.innerHTML = '';
  if (!c) {
    const none = document.createElement('span');
    none.className = 'cat-none';
    none.textContent = t('workbench.settings.categoryNone');
    box.appendChild(none);
    return;
  }
  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = catTitle(c);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'cat-clear';
  clear.textContent = '×';
  clear.title = t('workbench.settings.categoryClear');
  clear.addEventListener('click', () => setCategory(null));
  box.append(catThumb(c.cover || c.box), name, clear);
}

function hideCatResults() {
  document.getElementById('catResults')?.classList.add('hidden');
}

function renderCatResults(list) {
  const box = document.getElementById('catResults');
  box.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'cat-empty';
    p.textContent = t('workbench.settings.categoryNothing');
    box.appendChild(p);
  }
  for (const c of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cat-row';
    const name = document.createElement('span');
    name.textContent = catTitle(c);
    row.append(catThumb(c.box), name);
    // mousedown раньше blur поля — иначе список исчез бы до клика
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setCategory(c);
      document.getElementById('catSearchInput').value = '';
      hideCatResults();
    });
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

async function initCategoryPicker() {
  const input = document.getElementById('catSearchInput');
  if (!input) return;
  try {
    const cfg = await api('/categories/config');
    if (!cfg.enabled) {
      input.disabled = true;
      document.getElementById('catOff').classList.remove('hidden');
    }
  } catch (_) {}
  input.addEventListener('input', () => {
    clearTimeout(catTimer);
    const q = input.value.trim();
    if (q.length < 2) return hideCatResults();
    catTimer = setTimeout(async () => {
      const my = ++catSeq;
      try {
        const list = await api('/categories/search?q=' + encodeURIComponent(q));
        if (my === catSeq) renderCatResults(list);
      } catch (err) {
        if (my === catSeq) showToast('error', err.message);
      }
    }, 350);
  });
  input.addEventListener('blur', () => setTimeout(hideCatResults, 150));
  window.addEventListener('pw:langchange', () => setCategory(chosenCategory));
}

initCategoryPicker();

// ---- чат ----

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildMessageHtml(msg) {
  if (msg.deleted) return `<span class="wb-msg-deleted">${t('workbench.chat.deletedByAdmin')}</span>`;
  if (msg.source === 'raid') return `<span class="wb-raid-msg">🚀 ${escapeHtml(PWRaid.messageText(msg))}</span>`;
  const hl = msg.highlight ? ' wb-msg-hl' : '';

  // данные кнопок лежат в data-атрибутах (клики ловит общий обработчик внизу файла), а не в onclick
  const delBtn = `<button type="button" class="wb-mod-btn" title="${t('common.delete')}" data-act="del" data-id="${escapeHtml(msg._id)}">🗑️</button>`;

  // бан и таймаут — только для сообщений реальных юзеров (у сообщений из API юзера нет)
  const userBtns = !msg.external && msg.senderId ? `
    <button type="button" class="wb-mod-btn" title="${t('common.mod.ban')}" data-act="ban" data-uid="${escapeHtml(msg.senderId)}" data-name="${escapeHtml(msg.senderUsername)}">🚫</button>
    <button type="button" class="wb-mod-btn" title="${t('common.mod.timeout')}" data-act="timeout" data-uid="${escapeHtml(msg.senderId)}" data-name="${escapeHtml(msg.senderUsername)}">⏱️</button>
  ` : '';

  // метка источника у внешних сообщений видна всегда — выдать бота за зрителя незаметно нельзя
  const src = msg.external
    ? `<span class="wb-msg-src">${escapeHtml(msg.source || 'api')}</span>`
    : '';

  const nickCls = 'wb-msg-author' + (msg.isOwner ? ' wb-msg-author--owner' : '');
  const nickStyle = !msg.isOwner && /^#[0-9a-f]{6}$/i.test(msg.nickColor || '')
    ? ` style="color:${msg.nickColor}"`
    : '';

  return `
    ${delBtn}${userBtns}
    ${src}
    <span class="wb-msg-author-wrap">${window.PWBadges ? PWBadges.html(msg.modLevel) : ''}<span class="${nickCls}"${nickStyle}>${escapeHtml(I18N.sysName(msg.senderUsername))}</span>:</span>
    <span class="wb-msg-text${hl}">${window.PWEmotes ? PWEmotes.render(escapeHtml(msg.text), msg.emotes) : escapeHtml(msg.text)}</span>
  `;
}

function renderMessage(msg) {
  const box = document.getElementById('chatMessages');
  const row = document.createElement('div');
  row.className = 'wb-chat-msg';
  row.dataset.id = msg._id;
  row.innerHTML = buildMessageHtml(msg);
  box.appendChild(row);
  // студия открыта весь эфир — держим последние сообщения, а не тысячи узлов
  while (box.childElementCount > 250) box.firstElementChild.remove();
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

async function onClearChatClick() {
  const ok = await PW.confirm(t('common.chat.clearText'), {
    title: t('common.chat.clearTitle'),
    okText: t('common.chat.clearOk'),
    danger: true,
  });
  if (ok) socket?.emit('chat:clear');
}

function copyRtmpUrl() {
  navigator.clipboard.writeText('rtmp://live.partywatcher.de/live')
    .then(() => showToast('success', t('workbench.key.serverCopied')))
    .catch(() => showToast('error', t('workbench.copyFailed')));
}

async function openBanConfirm(userId, username) {
  const ok = await PW.confirm(t('common.mod.banText', { name: username }), {
    title: t('common.mod.banTitle'),
    okText: t('common.mod.ban'),
    danger: true,
  });
  if (ok) socket?.emit('chat:ban', { userId, username });
}

function openTimeoutModal(userId, username) {
  timeoutTarget = { userId, username };
  document.getElementById('timeoutModalName').textContent = t('workbench.timeout.title', { name: username });
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
let wbRaidBar = null;

// ---- 😀 смайлы канала: окно управления и выбор у поля чата ----
let emoteImage = null; // data:URL выбранной картинки (уменьшенной; GIF — как есть)

function renderEmotes(data) {
  const lim = data.limits;
  document.getElementById('emoteLimits').textContent =
    t('common.emotes.limits', { n: lim.count, max: lim.max, p: lim.publicCount, pmax: lim.publicMax });
  const list = document.getElementById('emoteList');
  list.innerHTML = '';
  if (!data.emotes.length) {
    const p = document.createElement('p');
    p.className = 'wb-hint';
    p.textContent = t('common.emotes.empty');
    list.appendChild(p);
    return;
  }
  for (const e of data.emotes) {
    const card = document.createElement('div');
    card.className = 'emote-card';
    card.innerHTML = `<img src="${PWEmotes.imgUrl(e.id)}" alt="" /><code>:${escapeHtml(e.code)}:</code>`;
    const pub = document.createElement('label');
    pub.className = 'emote-card-pub';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.isPublic;
    cb.disabled = e.animated;
    pub.title = e.animated ? t('common.emotes.animatedNoPublic') : t('common.emotes.publicHint');
    cb.addEventListener('change', async () => {
      try {
        renderEmotes(await api('/emotes/' + e.id, { method: 'PATCH', body: { isPublic: cb.checked } }).then(() => api('/emotes/mine')));
      } catch (err) {
        cb.checked = !cb.checked;
        showToast('error', err.message);
      }
    });
    const pubTxt = document.createElement('span');
    pubTxt.textContent = t('common.emotes.public');
    pub.append(cb, pubTxt);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'emote-del';
    del.textContent = '✕';
    del.title = t('common.delete');
    del.addEventListener('click', async () => {
      const ok = await PW.confirm(t('common.emotes.deleteConfirm', { code: e.code }), { danger: true, okText: t('common.delete') });
      if (!ok) return;
      try {
        await api('/emotes/' + e.id, { method: 'DELETE' });
        renderEmotes(await api('/emotes/mine'));
      } catch (err) {
        showToast('error', err.message);
      }
    });
    card.append(pub, del);
    list.appendChild(card);
  }
}

async function openEmoteModal() {
  document.getElementById('emoteModal').classList.remove('hidden');
  try {
    renderEmotes(await api('/emotes/mine'));
  } catch (err) {
    showToast('error', err.message);
  }
}

// статичную картинку уменьшаем до 112 px (webp), GIF оставляем как есть — иначе пропадёт анимация
function readEmoteFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(t('common.emotes.badImage')));
    if (file.type === 'image/gif') {
      if (file.size > 256 * 1024) return reject(new Error(t('common.emotes.gifBig')));
      fr.onload = () => resolve(String(fr.result));
      return fr.readAsDataURL(file);
    }
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 112 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        let url = c.toDataURL('image/webp', 0.9);
        if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
        resolve(url);
      };
      img.onerror = () => reject(new Error(t('common.emotes.badImage')));
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });
}

(function initEmotes() {
  const modal = document.getElementById('emoteModal');
  if (!modal || !window.PWEmotes) return;
  document.getElementById('emoteModalClose').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('emoteFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      emoteImage = await readEmoteFile(f);
      document.getElementById('emotePreview').innerHTML = `<img src="${emoteImage}" alt="" />`;
      const pub = document.getElementById('emotePublic');
      pub.disabled = f.type === 'image/gif';
      if (pub.disabled) pub.checked = false;
      const code = document.getElementById('emoteCode');
      if (!code.value) code.value = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    } catch (err) {
      emoteImage = null;
      showToast('error', err.message);
    }
  });
  document.getElementById('emoteUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!emoteImage) return showToast('error', t('common.emotes.pickFile'));
    try {
      await api('/emotes', {
        method: 'POST',
        body: { code: document.getElementById('emoteCode').value.trim(), image: emoteImage, isPublic: document.getElementById('emotePublic').checked },
      });
      emoteImage = null;
      e.target.reset();
      document.getElementById('emotePreview').textContent = '＋';
      document.getElementById('emotePublic').disabled = false;
      renderEmotes(await api('/emotes/mine'));
      showToast('success', t('common.emotes.added'));
    } catch (err) {
      showToast('error', err.message);
    }
  });
  const row = document.querySelector('.wb-chat-input-row');
  const input = document.getElementById('chatInput');
  if (row && input) PWEmotes.mountPicker({ form: row, input, channel: () => myStreamerNameLower, before: row.querySelector('button') });
})();

document.getElementById('wbRaidBtn')?.addEventListener('click', () => {
  PWRaid.openPicker({ self: myStreamerNameLower, onStart: (to, seconds) => socket?.emit('chat:raid-start', { to, seconds }) });
});

// ---- команды модерации «/ban имя» и т.п.: подсказка у поля чата (js/chat-slash.js), права — из chat:role ----
let wbChatPerms = [];
window.PWChatSlash?.attach(document.getElementById('chatInput'), () => wbChatPerms);

// ---- 🎁 у поля чата: свои награды — стример проверяет их бесплатно (поинты у владельца бесконечные) ----
// окно — общий модуль js/rewards-popup.js; награда срабатывает по-настоящему (чат, OBS, бот), в «Покупках» — с пометкой «проверка»
let wbPoints = null;
const wbRewardsPop = (function initWbRewards() {
  const btn = document.getElementById('wbRewardsBtn');
  const box = document.getElementById('wbRewardsPopup');
  if (!btn || !box || !window.PWRewardsPopup) return null;
  const pop = PWRewardsPopup.create(box, {
    state: () => ({ rewards: wbPoints?.rewards || [], balance: 0, owner: true }),
    label: () => wbPoints?.pointsName || t('common.points.default'),
    redeem: (r, message) => api('/points/' + encodeURIComponent(myStreamerNameLower) + '/redeem', { method: 'POST', body: { rewardId: r.id, message } }),
  });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!box.classList.toggle('hidden')) {
      pop.reset();
      pop.render();
      try {
        wbPoints = await api('/points/' + encodeURIComponent(myStreamerNameLower));
        pop.render();
      } catch (err) {
        showToast('error', err.message);
      }
    }
  });
  box.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => box.classList.add('hidden'));
  window.addEventListener('pw:langchange', () => { if (!box.classList.contains('hidden')) pop.render(); });
  return pop;
})();

// ---- меню ⚙ у чата: «только подписчики», медленный режим, фильтр слов (js/chat-mode.js) ----
// режим хранит сервер, сюда он приходит событием chat:mode
let chatModeUi = null;

(function initChatModeUi() {
  const btn = document.getElementById('wbChatModeBtn');
  const pop = document.getElementById('wbChatModePopup');
  if (!btn || !pop || !window.PWChatMode) return;
  // внизу меню — смайлы канала (только в студии: управляет ими стример)
  const emoBtn = document.createElement('button');
  emoBtn.type = 'button';
  emoBtn.className = 'icon-btn';
  emoBtn.setAttribute('data-i18n', 'common.emotes.manageBtn');
  emoBtn.textContent = t('common.emotes.manageBtn');
  emoBtn.addEventListener('click', () => { pop.classList.add('hidden'); openEmoteModal(); });
  chatModeUi = PWChatMode.mount(pop, (patch) => socket?.emit('chat:set-mode', patch), emoBtn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('hidden');
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => pop.classList.add('hidden'));
})();

window.addEventListener('pw:langchange', (e) => socket?.emit('lang:set', e.detail.lang)); // язык ответов бота
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

    socket.on('chat:viewers', (payload) => {
      if (typeof payload === 'number') {
        setViewersCount(payload);
        return;
      }
      setViewersCount(payload?.count ?? 0);
      renderViewersList(payload?.viewers || []);
    });

    socket.on('chat:cleared', () => {
      document.getElementById('chatMessages').innerHTML = '';
    });

    socket.on('action:logged', (entry) => renderActionLogEntry(entry, true));
    // рейд: у стримера — плашка с «Отменить», сообщение и баннер, когда рейдят его
    socket.on('chat:raid', (ev) => {
      wbRaidBar = PWRaid.banner(document.getElementById('wbRaidSlot'), ev, { canCancel: true, onCancel: () => socket?.emit('chat:raid-cancel') });
    });
    socket.on('chat:raid-cancelled', () => { wbRaidBar?.destroy(); wbRaidBar = null; showToast('success', t('common.raid.cancelled')); });
    socket.on('chat:raid-go', () => { wbRaidBar?.destroy(); wbRaidBar = null; showToast('success', t('common.raid.sent')); });
    socket.on('chat:raid-error', ({ error } = {}) => showToast('error', error || t('common.requestFailed')));
    socket.on('chat:role', (rp) => { wbChatPerms = Array.isArray(rp?.perms) ? rp.perms : []; });
    socket.on('chat:cmd-result', ({ ok, text } = {}) => showToast(ok ? 'success' : 'error', text || t('common.requestFailed')));
    socket.on('chat:raided', (raid) => PWRaid.raided(document.getElementById('wbRaidSlot'), raid));
    socket.on('chat:mode', (mode = {}) => {
      chatModeUi?.set(mode);
      document.getElementById('wbChatModeBtn')?.classList.toggle('on', PWChatMode.isActive(mode));
    });
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
    () => showToast('error', t('workbench.chat.reconnectFailed'))
  );
}


function goToMyStreamerProfile() {
  if (myStreamerNameLower) location.href = `/streamers/${encodeURIComponent(myStreamerNameLower)}`;
}

async function init() {
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    location.href = '/';
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

// ---- API чата ----

let chatApiFullKey = null;

function setChatApiKeyUi(masked) {
  const input = document.getElementById('chatApiKeyInput');
  const btn = document.getElementById('chatApiGenerateBtn');
  if (input) input.value = masked || '';
  if (btn) btn.textContent = masked ? '🔄' : t('workbench.key.generate');
}

function toggleChatApi() {
  const panel = document.getElementById('chatPanel');
  const block = document.getElementById('chatApiBlock');
  const toggle = document.getElementById('chatApiToggle');
  if (!panel || !block || !toggle) return;

  if (!chatApiOpen) {
    block.classList.remove('hidden');
    chatApiExtraH = block.offsetHeight;
    chatApiOpen = true;
    panel.style.height = (panel.offsetHeight + chatApiExtraH) + 'px'; // удлиняем чат на высоту блока
  } else {
    panel.style.height = Math.max(120, panel.offsetHeight - chatApiExtraH) + 'px';
    block.classList.add('hidden');
    chatApiOpen = false;
    chatApiExtraH = 0;
  }

  toggle.classList.toggle('open', chatApiOpen);
  toggle.setAttribute('aria-expanded', String(chatApiOpen));
}

function onChatApiGenerateClick() {
  if (document.getElementById('chatApiKeyInput').value) {
    document.getElementById('chatKeyRegenModal').classList.remove('hidden');
  } else {
    doGenerateChatKey();
  }
}

function closeChatKeyRegen() {
  document.getElementById('chatKeyRegenModal').classList.add('hidden');
}

function confirmChatKeyRegen() {
  closeChatKeyRegen();
  doGenerateChatKey();
}

async function doGenerateChatKey() {
  try {
    const data = await api('/workbench/chat-key/generate', { method: 'POST' });
    chatApiFullKey = data.chatApiKey;
    setChatApiKeyUi(data.chatApiKeyMasked);
    showToast('success', t('workbench.chatApi.generated'));
  } catch (err) {
    showToast('error', err.message || t('workbench.chatApi.generateFailed'));
  }
}

async function getChatApiKey() {
  if (!chatApiFullKey) {
    const data = await api('/workbench/chat-key/reveal', { method: 'POST' });
    chatApiFullKey = data.chatApiKey;
  }
  return chatApiFullKey;
}

async function copyChatApiKey() {
  try {
    const key = await getChatApiKey();
    await navigator.clipboard.writeText(key);
    showToast('success', t('workbench.chatApi.copied'));
  } catch (err) {
    showToast('error', err.message || t('workbench.key.copyFailed'));
  }
}

async function copyChatOverlayUrl() {
  try {
    const key = await getChatApiKey();
    const url = `${location.origin}/overlay/chat.html#key=${encodeURIComponent(key)}`;
    await navigator.clipboard.writeText(url);
    showToast('success', t('workbench.chatApi.obsCopied'));
  } catch (err) {
    showToast('error', err.message || t('workbench.key.copyFailed'));
  }
}

// ---- список зрителей ----

function setViewersCount(count) {
  const el = document.getElementById('viewersCount');
  if (el) el.textContent = String(count ?? 0);
}

function renderViewersList(viewers) {
  const list = document.getElementById('wbViewersList');
  if (!list) return;
  list.innerHTML = '';
  if (!viewers || !viewers.length) {
    list.innerHTML = `<div class="wb-viewer-row guest">${t('common.viewers.none')}</div>`;
    return;
  }
  viewers.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'wb-viewer-row' + (v.isGuest ? ' guest' : '');
    row.textContent = v.isGuest ? t('common.viewers.guests', { n: v.guests || 1 }) : v.username;
    list.appendChild(row);
  });
}

function toggleViewersPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('wbViewersPanel');
  const btn = document.getElementById('wbViewersBtn');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  btn?.classList.toggle('active', open);
}

// ---- мини-окно (Picture-in-Picture): тот же <video>, без второго потока ----

async function togglePip() {
  const video = document.getElementById('playerVideo');
  if (!video) return;

  if (document.pictureInPictureElement === video) {
    await document.exitPictureInPicture().catch(() => {});
    return;
  }

  const err = await PWMini.enterPip({
    video,
    streamer: myStreamerNameLower,
    returnPath: '/workbench.html',
  });
  if (err) showToast('error', err);
}

function bindPip() {
  const video = document.getElementById('playerVideo');
  const btn = document.getElementById('pipBtn');
  if (!video || !btn) return;

  const sync = () => {
    const on = document.pictureInPictureElement === video;
    btn.classList.toggle('active', on);
    btn.textContent = on ? t('workbench.player.backToPlayer') : t('workbench.player.mini');
  };

  video.addEventListener('enterpictureinpicture', sync);
  video.addEventListener('leavepictureinpicture', sync);
}

bindPip();

// кнопки модерации в чате: имя берётся из data-атрибута как обычный текст, выполнить код оно не может
document.getElementById('chatMessages')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.wb-mod-btn');
  if (!btn) return;
  const { act, id, uid, name } = btn.dataset;
  if (act === 'del') deleteMessage(id);
  else if (act === 'ban') openBanConfirm(uid, name);
  else if (act === 'timeout') openTimeoutModal(uid, name);
});

init();