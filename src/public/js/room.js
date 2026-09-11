const code = new URLSearchParams(location.search).get('code');
let socket;
let currentVideoType = null;
let ytPlayer = null;
let videoEl = null;
let suppressEvents = false;
let playerReady = false;
let pendingState = null;

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

async function renderPlayer(video) {
  currentVideoType = video.type;
  const container = document.getElementById('player');

  if (video.type === 'youtube') {
    const idMatch = video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const videoId = idMatch ? idMatch[1] : '';
    container.innerHTML = '<div id="ytPlayer"></div>';
    await loadYouTubeAPI();

    ytPlayer = new YT.Player('ytPlayer', {
      videoId,
      playerVars: { autoplay: 0, cc_load_policy: 0, iv_load_policy: 3, modestbranding: 1, rel: 0 },
      events: {
        onReady: (e) => {
          playerReady = true;
          e.target.setVolume(30);
          if (pendingState) { applyPlaybackState(pendingState); pendingState = null; }
        },
        onStateChange: (e) => {
          if (suppressEvents) return;
          if (e.data === YT.PlayerState.PLAYING) emitPlayback(true);
          else if (e.data === YT.PlayerState.PAUSED) emitPlayback(false);
        },
      },
    });
    return;
  }

  container.innerHTML = `<video id="videoEl" controls src="${video.url}"></video>`;
  videoEl = document.getElementById('videoEl');
  videoEl.volume = 0.3;
  videoEl.addEventListener('play', () => emitPlayback(true));
  videoEl.addEventListener('pause', () => emitPlayback(false));
  videoEl.addEventListener('seeked', () => emitPlayback(!videoEl.paused));
}

function applyPlaybackState({ isPlaying, positionSeconds }) {
  if (currentVideoType === 'youtube' && !playerReady) {
    pendingState = { isPlaying, positionSeconds };
    return;
  }
  suppressEvents = true;
  if (currentVideoType === 'youtube') {
    ytPlayer.seekTo(positionSeconds, true);
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  } else if (videoEl) {
    videoEl.currentTime = positionSeconds;
    isPlaying ? videoEl.play() : videoEl.pause();
  }
  setTimeout(() => (suppressEvents = false), 400);
}

function emitPlayback(isPlaying) {
  if (suppressEvents) return;
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

async function init() {
  const me = await api('/auth/me').catch(() => null);
  if (!me) return (location.href = '/index.html');

  document.getElementById('roomCodeValue').textContent = code;

  socket = io();
  socket.on('connect', () => socket.emit('room:join', { code }));

  socket.on('room:state', ({ video, playback }) => {
    if (currentVideoType === null) {
      renderPlayer(video).then(() => applyPlaybackState(playback));
    } else {
      applyPlaybackState(playback);
    }
  });

  socket.on('playback:update', applyPlaybackState);
  socket.on('chat:message', addMessage);
  socket.on('room:error', (err) => alert(err.error));
}

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