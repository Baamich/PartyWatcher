function getNameFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || '').toLowerCase();
}

function initialLetter(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

let currentStreamer = null;
let cachedVods = [];
let liveOpen = false;
let liveHls = null;
let liveSocket = null;
let liveChatReconnect = null;
let livePlayerReconnect = null;
let liveIsAuthed = false;
let isOwnerFlag = false;

// ---------- профиль ----------

function renderProfile(streamer) {
  const banner = document.getElementById('banner');
  if (streamer.streamerBannerUrl) {
    banner.style.backgroundImage = `url('${streamer.streamerBannerUrl}')`;
  }

  const avatar = document.getElementById('profileAvatar');
  if (streamer.streamerAvatarUrl) {
    avatar.style.backgroundImage = `url('${streamer.streamerAvatarUrl}')`;
    avatar.textContent = '';
  } else {
    avatar.textContent = initialLetter(streamer.streamerName);
  }

  document.getElementById('liveBadge').classList.toggle('hidden', !streamer.isLive);
  document.getElementById('profileName').textContent = streamer.streamerName;

  const bio = (streamer.streamerBio || '').trim();
  const bioShortEl = document.getElementById('profileBioShort');
  const expandBtn = document.getElementById('bioExpandBtn');

  if (!bio) {
    bioShortEl.textContent = 'Описание пока не заполнено';
    expandBtn.classList.add('hidden');
  } else {
    bioShortEl.textContent = bio;
    expandBtn.classList.toggle('hidden', bio.length <= 120);
  }

  document.getElementById('bioModalName').textContent = streamer.streamerName;
  document.getElementById('bioModalText').textContent = bio || 'Описание пока не заполнено';
}

function openBioModal() { document.getElementById('bioModal').classList.remove('hidden'); }
function closeBioModal() { document.getElementById('bioModal').classList.add('hidden'); }
document.getElementById('bioModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'bioModal') closeBioModal();
});

async function checkOwnership(nameLower) {
  try {
    const me = await api('/auth/me');
    liveIsAuthed = true;
    if (me.streamerName && me.streamerName.toLowerCase() === nameLower) {
      isOwnerFlag = true;
      document.getElementById('ownerControls').classList.remove('hidden');
    }
  } catch {
    liveIsAuthed = false;
  }
}

// ---------- записи ----------

function vodEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderVodGrid(vods) {
  const grid = document.getElementById('vodGrid');
  grid.innerHTML = '';
  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    card.dataset.url = v.url;
    card.innerHTML = `
      <video src="${v.url}" controls preload="metadata"></video>
      <div class="vod-card-body">
        <div class="vod-card-title"></div>
        <div class="vod-card-meta"></div>
      </div>`;
    card.querySelector('.vod-card-title').textContent = v.title || 'Запись';
    card.querySelector('.vod-card-meta').textContent = new Date(v.createdAt).toLocaleString('ru-RU');
    grid.appendChild(card);
  });
}

function renderVodColumn(vods) {
  const list = document.getElementById('vodColumnList');
  list.innerHTML = '';
  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    card.innerHTML = `
      <video src="${v.url}" preload="metadata" muted></video>
      <div class="vod-card-body">
        <div class="vod-card-title"></div>
        <div class="vod-card-meta"></div>
      </div>`;
    card.querySelector('.vod-card-title').textContent = v.title || 'Запись';
    card.querySelector('.vod-card-meta').textContent = new Date(v.createdAt).toLocaleString('ru-RU');
    card.onclick = () => switchToVodPlayback(v);
    list.appendChild(card);
  });
}

function switchToVodPlayback(v) {
  closeLiveStrip();
  requestAnimationFrame(() => {
    const grid = document.getElementById('vodGrid');
    const target = grid.querySelector(`.vod-card[data-url="${CSS.escape(v.url)}"] video`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.play().catch(() => {});
    }
  });
}

async function loadVods(nameLower) {
  try {
    cachedVods = await api('/streamers/' + encodeURIComponent(nameLower) + '/vods');
  } catch (e) {
    console.warn('[loadVods]', e.message);
    cachedVods = [];
  }
  const hasVods = cachedVods.length > 0;
  renderVodGrid(cachedVods);
  renderVodColumn(cachedVods);
  document.getElementById('vodSection').classList.toggle('hidden', !hasVods || liveOpen);
  document.getElementById('vodColumn').classList.toggle('hidden', !hasVods || !liveOpen);
}

function switchVodLayout(open) {
  const hasVods = cachedVods.length > 0;
  document.getElementById('vodSection').classList.toggle('hidden', open || !hasVods);
  document.getElementById('vodColumn').classList.toggle('hidden', !open || !hasVods);
}

// ---------- аккордеон эфира ----------

function toggleLiveStrip() {
  liveOpen ? closeLiveStrip() : openLiveStrip();
}

function openLiveStrip() {
  if (liveOpen) return;
  liveOpen = true;
  document.getElementById('liveStrip').classList.add('open');
  document.getElementById('liveToggleChevronBtn').classList.add('open');
  document.getElementById('ownerWorkbenchBtn')?.classList.add('live-hidden');
  document.getElementById('ownerEditBtn')?.classList.add('live-hidden');
  switchVodLayout(true);
  startLiveSession();
}

function closeLiveStrip() {
  if (!liveOpen) return;
  liveOpen = false;
  document.getElementById('liveStrip').classList.remove('open');
  document.getElementById('liveToggleChevronBtn').classList.remove('open');
  document.getElementById('ownerWorkbenchBtn')?.classList.remove('live-hidden');
  document.getElementById('ownerEditBtn')?.classList.remove('live-hidden');
  switchVodLayout(false);
  stopLiveSession();
}

function startLiveSession() {
  const video = document.getElementById('liveVideo');
  const offline = document.getElementById('liveOffline');
  const overlay = document.getElementById('liveOverlay');
  const overlayText = document.getElementById('liveOverlayText');
  const startBtn = document.getElementById('liveStartBtn');

  if (currentStreamer?.isLive && currentStreamer?.streamPlaybackId) {
    offline.classList.add('hidden');
    overlay.classList.remove('hidden');
    overlayText.textContent = 'Загрузка эфира...';
    startBtn.classList.remove('hidden');
    startBtn.onclick = () => {
      video.muted = false;
      applyVolumeToLive(getSavedVolume());
      overlay.classList.add('hidden');
    };
    try {
      if (typeof Hls === 'undefined') throw new Error('hls.js не загрузился');
      attachLiveHls(currentStreamer.streamPlaybackId);
    } catch (e) {
      console.error('[live] не удалось запустить плеер:', e.message);
      overlay.classList.add('hidden');
      offline.classList.remove('hidden');
      offline.textContent = 'Не удалось загрузить плеер';
    }
  } else {
    video.classList.add('hidden');
    offline.classList.remove('hidden');
    overlay.classList.add('hidden');
  }

  connectLiveChat(getNameFromUrl());

  if (isOwnerFlag) {
    document.getElementById('liveOwnerBar').classList.remove('hidden');
    document.getElementById('liveClearChatBtn').classList.remove('hidden');
  }
}

function stopLiveSession() {
  if (liveHls) {
    try { liveHls.destroy(); } catch (_) {}
    liveHls = null;
  }
  livePlayerReconnect?.reset?.();
  livePlayerReconnect = null;

  const video = document.getElementById('liveVideo');
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
  video.classList.add('hidden');
  video.dataset.liveLockAttached = '';

  if (liveSocket) {
    liveSocket.removeAllListeners();
    liveSocket.disconnect();
    liveSocket = null;
  }
  liveChatReconnect?.reset?.();
  liveChatReconnect = null;

  document.getElementById('liveMessages').innerHTML = '';
  document.getElementById('liveVolumePopup').classList.add('hidden');
  document.getElementById('liveQualityPopup').classList.add('hidden');
  document.getElementById('liveViewersPanel')?.classList.remove('open');
  document.getElementById('liveViewersBtn')?.classList.remove('active');
  setViewersCount(0);
  renderViewersList([]);
}

document.getElementById('profileAvatarBtn')?.addEventListener('click', toggleLiveStrip);
document.getElementById('profileNameBtn')?.addEventListener('click', toggleLiveStrip);
document.getElementById('liveToggleChevronBtn')?.addEventListener('click', toggleLiveStrip);

// ---------- HLS-плеер + качество ----------

function lockToLiveEdge(video) {
  if (video.dataset.liveLockAttached) return;
  video.dataset.liveLockAttached = '1';
  video.addEventListener('seeking', () => {
    if (!video.seekable.length) return;
    const liveEdge = video.seekable.end(video.seekable.length - 1);
    const minAllowed = Math.max(0, liveEdge - 3);
    if (video.currentTime < minAllowed) video.currentTime = liveEdge;
  });
}

const QUALITY_STORAGE_KEY = 'pw_quality'; // 'auto' | 'source' | '720' | '480'

function getSavedQuality() {
  try { return localStorage.getItem(QUALITY_STORAGE_KEY) || 'auto'; } catch (_) { return 'auto'; }
}

function saveQuality(v) {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, v); } catch (_) {}
}

// имя уровня из master-плейлиста: source / 720 / 480
function levelKey(lvl) {
  if (lvl.name) return String(lvl.name);
  const uri = lvl.uri || (Array.isArray(lvl.url) ? lvl.url[0] : lvl.url) || '';
  const m = String(uri).match(/([^/]+)\/index\.m3u8/);
  return m ? m[1] : '';
}

function populateQualityMenu(levels) {
  const popup = document.getElementById('liveQualityPopup');
  popup.innerHTML = '';

  const items = levels.map((lvl, idx) => ({ idx, key: levelKey(lvl), height: lvl.height || 0 }));

  // применяем сохранённое качество (если такого уровня нет — авто)
  let saved = getSavedQuality();
  const savedItem = items.find((i) => i.key === saved);
  if (saved !== 'auto' && !savedItem) saved = 'auto';
  liveHls.currentLevel = saved === 'auto' ? -1 : savedItem.idx;

  const makeOption = (label, key, levelIndex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'live-quality-option';
    btn.textContent = label;
    if (key === saved) btn.classList.add('active');
    btn.onclick = () => {
      liveHls.currentLevel = levelIndex;
      saveQuality(key);
      popup.querySelectorAll('.live-quality-option').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      popup.classList.add('hidden');
    };
    return btn;
  };

  popup.appendChild(makeOption('Авто', 'auto', -1));

  // сначала источник, дальше по убыванию высоты
  items.sort((a, b) => (b.key === 'source') - (a.key === 'source') || b.height - a.height);

  items.forEach(({ idx, key, height }) => {
    const label = key === 'source'
      ? (height ? `Источник (${height}p)` : 'Источник')
      : (height ? `${height}p` : `Уровень ${idx}`);
    popup.appendChild(makeOption(label, key || `lvl${idx}`, idx));
  });
}

function attachLiveHls(playbackId) {
  const video = document.getElementById('liveVideo');
  lockToLiveEdge(video);
  applyVolumeToLive(getSavedVolume());

  const src = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;

  liveHls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 4,
    maxLiveSyncPlaybackRate: 1.15,
    backBufferLength: 6,
    liveDurationInfinity: true,
    manifestLoadingMaxRetry: 8,
    levelLoadingMaxRetry: 8,
    fragLoadingMaxRetry: 8,
    manifestLoadingRetryDelay: 1000,
    levelLoadingRetryDelay: 1000,
  });
  liveHls.loadSource(src);
  liveHls.attachMedia(video);

  liveHls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    document.getElementById('liveOverlay').classList.add('hidden');
    video.classList.remove('hidden');
    video.play().catch(() => {});
    populateQualityMenu(data.levels || []);
  });

  livePlayerReconnect = createReconnectScheduler(
    () => new Promise((resolve) => {
      if (!liveHls) return resolve(false);
      const retrySrc = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;
      liveHls.loadSource(retrySrc);
      const onParsed = () => { cleanup(); video.play().catch(() => {}); resolve(true); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, 4000);
      function cleanup() { clearTimeout(timer); liveHls?.off(Hls.Events.MANIFEST_PARSED, onParsed); }
      liveHls.on(Hls.Events.MANIFEST_PARSED, onParsed);
    }),
    () => {}
  );

  liveHls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data?.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) livePlayerReconnect?.start();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try { liveHls.recoverMediaError(); } catch (_) {}
    }
  });
}

const VOLUME_STORAGE_KEY = 'pw_volume';

function getSavedVolume() {
  const v = parseInt(localStorage.getItem(VOLUME_STORAGE_KEY), 10);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 50;
}

function saveVolume(v) {
  localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
}

function applyVolumeToLive(v) {
  const video = document.getElementById('liveVideo');
  if (video) video.volume = v / 100;
  const slider = document.getElementById('liveVolumeSlider');
  if (slider) slider.value = v;
}

document.getElementById('liveVolumeBtn')?.addEventListener('click', () => {
  document.getElementById('liveQualityPopup').classList.add('hidden');
  document.getElementById('liveVolumePopup').classList.toggle('hidden');
});

document.getElementById('liveVolumeSlider')?.addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  saveVolume(v);
  applyVolumeToLive(v);
});
document.getElementById('liveQualityBtn')?.addEventListener('click', () => {
  document.getElementById('liveVolumePopup').classList.add('hidden');
  document.getElementById('liveQualityPopup').classList.toggle('hidden');
});

// ---------- фуллскрин: убираем докнутый чат, показываем кнопку + плавающую панель ----------

function liveIsFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

document.getElementById('liveFullscreenBtn')?.addEventListener('click', () => {
  const wrap = document.querySelector('.live-strip-inner');
  if (liveIsFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
  }
});

document.addEventListener('fullscreenchange', onLiveFullscreenChange);
document.addEventListener('webkitfullscreenchange', onLiveFullscreenChange);

function onLiveFullscreenChange() {
  const wrap = document.querySelector('.live-strip-inner');
  const chatToggle = document.getElementById('liveChatToggleBtn');
  const chatSide = document.getElementById('liveChatSide');
  const isFs = liveIsFullscreen();

  wrap?.classList.toggle('fs-active', isFs);
  chatToggle?.classList.toggle('hidden', !isFs);

  if (!isFs) {
    chatSide?.classList.remove('fs-open');
    // сбрасываем inline-стили, чтобы докнутый чат снова жил по CSS
    if (chatSide) {
      chatSide.style.left = '';
      chatSide.style.top = '';
      chatSide.style.right = '';
      chatSide.style.bottom = '';
      chatSide.style.width = '';
      chatSide.style.height = '';
    }
  }
}

document.getElementById('liveChatToggleBtn')?.addEventListener('click', () => {
  document.getElementById('liveChatSide')?.classList.toggle('fs-open');
});

// перетаскивание плавающей панели чата в fullscreen (только за шапку)
(function initLiveChatDrag() {
  const panel = document.getElementById('liveChatSide');
  const handle = document.querySelector('#liveChatSide .live-chat-header');
  const resizeHandle = document.getElementById('liveChatResizeHandle');
  if (!panel || !handle) return;

  const POS_KEY = 'pw-pos:live:chatPanel:fullscreen';
  const SIZE_KEY = 'pw-size:live:chatPanel:fullscreen';
  const MIN_W = 220;
  const MIN_H = 200;

  let dragging = false;
  let resizing = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  let startXR = 0, startYR = 0, startW = 0, startH = 0;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
  }

  function applySavedSize() {
    if (!liveIsFullscreen() || !panel.classList.contains('fs-open')) return;

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    } catch (_) {}

    const parent = panel.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
      return; // оставим CSS-дефолт
    }

    const maxW = Math.max(MIN_W, parentRect.width - 16);
    const maxH = Math.max(MIN_H, parentRect.height - 16);
    const width = clamp(saved.width, MIN_W, maxW);
    const height = clamp(saved.height, MIN_H, maxH);

    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
  }

  function applySavedPosition() {
    if (!liveIsFullscreen() || !panel.classList.contains('fs-open')) return;

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch (_) {}

    const parent = panel.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const panelW = panel.offsetWidth || 320;
    const panelH = panel.offsetHeight || 400;

    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      panel.style.left = '16px';
      panel.style.top = '60px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      return;
    }

    const left = clamp(saved.left, 0, Math.max(0, parentRect.width - panelW));
    const top = clamp(saved.top, 0, Math.max(0, parentRect.height - panelH));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function applySaved() {
    applySavedSize();
    applySavedPosition();
  }

  // --- drag по шапке ---
  handle.addEventListener('pointerdown', (e) => {
    if (!liveIsFullscreen() || e.target.closest('button')) return;

    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();

    const parentRect = panel.parentElement.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    let newLeft = origLeft + (e.clientX - startX);
    let newTop = origTop + (e.clientY - startY);

    newLeft = clamp(newLeft, 0, parentRect.width - panelRect.width);
    newTop = clamp(newTop, 0, parentRect.height - panelRect.height);

    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  handle.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

    localStorage.setItem(POS_KEY, JSON.stringify({
      left: parseFloat(panel.style.left) || 0,
      top: parseFloat(panel.style.top) || 0,
    }));
  });

  // --- resize за угол ---
  resizeHandle?.addEventListener('pointerdown', (e) => {
    if (!liveIsFullscreen()) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    startXR = e.clientX;
    startYR = e.clientY;
    resizing = true;
    panel.classList.add('resizing');
    try { resizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  resizeHandle?.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    e.preventDefault();

    const parentRect = panel.parentElement.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const leftOffset = panelRect.left - parentRect.left;
    const topOffset = panelRect.top - parentRect.top;

    const maxW = Math.max(MIN_W, parentRect.width - leftOffset - 8);
    const maxH = Math.max(MIN_H, parentRect.height - topOffset - 8);

    let newW = startW + (e.clientX - startXR);
    let newH = startH + (e.clientY - startYR);

    newW = clamp(newW, MIN_W, maxW);
    newH = clamp(newH, MIN_H, maxH);

    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
  });

  function endResize(e) {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
    try { resizeHandle.releasePointerCapture(e.pointerId); } catch (_) {}

    const rect = panel.getBoundingClientRect();
    localStorage.setItem(SIZE_KEY, JSON.stringify({
      width: rect.width,
      height: rect.height,
    }));
  }

  resizeHandle?.addEventListener('pointerup', endResize);
  resizeHandle?.addEventListener('pointercancel', endResize);

  // восстановить при открытии чата / входе в FS
  document.getElementById('liveChatToggleBtn')?.addEventListener('click', () => {
    requestAnimationFrame(applySaved);
  });

  document.addEventListener('fullscreenchange', () => {
    if (liveIsFullscreen()) requestAnimationFrame(applySaved);
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (liveIsFullscreen()) requestAnimationFrame(applySaved);
  });
})();

document.getElementById('liveOwnerSettingsBtn')?.addEventListener('click', () => {
  location.href = '/workbench.html';
});

// ---------- чат ----------

function liveEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildLiveMessageHtml(msg) {
  if (msg.deleted) return `<span style="color:var(--text-muted);font-style:italic;">Сообщение удалено</span>`;

  const modBtns = isOwnerFlag ? `
    <button type="button" class="live-mod-btn" title="Удалить" onclick="liveDeleteMessage('${msg._id}')">🗑️</button>
    <button type="button" class="live-mod-btn" title="Заблокировать" onclick="liveBanUser('${msg.senderId}', '${liveEscapeHtml(msg.senderUsername)}')">🚫</button>
    <button type="button" class="live-mod-btn" title="Ограничить чат" onclick="liveTimeoutUser('${msg.senderId}', '${liveEscapeHtml(msg.senderUsername)}')">⏱️</button>
  ` : '';

  return `${modBtns}<b>${liveEscapeHtml(msg.senderUsername)}:</b> ${liveEscapeHtml(msg.text)}`;
}

function renderLiveMessage(msg) {
  const box = document.getElementById('liveMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.dataset.id = msg._id;
  row.innerHTML = buildLiveMessageHtml(msg);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function liveDeleteMessage(messageId) {
  liveSocket?.emit('chat:delete', { messageId });
}
function liveBanUser(userId, username) {
  if (!confirm(`Заблокировать ${username} в этом канале навсегда?`)) return;
  liveSocket?.emit('chat:ban', { userId, username });
}
function liveTimeoutUser(userId, username) {
  const secStr = prompt(`На сколько секунд ограничить чат для ${username}?`, '300');
  const seconds = parseInt(secStr, 10);
  if (!seconds || seconds <= 0) return;
  liveSocket?.emit('chat:timeout', { userId, username, seconds });
}
window.liveDeleteMessage = liveDeleteMessage;
window.liveBanUser = liveBanUser;
window.liveTimeoutUser = liveTimeoutUser;

document.getElementById('liveClearChatBtn')?.addEventListener('click', () => {
  if (confirm('Очистить весь чат для всех зрителей?')) liveSocket?.emit('chat:clear');
});

function toggleViewersPanel() {
  const panel = document.getElementById('liveViewersPanel');
  const btn = document.getElementById('liveViewersBtn');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  btn?.classList.toggle('active', open);
}

document.getElementById('liveViewersBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleViewersPanel();
});
document.getElementById('liveViewersClose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('liveViewersPanel')?.classList.remove('open');
  document.getElementById('liveViewersBtn')?.classList.remove('active');
});

let liveViewersCache = [];

function renderViewersList(viewers) {
  liveViewersCache = viewers || [];
  const list = document.getElementById('liveViewersList');
  if (!list) return;
  list.innerHTML = '';
  if (!liveViewersCache.length) {
    list.innerHTML = '<div class="live-viewer-row guest">Никого нет</div>';
    return;
  }
  liveViewersCache.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'live-viewer-row' + (v.isGuest ? ' guest' : '');
    row.textContent = v.username;
    list.appendChild(row);
  });
}

function setViewersCount(count) {
  const el = document.getElementById('liveViewersCount');
  if (el) el.textContent = String(count ?? 0);
}

function connectLiveChat(nameLower) {
  liveSocket = io('/chat', { reconnection: false });

  liveSocket.on('chat:history', (messages) => {
    document.getElementById('liveMessages').innerHTML = '';
    messages.forEach(renderLiveMessage);
  });
  liveSocket.on('chat:message', renderLiveMessage);
  liveSocket.on('chat:message-deleted', ({ messageId }) => {
    document.querySelectorAll(`[data-id="${messageId}"]`).forEach((row) => {
      row.innerHTML = `<span style="color:var(--text-muted);font-style:italic;">Сообщение удалено</span>`;
    });
  });
  liveSocket.on('chat:cleared', () => { document.getElementById('liveMessages').innerHTML = ''; });

  liveSocket.on('chat:viewers', (payload) => {
    if (typeof payload === 'number') {
      setViewersCount(payload);
      return;
    }
    setViewersCount(payload?.count ?? 0);
    renderViewersList(payload?.viewers || []);
  });

  liveSocket.on('connect', () => {
    liveChatReconnect?.reset();
    liveSocket.emit('chat:join', { streamerName: nameLower });
  });
  liveSocket.on('disconnect', () => liveChatReconnect?.start());

  liveChatReconnect = createReconnectScheduler(
    () => new Promise((resolve) => {
      liveSocket.connect();
      liveSocket.once('connect', () => resolve(true));
      setTimeout(() => resolve(liveSocket.connected), 1500);
    }),
    () => {}
  );
}

function openLiveAuthModal() { document.getElementById('liveAuthModal')?.classList.remove('hidden'); }
function closeLiveAuthModal() { document.getElementById('liveAuthModal')?.classList.add('hidden'); }
document.getElementById('liveAuthModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'liveAuthModal') closeLiveAuthModal();
});
document.getElementById('liveAuthModalClose')?.addEventListener('click', closeLiveAuthModal);
document.getElementById('liveAuthLoginBtn')?.addEventListener('click', () => {
  location.href = '/?returnTo=' + encodeURIComponent(location.pathname);
});
document.getElementById('liveAuthRegisterBtn')?.addEventListener('click', () => {
  location.href = '/?mode=register&returnTo=' + encodeURIComponent(location.pathname);
});

document.getElementById('liveChatInput')?.addEventListener('focus', (e) => {
  if (!liveIsAuthed) { e.target.blur(); openLiveAuthModal(); }
});

document.getElementById('liveChatForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!liveIsAuthed) { openLiveAuthModal(); return; }
  const input = document.getElementById('liveChatInput');
  const text = input.value.trim();
  if (!text || !liveSocket) return;
  liveSocket.emit('chat:send', { text });
  input.value = '';
});

// ---------- инициализация страницы ----------

async function loadProfile() {
  const nameLower = getNameFromUrl();
  if (!nameLower) {
    document.getElementById('notFound').classList.remove('hidden');
    return;
  }

  try {
    const streamer = await api('/streamers/' + encodeURIComponent(nameLower));
    currentStreamer = streamer;
    renderProfile(streamer);
    await checkOwnership(nameLower);
    await loadVods(nameLower);

    document.getElementById('pageContent').classList.remove('hidden');

    if (streamer.isLive && streamer.streamPlaybackId) {
      setTimeout(openLiveStrip, 120);
    }
  } catch (err) {
    console.warn('[loadProfile]', err.message);
    document.getElementById('notFound').classList.remove('hidden');
  }
}

let liveStatusPollTimer = null;

async function pollStreamerLiveStatus() {
  const nameLower = getNameFromUrl();
  if (!nameLower) return;

  try {
    // лёгкий запрос — тот же профиль, но без лишнего UI
    const data = await api('/streamers/' + encodeURIComponent(nameLower) + '/live-status');
    // profileViews++ при каждом poll плохо — лучше отдельный endpoint (см. ниже)
    const wasLive = !!(currentStreamer?.isLive && currentStreamer?.streamPlaybackId);
    const nowLive = !!(data.isLive && data.streamPlaybackId);

    currentStreamer = { ...currentStreamer, ...data };
    document.getElementById('liveBadge')?.classList.toggle('hidden', !data.isLive);

    if (nowLive && !wasLive) {
      // стрим только что начался — открыть плеер без F5
      if (!liveOpen) openLiveStrip();
      else {
        // уже открыт офлайн-экран — перезапустить сессию
        stopLiveSession();
        startLiveSession();
      }
    } else if (!nowLive && wasLive) {
      // эфир кончился — показать «Эфира нет», чат можно оставить
      const video = document.getElementById('liveVideo');
      const offline = document.getElementById('liveOffline');
      if (liveHls) {
        try { liveHls.destroy(); } catch (_) {}
        liveHls = null;
      }
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
        video.classList.add('hidden');
      }
      offline?.classList.remove('hidden');
      document.getElementById('liveOverlay')?.classList.add('hidden');
    }
  } catch (e) {
    console.warn('[pollStreamerLiveStatus]', e.message);
  }
}

function startStreamerLivePolling() {
  clearInterval(liveStatusPollTimer);
  liveStatusPollTimer = setInterval(pollStreamerLiveStatus, 5000);
}

function makeLiveDraggable(el, storageKey) {
  if (!el) return;

  const container = document.getElementById('livePlayerWrap');
  if (!container) return;

  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_THRESHOLD = 6;

  let longPressTimer = null;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function currentMode() {
    return liveIsFullscreen() ? 'fullscreen' : 'normal';
  }

  function storageFullKey() {
    return `pw-pos:live:${storageKey}:${currentMode()}`;
  }

  function resetPosition() {
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
  }

  function applySavedPosition() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(storageFullKey()) || 'null');
    } catch (_) {}

    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      resetPosition();
      return;
    }

    const p = container.getBoundingClientRect();
    if (!p.width || !p.height) return;

    const w = el.offsetWidth || 40;
    const h = el.offsetHeight || 40;

    if (
      saved.left < 0 ||
      saved.top < 0 ||
      saved.left > p.width - w ||
      saved.top > p.height - h
    ) {
      resetPosition();
      return;
    }

    el.style.left = saved.left + 'px';
    el.style.top = saved.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function savePosition(left, top) {
    localStorage.setItem(storageFullKey(), JSON.stringify({ left, top }));
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    moved = false;
    dragging = false;

    // на тач-устройствах drag отключаем (как в room.js)
    const isTouchUI =
      window.matchMedia('(pointer: coarse)').matches ||
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      window.innerWidth <= 768;
    if (isTouchUI) return;

    const rect = el.getBoundingClientRect();
    const parentRect = container.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;

    longPressTimer = setTimeout(() => {
      dragging = true;
      el.classList.add('dragging');
      el.style.touchAction = 'none';
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) {
      if (
        Math.abs(e.clientX - startX) > MOVE_CANCEL_THRESHOLD ||
        Math.abs(e.clientY - startY) > MOVE_CANCEL_THRESHOLD
      ) {
        clearTimeout(longPressTimer);
      }
      return;
    }

    moved = true;
    e.preventDefault();

    const parentRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let newLeft = origLeft + (e.clientX - startX);
    let newTop = origTop + (e.clientY - startY);

    newLeft = Math.max(0, Math.min(newLeft, parentRect.width - elRect.width));
    newTop = Math.max(0, Math.min(newTop, parentRect.height - elRect.height));

    el.style.left = newLeft + 'px';
    el.style.top = newTop + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });

  function endDrag() {
    clearTimeout(longPressTimer);
    if (!dragging) return;

    dragging = false;
    el.classList.remove('dragging');
    el.style.touchAction = '';

    if (moved) {
      savePosition(parseFloat(el.style.left), parseFloat(el.style.top));
      // гасим следующий click после drag
      const suppressNextClick = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
        el.removeEventListener('click', suppressNextClick, true);
      };
      el.addEventListener('click', suppressNextClick, true);
    }
  }

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  const onFsForPos = () => requestAnimationFrame(applySavedPosition);
  document.addEventListener('fullscreenchange', onFsForPos);
  document.addEventListener('webkitfullscreenchange', onFsForPos);
  window.addEventListener('resize', applySavedPosition);
  applySavedPosition();
}

try {
  makeLiveDraggable(document.getElementById('liveFullscreenBtn'), 'fullscreenBtn');
  makeLiveDraggable(document.getElementById('liveVolumeBtn'), 'volumeBtn');
  makeLiveDraggable(document.getElementById('liveQualityBtn'), 'qualityBtn');
  makeLiveDraggable(document.getElementById('liveChatToggleBtn'), 'chatToggleBtn');
} catch (e) {
  console.error('[makeLiveDraggable]', e);
}

applyVolumeToLive(getSavedVolume());

loadProfile();
startStreamerLivePolling();