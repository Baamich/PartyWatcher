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
            if (suppressEvents) return; // наши же программные seekTo/play/pause не должны запускать обработку заново

            if (!isOwner) return; // у зрителя нет controls, реагировать тут больше не на что

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
  }
  // у зрителя нет native controls (не выставлен атрибут controls), ему физически нечем
  // управлять видео вручную — доп. слушатели тут только создавали цикл, убираем их
  return Promise.resolve();
}

function applyPlaybackState({ isPlaying, positionSeconds }) {
  lastState = { isPlaying, positionSeconds };
  if (!playerReady) return;

  suppressEvents = true;
  if (currentVideoType === 'youtube') {
    ytPlayer.seekTo(positionSeconds, true);
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  } else if (videoEl) {
    videoEl.currentTime = positionSeconds;
    isPlaying ? videoEl.play().catch(() => {}) : videoEl.pause();
  }
  setTimeout(() => (suppressEvents = false), 400);
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
    // хост реально запускает воспроизведение, а не просто скрывает оверлей
    if (currentVideoType === 'youtube') {
      ytPlayer.playVideo();
    } else if (videoEl) {
      videoEl.play().catch(() => {});
    }
  } else {
    applyPlaybackState(lastState);
  }
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
    setOverlay(isOwner ? 'Готово к просмотру' : 'Ожидание хоста', true);
  });

  socket.on('playback:update', (state) => {
    lastState = state;
    if (started) applyPlaybackState(state);
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

function sendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  if (!input.value.trim()) return false;
  socket.emit('chat:message', { code, text: input.value });
  input.value = '';
  return false;
}

function addMessage({ username, text }) {
  const div = document.createElement('div');
  div.textContent = `${username}: ${text}`;
  document.getElementById('messages').appendChild(div);
  document.getElementById('messages').scrollTop = 1e9;
}

init();