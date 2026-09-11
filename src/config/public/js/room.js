const code = new URLSearchParams(location.search).get('code');
let socket;
let videoEl;
let suppressEvents = false;

function getCookie(name) {
  return document.cookie.match(new RegExp(`${name}=([^;]+)`))?.[1];
}

async function init() {
  const me = await api('/auth/me').catch(() => null);
  if (!me) return (location.href = '/index.html');

  socket = io();
  socket.on('connect', () => socket.emit('room:join', { code }));

  socket.on('room:state', ({ video, playback }) => {
    renderPlayer(video);
    if (video.type !== 'youtube' && videoEl) {
      videoEl.currentTime = playback.positionSeconds;
      if (playback.isPlaying) videoEl.play();
    }
  });

  socket.on('playback:update', ({ isPlaying, positionSeconds }) => {
    if (!videoEl) return;
    suppressEvents = true;
    videoEl.currentTime = positionSeconds;
    isPlaying ? videoEl.play() : videoEl.pause();
    setTimeout(() => (suppressEvents = false), 300);
  });

  socket.on('chat:message', addMessage);
  socket.on('room:error', (err) => alert(err.error));
}

function renderPlayer(video) {
  const container = document.getElementById('player');

  if (video.type === 'youtube') {
    const idMatch = video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    container.innerHTML = `<iframe src="https://www.youtube.com/embed/${idMatch ? idMatch[1] : ''}" allow="autoplay" allowfullscreen></iframe>`;
    // примечание: это простой embed без двусторонней синхронизации через YouTube IFrame API — добавим отдельно, если понадобится
    return;
  }

  container.innerHTML = `<video id="videoEl" controls src="${video.url}"></video>`;
  videoEl = document.getElementById('videoEl');
  videoEl.addEventListener('play', () => emitPlayback(true));
  videoEl.addEventListener('pause', () => emitPlayback(false));
  videoEl.addEventListener('seeked', () => emitPlayback(!videoEl.paused));
}

function emitPlayback(isPlaying) {
  if (suppressEvents || !videoEl) return;
  socket.emit('playback:update', { code, isPlaying, positionSeconds: videoEl.currentTime });
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