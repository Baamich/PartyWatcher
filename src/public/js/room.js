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
let resumeBlocked = false; // ждём явного клика зрителя, если браузер заблокировал авто-возобновление

const DRIFT_THRESHOLD_SECONDS = 1.5;

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

function getCurrentPosition() {
  if (currentVideoType === 'youtube') return ytPlayer?.getCurrentTime() ?? 0;
  if (currentVideoType === 'twitch') return twitchPlayer?.getCurrentTime() ?? 0;
  if (videoEl) return videoEl.currentTime;
  return 0;
}

function getIsPlayingNow() {
  if (currentVideoType === 'youtube') return ytPlayer?.getPlayerState() === YT.PlayerState.PLAYING;
  if (currentVideoType === 'twitch') return !twitchPlayer?.isPaused();
  if (videoEl) return !videoEl.paused;
  return false;
}

// Жёсткая коррекция для случаев, где гарантированно есть недавний жест пользователя
// (свой клик на native controls, кнопка "Синхронизировать" и т.п.) — без проверки автовоспроизведения
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

function doPlayPause(isPlaying) {
  if (currentVideoType === 'youtube') {
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  } else if (currentVideoType === 'twitch') {
    if (isPlaying) {
      // мьютим перед программным play — без звука браузер почти всегда разрешает,
      // затем возвращаем звук через долю секунды, когда плеер уже реально заиграл
      twitchPlayer.setMuted(true);
      twitchPlayer.play();
      setTimeout(() => twitchPlayer.setMuted(false), 500);
    } else {
      twitchPlayer.pause();
    }
  } else if (videoEl) {
    isPlaying ? videoEl.play().catch(() => {}) : videoEl.pause();
  }
}

// Возобновление БЕЗ гарантированного жеста (реакция на сообщение от хоста по сокету) —
// пробуем, и если браузер заблокировал автовоспроизведение — показываем "нажми, чтобы продолжить"
// вместо того чтобы молча повторять попытку на каждый heartbeat
function attemptResume(isPlaying, positionSeconds) {
  lastState = { isPlaying, positionSeconds };
  if (!playerReady) return;

  suppressEvents = true;
  const drift = Math.abs(getCurrentPosition() - positionSeconds);
  const needsSeek = drift > DRIFT_THRESHOLD_SECONDS;

  if (needsSeek) {
    if (currentVideoType === 'youtube') ytPlayer.seekTo(positionSeconds, true);
    else if (currentVideoType === 'twitch') twitchPlayer.seek(positionSeconds);
    else if (videoEl) videoEl.currentTime = positionSeconds;

    setTimeout(() => doPlayPause(isPlaying), 300); // даём время обработать перемотку перед play
    setTimeout(() => (suppressEvents = false), 1000);
  } else {
    doPlayPause(isPlaying); // обычный случай "хост продолжил после паузы" — без лишнего seek
    setTimeout(() => (suppressEvents = false), 400);
  }
}


function showResumeOverlay() {
  if (resumeBlocked) return;
  resumeBlocked = true;
  setOverlay('Хост продолжил просмотр — нажми, чтобы продолжить тоже', true);
}

function enforceHostState() {
  applyPlaybackState(lastState);
}

function emitPlayback(isPlaying) {
  if (suppressEvents || !isOwner) return;
  socket.emit('playback:update', { code, isPlaying, positionSeconds: getCurrentPosition() });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!isOwner || !started || !playerReady) return;
    emitPlayback(getIsPlayingNow());
  }, 3000);
}

// Мягкая проверка на каждое входящее обновление — трогает плеер, только если реально разъехались,
// и не спамит попытки, если уже ждём клика зрителя (resumeBlocked)
function softSync({ isPlaying, positionSeconds }) {
  lastState = { isPlaying, positionSeconds };
  if (!playerReady) return;

  const playingNow = getIsPlayingNow();
  const drift = Math.abs(getCurrentPosition() - positionSeconds);

  if (playingNow !== isPlaying || drift > DRIFT_THRESHOLD_SECONDS) {
    attemptResume(isPlaying, positionSeconds);
  }
}

function resync() {
  if (isOwner) {
    emitPlayback(getIsPlayingNow());
  } else {
    // применяем сразу локально, синхронно внутри клика — это и есть тот самый
    // "пользовательский жест", который требует Twitch для запуска play() программно
    attemptResume(lastState.isPlaying, lastState.positionSeconds);
    socket.emit('room:resync', { code }); // заодно подтягиваем самое свежее состояние с сервера
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
    // это настоящий клик пользователя — гарантированно можно применять жёстко
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
    if (started) softSync(state);
    else {
      lastState = state;
      updateWaitingOverlayText();
    }
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