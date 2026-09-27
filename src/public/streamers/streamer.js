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

// ---------- записи (сетка снизу / колонка сбоку — одни и те же данные) ----------

function vodEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderVodGrid(vods) {
  const grid = document.getElementById('vodGrid');
  grid.innerHTML = '';
  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
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
    const row = document.createElement('div');
    row.className = 'vod-column-item';
    row.innerHTML = `
      <span class="vod-column-title">${vodEscapeHtml(v.title || 'Запись')}</span>
      <span class="vod-column-meta">${new Date(v.createdAt).toLocaleString('ru-RU')}</span>`;
    row.onclick = () => window.open(v.url, '_blank');
    list.appendChild(row);
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
  switchVodLayout(true);
  startLiveSession();
}

function closeLiveStrip() {
  if (!liveOpen) return;
  liveOpen = false;
  document.getElementById('liveStrip').classList.remove('open');
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
      video.volume = parseInt(document.getElementById('liveVolumeSlider').value, 10) / 100;
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

  if (isOwnerFlag) document.getElementById('liveOwnerBar').classList.remove('hidden');
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
}

document.getElementById('profileAvatarBtn')?.addEventListener('click', toggleLiveStrip);
document.getElementById('profileNameBtn')?.addEventListener('click', toggleLiveStrip);

// ---------- HLS-плеер ----------

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

function attachLiveHls(playbackId) {
  const video = document.getElementById('liveVideo');
  lockToLiveEdge(video);

  const src = `/media/live/${playbackId}/index.m3u8?t=${Date.now()}`;

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

  liveHls.on(Hls.Events.MANIFEST_PARSED, () => {
    document.getElementById('liveOverlay').classList.add('hidden');
    video.classList.remove('hidden');
    video.play().catch(() => {});
  });

  livePlayerReconnect = createReconnectScheduler(
    () => new Promise((resolve) => {
      if (!liveHls) return resolve(false);
      const retrySrc = `/media/live/${playbackId}/index.m3u8?t=${Date.now()}`;
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

document.getElementById('liveVolumeBtn')?.addEventListener('click', () => {
  document.getElementById('liveVolumePopup').classList.toggle('hidden');
});
document.getElementById('liveVolumeSlider')?.addEventListener('input', (e) => {
  document.getElementById('liveVideo').volume = parseInt(e.target.value, 10) / 100;
});
document.getElementById('liveFullscreenBtn')?.addEventListener('click', () => {
  const wrap = document.querySelector('.live-strip-inner');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
  }
});
document.getElementById('liveOwnerSettingsBtn')?.addEventListener('click', () => {
  location.href = '/workbench.html';
});

// ---------- чат ----------

function liveEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLiveMessage(msg) {
  const box = document.getElementById('liveMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.dataset.id = msg._id;
  row.innerHTML = msg.deleted
    ? `<span style="color:var(--text-muted);font-style:italic;">Сообщение удалено</span>`
    : `<b>${liveEscapeHtml(msg.senderUsername)}:</b> ${liveEscapeHtml(msg.text)}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
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
  liveSocket.on('chat:viewers', (count) => {
    document.getElementById('liveViewers').textContent = '👁 ' + count;
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
  location.href = '/index.html?returnTo=' + encodeURIComponent(location.pathname);
});
document.getElementById('liveAuthRegisterBtn')?.addEventListener('click', () => {
  location.href = '/index.html?mode=register&returnTo=' + encodeURIComponent(location.pathname);
});

document.getElementById('liveChatInput')?.addEventList
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

loadProfile();