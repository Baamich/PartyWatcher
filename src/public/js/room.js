const code = new URLSearchParams(location.search).get('code');
let socket;
let isOwner = false;
let currentVideoType = null;
let ytPlayer = null;
let videoEl = null;
let suppressEvents = false;
let playerReady = false;
let lastState = { isPlaying: false, positionSeconds: 0 };
let started = false;

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
            if (!isOwner) return; // у зрителя нет controls, никакие нажатия не должны отправлять апдейты

            if (e.data === YT.PlayerState.PLAYING) emitPlayback(true);
            else if (e.data === YT.PlayerState.PAUSED) emitPlayback(false);
          },
        },
      });
    }));
  }

  container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls' : ''} src="${video.url}"></video>`;
  videoEl = document.getElementById('videoEl');
  videoEl.volume = 0.3;
  playerReady = true;

  if (isOwner) {
    videoEl.addEventListener('play', () => emitPlayback(true));
    videoEl.addEventListener('pause', () => emitPlayback(false));
    videoEl.addEventListener('seeked', () => emitPlayback(!videoEl.paused));
  } else {
    // страховка: если зритель как-то умудрился запустить/перемотать видео сам
    // (правый клик → "Воспроизвести", фокус+пробел и т.п.) — тут же откатываем к хосту
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

function emitPlayback(isPlaying) {
  if (suppressEvents || !isOwner) return;
  const positionSeconds = currentVideoType === 'youtube' ? ytPlayer.getCurrentTime() : videoEl.currentTime;
  socket.emit('playback:update', { code, isPlaying, positionSeconds });
}

function resync() {
  socket.emit('room:resync', { code });
}

function copyRoomLink() {
  navigator.clipboard.writeText(location.href);
  alert('Ссылка на комнату скопирована');
}

function startWatching() {
  started = true;
  hideOverlay();

  if (isOwner) {
    if (currentVideoType === 'youtube') {
      ytPlayer.playVideo();
    } else if (videoEl) {
      videoEl.play().catch(() => {});
    }
  } else {
    applyPlaybackState(lastState); // подхватываем текущее состояние хоста, не запускаем "с нуля"
  }
}

function toggleFullscreen() {
  const wrap = document.getElementById('playerWrap');
  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function onFullscreenChange() {
  const inFullscreen = !!document.fullscreenElement;
  document.getElementById('fsChatToggleBtn').classList.toggle('hidden', !inFullscreen);
  if (!inFullscreen) {
    document.getElementById('fsChatPanel').classList.add('hidden');
  }
}

function toggleFsChat() {
  document.getElementById('fsChatPanel').classList.toggle('hidden');
}

document.addEventListener('fullscreenchange', onFullscreenChange);

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

    if (isOwner) {
      setOverlay('Готово к просмотру', true);
    } else {
      updateWaitingOverlayText();
    }
  });

  socket.on('playback:update', (state) => {
    lastState = state;
    if (started) applyPlaybackState(state);
    else updateWaitingOverlayText();
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
  if (!document.fullscreenElement) return; // баннер нужен только в полноэкранном режиме
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