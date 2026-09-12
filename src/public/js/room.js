const code = new URLSearchParams(location.search).get('code');
let socket;
let isOwner = false;
let currentVideoType = null;
let ytPlayer = null;
let twitchPlayer = null;
let videoEl = null;
let suppressEvents = false;
let playerReady = false;
let lastState = { isPlaying: false, positionSeconds: 0 };
let started = false;
let heartbeatTimer = null;

function setOverlay(text, showStartBtn) {
  document.getElementById('overlayText').textContent = text;
  document.getElementById('startBtn').classList.toggle('hidden', !showStartBtn);
  document.getElementById('overlay').classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

function updateWaitingOverlayText() {
  if (started || isOwner) return;
  const status = lastState.isPlaying ? 'смотрит' : 'на паузе';
  setOverlay(`Хост сейчас ${status} — нажми, чтобы присоединиться`, true);
}

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

function loadTwitchAPI() {
  return new Promise((resolve) => {
    if (window.Twitch && window.Twitch.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://embed.twitch.tv/embed/v1.js';
    tag.onload = () => resolve();
    document.body.appendChild(tag);
  });
}

function renderPlayer(video) {
  currentVideoType = video.type;
  const container = document.getElementById('player');

  if (video.type === 'youtube') {
    const idMatch = video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const videoId = idMatch ? idMatch[1] : '';
    container.innerHTML = '<div id="ytPlayer"></div>';

    return loadYouTubeAPI().then(() => new Promise((resolve) => {
      ytPlayer = new YT.Player('ytPlayer', {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: isOwner ? 1 : 0,
          cc_load_policy: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: (e) => {
            playerReady = true;
            e.target.setVolume(30);
            resolve();
          },
          onStateChange: (e) => {
            if (suppressEvents) return;
            if (!isOwner) return;
            if (e.data === YT.PlayerState.PLAYING) emitPlayback(true);
            else if (e.data === YT.PlayerState.PAUSED) emitPlayback(false);
          },
        },
      });
    }));
  }

  if (video.type === 'twitch') {
    const idMatch = video.url.match(/twitch\.tv\/videos\/(\d+)/);
    const videoId = idMatch ? idMatch[1] : '';
    container.innerHTML = '<div id="twitchPlayer"></div>';

    return loadTwitchAPI().then(() => new Promise((resolve) => {
      twitchPlayer = new Twitch.Player('twitchPlayer', {
        video: videoId,
        width: '100%',
        height: '100%',
        parent: [window.location.hostname],
        autoplay: false,
        muted: false,
      });

      twitchPlayer.addEventListener(Twitch.Player.READY, () => {
        playerReady = true;
        twitchPlayer.setVolume(0.3);
        resolve();
      });

      twitchPlayer.addEventListener(Twitch.Player.PLAY, () => {
        if (suppressEvents || !isOwner) return;
        emitPlayback(true);
      });
      twitchPlayer.addEventListener(Twitch.Player.PAUSE, () => {
        if (suppressEvents || !isOwner) return;
        emitPlayback(false);
      });
    }));
  }

  const videoSrc = video.type === 'drive' ? `/api/drive/stream/${video.url}` : video.url;
  container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls' : ''} src="${videoSrc}"></video>`;
  videoEl = document.getElementById('videoEl');
  videoEl.volume = 0.3;
  playerReady = true;

  if (isOwner) {
    videoEl.addEventListener('play', () => emitPlayback(true));
    videoEl.addEventListener('pause', () => emitPlayback(false));
    videoEl.addEventListener('seeked', () => emitPlayback(!videoEl.paused));
  } else {
    videoEl.addEventListener('play', () => { if (!suppressEvents) enforceHostState(); });
    videoEl.addEventListener('seeking', () => { if (!suppressEvents) enforceHostState(); });
    videoEl.oncontextmenu = () => false;
    videoEl.disablePictureInPicture = true;
  }

  return Promise.resolve();
}

function applyPlaybackState({ isPlaying, positionSeconds }) {
  lastState = { isPlaying, positionSeconds };
  if (!playerReady) return;

  suppressEvents = true;

  if (currentVideoType === 'youtube') {
    ytPlayer.seekTo(positionSeconds, true);
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
    setTimeout(() => (suppressEvents = false), 800);
  } else if (currentVideoType === 'twitch') {
    twitchPlayer.seek(positionSeconds);
    isPlaying ? twitchPlayer.play() : twitchPlayer.pause();
    setTimeout(() => (suppressEvents = false), 800);
  } else if (videoEl) {
    const clearSuppress = () => {
      videoEl.removeEventListener('seeked', clearSuppress);
      suppressEvents = false;
    };
    videoEl.addEventListener('seeked', clearSuppress);
    videoEl.currentTime = positionSeconds;
    isPlaying ? videoEl.play().catch(() => {}) : videoEl.pause();
    setTimeout(clearSuppress, 1500);
  }
}

function enforceHostState() {
  applyPlaybackState(lastState);
}

function getOwnerIsPlayingNow() {
  if (currentVideoType === 'youtube') return ytPlayer?.getPlayerState() === YT.PlayerState.PLAYING;
  if (currentVideoType === 'twitch') return !twitchPlayer?.isPaused();
  if (videoEl) return !videoEl.paused;
  return false;
}

function emitPlayback(isPlaying) {
  if (suppressEvents || !isOwner) return;

  let positionSeconds = 0;
  if (currentVideoType === 'youtube') positionSeconds = ytPlayer.getCurrentTime();
  else if (currentVideoType === 'twitch') positionSeconds = twitchPlayer.getCurrentTime();
  else if (videoEl) positionSeconds = videoEl.currentTime;

  socket.emit('playback:update', { code, isPlaying, positionSeconds });
}

// хост раз в 3 секунды сам себя "перепроверяет" — самоисправление на случай
// потерянного события play/pause (нестабильное соединение через бесплатный туннель)
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!isOwner || !started || !playerReady) return;
    emitPlayback(getOwnerIsPlayingNow());
  }, 3000);
}

function resync() {
  if (isOwner) {
    // хост форсит своё реальное текущее состояние всем зрителям немедленно
    emitPlayback(getOwnerIsPlayingNow());
  } else {
    // зритель просто подтягивает последнее известное состояние хоста себе
    socket.emit('room:resync', { code });
  }
}

function copyRoomLink() {
  navigator.clipboard.writeText(location.href);
  alert('Ссылка на комнату скопирована');
}

function startWatching() {
  started = true;
  hideOverlay();

  if (isOwner) {
    if (currentVideoType === 'youtube') ytPlayer.playVideo();
    else if (currentVideoType === 'twitch') twitchPlayer.play();
    else if (videoEl) videoEl.play().catch(() => {});
    startHeartbeat();
  } else {
    applyPlaybackState(lastState);
  }
}

function toggleFullscreen() {
  const wrap = document.getElementById('playerWrap');
  if (!document.fullscreenElement) wrap.requestFullscreen?.();
  else document.exitFullscreen?.();
}

function onFullscreenChange() {
  const inFullscreen = !!document.fullscreenElement;
  document.getElementById('fsChatToggleBtn').classList.toggle('hidden', !inFullscreen);
  if (!inFullscreen) document.getElementById('fsChatPanel').classList.add('hidden');
}

function toggleFsChat() {
  document.getElementById('fsChatPanel').classList.toggle('hidden');
}

document.addEventListener('fullscreenchange', onFullscreenChange);

function openSettings() {
  socket.emit('room:participants', { code });
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openBannedList() {
  socket.emit('room:banned-list', { code });
  document.getElementById('bannedModal').classList.remove('hidden');
}

function renderParticipants(list) {
  document.getElementById('participantCount').textContent = list.length;
  const container = document.getElementById('participantsList');
  container.innerHTML = '';

  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML = `
      <span>${p.username}${p.isOwner ? ' (Хост)' : ''}</span>
      ${isOwner && !p.isOwner ? '<button class="kick-btn">Кикнуть</button>' : ''}`;

    if (isOwner && !p.isOwner) {
      row.querySelector('.kick-btn').onclick = () => {
        if (confirm(`Кикнуть и заблокировать ${p.username} в этой комнате?`)) {
          socket.emit('room:kick', { code, targetUsername: p.username });
        }
      };
    }
    container.appendChild(row);
  });

  document.getElementById('bannedListBtn').classList.toggle('hidden', !isOwner);
}

function renderBannedList(list) {
  const container = document.getElementById('bannedList');
  container.innerHTML = '';

  if (!list.length) {
    container.textContent = 'Список пуст';
    return;
  }

  list.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML = `<span>${u.username}</span><button class="unban-btn">Разблокировать</button>`;
    row.querySelector('.unban-btn').onclick = () => socket.emit('room:unban', { code, userId: u.id });
    container.appendChild(row);
  });
}

async function init() {
  const me = await api('/auth/me').catch(() => null);
  if (!me) return (location.href = '/index.html');

  document.getElementById('roomCodeValue').textContent = code;
  setOverlay('Загрузка комнаты...', false);

  socket = io();
  socket.on('connect', () => socket.emit('room:join', { code }));

  socket.on('room:state', async ({ video, playback, isOwner: ownerFlag }) => {
    isOwner = ownerFlag;
    lastState = playback;
    await renderPlayer(video);
    isOwner ? setOverlay('Готово к просмотру', true) : updateWaitingOverlayText();
  });

  socket.on('playback:update', (state) => {
    lastState = state;
    if (started) applyPlaybackState(state);
    else updateWaitingOverlayText();
  });

  socket.on('room:user-joined', ({ username }) => {
    addMessage({ username: 'Система', text: `${username} присоединился к просмотру` });
  });

  socket.on('room:participants', renderParticipants);
  socket.on('room:banned-list', renderBannedList);

  socket.on('room:kicked', () => {
    alert('Вас кикнули из этой комнаты — доступ заблокирован');
    location.href = '/index.html';
  });

  socket.on('room:banned', () => {
    alert('Вы заблокированы в этой комнате');
    location.href = '/index.html';
  });

  socket.on('room:deleted', () => {
    alert('Комната удалена владельцем');
    location.href = '/index.html';
  });

  socket.on('chat:message', addMessage);
  socket.on('room:error', (err) => alert(err.error));
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !isOwner || !started) return;
  e.preventDefault();

  if (currentVideoType === 'youtube') {
    const state = ytPlayer.getPlayerState();
    state === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
  } else if (currentVideoType === 'twitch') {
    twitchPlayer.isPaused() ? twitchPlayer.play() : twitchPlayer.pause();
  } else if (videoEl) {
    videoEl.paused ? videoEl.play() : videoEl.pause();
  }
});

function sendMessage(e, fromFullscreen) {
  e.preventDefault();
  const input = document.getElementById(fromFullscreen ? 'fsChatInput' : 'chatInput');
  if (!input.value.trim()) return false;
  socket.emit('chat:message', { code, text: input.value });
  input.value = '';
  return false;
}

function appendMessageTo(containerId, username, text) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const div = document.createElement('div');
  div.textContent = `${username}: ${text}`;
  container.appendChild(div);
  container.scrollTop = 1e9;
}

let fsNoticeTimer = null;

function showFsNotice(username, text) {
  if (!document.fullscreenElement) return;
  const notice = document.getElementById('fsNotice');
  notice.textContent = `${username}: ${text}`;
  notice.classList.remove('hidden', 'fade-out');

  clearTimeout(fsNoticeTimer);
  fsNoticeTimer = setTimeout(() => {
    notice.classList.add('fade-out');
    setTimeout(() => notice.classList.add('hidden'), 500);
  }, 5000);
}

function addMessage({ username, text }) {
  appendMessageTo('messages', username, text);
  appendMessageTo('fsMessages', username, text);
  showFsNotice(username, text);
}

init();