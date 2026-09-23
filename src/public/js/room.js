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
let capturePlayer = null;
let playerFocused = false;

let voiceParticipants = [];
let inVoiceCall = false;
let localStream = null;
let peerConnections = {};
let remoteAudioEls = {};
let voiceAudioCtx = null;
let rawLocalStream = null;

const MAX_VOICE_PARTICIPANTS = 15; // mesh: каждый держит N-1 P2P-соединений, больше — начинает тормозить
const VOICE_WARN_THRESHOLD = 8;

function voiceVolKey(username) {
  return `pw_voice_vol:${username}`;
}

function getUserVoiceVolume(username) {
  const v = parseInt(localStorage.getItem(voiceVolKey(username)), 10);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100;
}

function setUserVoiceVolume(username, vol) {
  const clamped = Math.max(0, Math.min(100, Number(vol) || 0));
  localStorage.setItem(voiceVolKey(username), String(clamped));
  voiceParticipants.forEach((p) => {
    if (p.username === username && remoteAudioEls[p.socketId]) {
      remoteAudioEls[p.socketId].volume = clamped / 100;
    }
  });
}

async function createProcessedLocalStream() {
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      // Chrome: доп. изоляция голоса, если поддерживается
      voiceIsolation: true,
    },
    video: false,
  });

  rawLocalStream = raw;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  voiceAudioCtx = ctx;

  const source = ctx.createMediaStreamSource(raw);

  // срезаем гул/дыхание/низкий шум
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;
  highpass.Q.value = 0.7;

  // чуть приглушаем очень тихие шумы, усиливает речь
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -45;
  compressor.knee.value = 30;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;

  // мягкий noise gate: тише порога — почти mute
  const gate = ctx.createGain();
  gate.gain.value = 1;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const data = new Uint8Array(analyser.fftSize);

  const dest = ctx.createMediaStreamDestination();

  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(gate);
  gate.connect(dest);

  const GATE_THRESHOLD = 15; // 18–25 (глушит сильнее, но может глотать тихую речь).
  const GATE_FLOOR = 0.02;

  function tickGate() {
    if (!voiceAudioCtx) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const target = rms < GATE_THRESHOLD ? GATE_FLOOR : 1;
    const current = gate.gain.value;
    gate.gain.value = current + (target - current) * 0.15;
    requestAnimationFrame(tickGate);
  }
  tickGate();

  return dest.stream;
}

const DRIFT_THRESHOLD_SECONDS = 3; // совпадает с текстом системной подсказки для зрителей

const PLAYBACK_CACHE_TTL_MS = 30 * 60 * 1000;

function playbackCacheKey() {
  return `pw_playback:${code}`;
}

function savePlaybackCache({ isPlaying, positionSeconds }) {
  if (!code) return;
  try {
    localStorage.setItem(playbackCacheKey(), JSON.stringify({
      isPlaying: !!isPlaying,
      positionSeconds: Number(positionSeconds) || 0,
      videoType: currentVideoType,
      videoUrl: window.__lastVideoUrl || null,
      savedAt: Date.now(),
    }));
  } catch (_) {}
}

function loadPlaybackCache() {
  try {
    const raw = localStorage.getItem(playbackCacheKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || Date.now() - (data.savedAt || 0) > PLAYBACK_CACHE_TTL_MS) {
      localStorage.removeItem(playbackCacheKey());
      return null;
    }
    return data;
  } catch (_) {
    return null;
  }
}

function clearPlaybackCache() {
  try {
    localStorage.removeItem(playbackCacheKey());
  } catch (_) {}
}


let thumbnailTimer = null;

function getThumbnailSourceEl() {
  // снять кадр можно только с реального <video> (не с iframe youtube/twitch)
  if (currentVideoType === 'player_capture' && capturePlayer?.videoEl) return capturePlayer.videoEl;
  if (videoEl) return videoEl;
  return null;
}

function captureAndSendThumbnail() {
  if (!isOwner) return;
  const v = getThumbnailSourceEl();
  if (!v || v.readyState < 2 || !v.videoWidth) return;

  try {
    const targetW = 320;
    const targetH = Math.round((v.videoHeight / v.videoWidth) * targetW) || 180;
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.getContext('2d').drawImage(v, 0, 0, targetW, targetH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    socket.emit('room:thumbnail', { code, dataUrl });
  } catch (e) {
    // источник с чужого домена без CORS — кадр снять нельзя, просто пропускаем
    console.warn('[thumbnail] не удалось снять кадр:', e.message);
  }
}

function startThumbnailCapture() {
  if (thumbnailTimer) return;
  setTimeout(captureAndSendThumbnail, 5000);       // первый кадр пораньше
  thumbnailTimer = setInterval(captureAndSendThumbnail, 60000); // потом раз в минуту
}

function stopThumbnailCapture() {
  if (thumbnailTimer) {
    clearInterval(thumbnailTimer);
    thumbnailTimer = null;
  }
}


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


function isAgeConfirmedLocally() {
    return localStorage.getItem('pw_age18') === '1';
  }

  function askAgeGate() {
    if (isAgeConfirmedLocally()) return Promise.resolve(true);

    return new Promise((resolve) => {
      const modal = document.getElementById('ageGateModal');
      const confirmBtn = document.getElementById('ageGateConfirmBtn');
      const cancelBtn = document.getElementById('ageGateCancelBtn');

      modal.classList.remove('hidden');

      const cleanup = () => {
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
      };
      const onConfirm = () => {
        localStorage.setItem('pw_age18', '1');
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  function renderDirectVideoUrl(url) {
    if (ytPlayer && typeof ytPlayer.destroy === 'function') {
      try { ytPlayer.destroy(); } catch (_) {}
    ytPlayer = null;
    }
    const container = document.getElementById('player');
    container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls controlsList="nofullscreen noremoteplayback"' : ''} src="${url}"></video>`;
    videoEl = document.getElementById('videoEl');
    videoEl.volume = getSavedVolume() / 100;
    currentVideoType = 'direct';
    playerReady = true;

    if (isOwner) {
      videoEl.addEventListener('play', () => emitPlayback(true));
      videoEl.addEventListener('pause', () => emitPlayback(false));
      videoEl.addEventListener('seeked', () => emitPlayback(!videoEl.paused));
    } else {
      videoEl.addEventListener('play', () => { if (!suppressEvents) enforceHostState(); });
      videoEl.addEventListener('seeking', () => { if (!suppressEvents) enforceHostState(); });
    }
  }

  let ageGateHandling = false;
  let ageGateResolvedForVideo = false;

  async function handleYoutubeError(errorCode) {
    if (![100, 101, 150].includes(errorCode)) return;
    if (ageGateHandling || ageGateResolvedForVideo) return; // <-- защита от повторных срабатываний

    ageGateHandling = true;

    if (!isOwner) {
      setOverlay('Видео заблокировано YouTube — жду, пока хост подтвердит возраст 18+', false);
      ageGateHandling = false;
      return;
    }

    const confirmed = await askAgeGate();
    if (!confirmed) {
      setOverlay('Без подтверждения возраста это видео недоступно', false);
      ageGateHandling = false;
      return;
    }

    setOverlay('Получаю поток через yt-dlp...', false);
    try {
      const data = await api('/youtube-capture/age-restricted-extract', {
        method: 'POST',
        body: { code },
      });
      ageGateResolvedForVideo = true; // видео решено — дальнейшие onError по этому видео игнорим
      renderDirectVideoUrl(data.url);
      socket.emit('youtube:age-restricted-stream', { code, url: data.url });
      setOverlay('Готово к просмотру', true);
    } catch (err) {
      setOverlay('Не удалось получить видео: ' + (err.message || ''), false);
    } finally {
      ageGateHandling = false;
    }
  }

  function renderPlayer(video) {
  currentVideoType = video.type;
  const container = document.getElementById('player');

  if (video.type === 'player_capture') {
    window.__captureVideoUrl = video.url;
    return import('/js/playerCapture/index.js').then(mod => {
      return mod.renderPlayerCapture(video, {
        isOwner,
        container: document.getElementById('player'),
      }).then(player => {
        capturePlayer = player;
        playerReady = true;
        return player;
      });
    });
  }

  if (video.type === 'direct') {
    const isRawVideoFile = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(video.url);

    if (isRawVideoFile) {
      container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls controlsList="nofullscreen noremoteplayback"' : ''} src="${video.url}"></video>`;
      videoEl = document.getElementById('videoEl');
      videoEl.volume = getSavedVolume() / 100;
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

    videoEl = null;
    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = video.url;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.referrerPolicy = 'no-referrer';
    container.appendChild(iframe);
    playerReady = true;
    return Promise.resolve();
  }

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
            e.target.setVolume(getSavedVolume());
            if (!subtitlesOn) {
              try {
                e.target.unloadModule('captions');
                e.target.unloadModule('cc');
              } catch (_) {}
            } else {
              applySubtitlesState();
            }
            if (lastState.positionSeconds > 1) {
              try {
                e.target.seekTo(lastState.positionSeconds, true);
              } catch (_) {}
            }
            resolve();
          },
          onStateChange: (e) => {
            if (!subtitlesOn && (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED)) {
              forceYoutubeCaptionsOff();
            }
            if (suppressEvents) return;
            if (!isOwner) return;
            if (e.data === YT.PlayerState.PLAYING) emitPlayback(true);
            else if (e.data === YT.PlayerState.PAUSED) emitPlayback(false);
          },
          onApiChange: () => {
            if (!subtitlesOn) forceYoutubeCaptionsOff();
          },
          onError: (e) => handleYoutubeError(e.data),
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
        twitchPlayer.setVolume(getSavedVolume() / 100);
        if (lastState.positionSeconds > 1) {
          try {
            twitchPlayer.seek(lastState.positionSeconds);
          } catch (_) {}
        }
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
  container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls controlsList="nofullscreen noremoteplayback"' : ''} src="${videoSrc}"></video>`;
  videoEl = document.getElementById('videoEl');
  videoEl.volume = getSavedVolume() / 100;
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
  if (currentVideoType === 'player_capture' && capturePlayer?.getCurrentPosition) {
    return capturePlayer.getCurrentPosition();
  }
  if (videoEl) return videoEl.currentTime;
  return 0;
}

function getIsPlayingNow() {
  if (currentVideoType === 'youtube') return ytPlayer?.getPlayerState() === YT.PlayerState.PLAYING;
  if (currentVideoType === 'twitch') return !twitchPlayer?.isPaused();
  if (currentVideoType === 'player_capture' && capturePlayer?.getIsPlayingNow) {
    return capturePlayer.getIsPlayingNow();
  }
  if (videoEl) return !videoEl.paused;
  return false;
}

function doPlayPause(isPlaying) {
  if (currentVideoType === 'youtube') {
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  } else if (currentVideoType === 'twitch') {
    isPlaying ? twitchPlayer.play() : twitchPlayer.pause();
  } else if (currentVideoType === 'player_capture' && capturePlayer?.doPlayPause) {
    capturePlayer.doPlayPause(isPlaying);
  } else if (videoEl) {
    isPlaying ? videoEl.play().catch(() => {}) : videoEl.pause();
  }
}


function applyPlaybackState({ isPlaying, positionSeconds }) {
  lastState = { isPlaying, positionSeconds };
  savePlaybackCache(lastState);
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
  } else if (currentVideoType === 'player_capture' && capturePlayer) {
    const v = capturePlayer.videoEl;
    const run = () => {
      if (!v) {
        suppressEvents = false;
        return;
      }

      if (isPlaying) {
        v.play().catch((e) => console.warn('[capture] play failed', e));
        if (positionSeconds > 2) {
          const doSeek = () => {
            try { v.currentTime = positionSeconds; } catch (_) {}
          };
          if (v.readyState >= 2) setTimeout(doSeek, 800);
          else v.addEventListener('loadeddata', () => setTimeout(doSeek, 800), { once: true });
        }
      } else {
        try { v.currentTime = positionSeconds || 0; } catch (_) {}
        v.pause();
      }

      setTimeout(() => (suppressEvents = false), 1500);
    };

    if (v && v.readyState < 2) {
      const onReady = () => {
        v.removeEventListener('loadeddata', onReady);
        run();
      };
      v.addEventListener('loadeddata', onReady);
      setTimeout(run, 4000);
    } else {
      run();
    }
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

function attemptResume(isPlaying, positionSeconds) {
  lastState = { isPlaying, positionSeconds };
  if (!playerReady) return;

  suppressEvents = true;
  const drift = Math.abs(getCurrentPosition() - positionSeconds);
  const needsSeek = drift > DRIFT_THRESHOLD_SECONDS;

  if (needsSeek) {
    if (currentVideoType === 'youtube') ytPlayer.seekTo(positionSeconds, true);
    else if (currentVideoType === 'twitch') twitchPlayer.seek(positionSeconds);
    else if (currentVideoType === 'player_capture' && capturePlayer?.seekTo) {
      capturePlayer.seekTo(positionSeconds);
    }
    else if (videoEl) videoEl.currentTime = positionSeconds;

    setTimeout(() => doPlayPause(isPlaying), 300);
    setTimeout(() => (suppressEvents = false), 1000);
  } else {
    doPlayPause(isPlaying);
    setTimeout(() => (suppressEvents = false), 400);
  }
}

// синхронно, БЕЗ единого setTimeout перед play() — сохраняет статус "по клику пользователя",
// который требуют браузеры/Twitch для программного запуска
function manualResyncViewer() {
  const { isPlaying, positionSeconds } = lastState;
  suppressEvents = true;

  if (currentVideoType === 'youtube') {
    ytPlayer.seekTo(positionSeconds, true);
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  } else if (currentVideoType === 'twitch') {
    twitchPlayer.seek(positionSeconds);
    isPlaying ? twitchPlayer.play() : twitchPlayer.pause();
    } else if (currentVideoType === 'player_capture' && capturePlayer) {
    const v = capturePlayer.videoEl;
    const run = () => {
      if (!v) {
        suppressEvents = false;
        return;
      }

      if (isPlaying) {
        v.play().catch((e) => console.warn('[capture] resync play failed', e));
        if (positionSeconds > 2) {
          const doSeek = () => {
            try { v.currentTime = positionSeconds; } catch (_) {}
          };
          if (v.readyState >= 2) setTimeout(doSeek, 800);
          else v.addEventListener('loadeddata', () => setTimeout(doSeek, 800), { once: true });
        }
      } else {
        try { v.currentTime = positionSeconds || 0; } catch (_) {}
        v.pause();
      }

      setTimeout(() => (suppressEvents = false), 1500);
    };
    if (v && v.readyState < 2) {
      v.addEventListener('loadeddata', run, { once: true });
      setTimeout(run, 4000);
    } else {
      run();
    }
  } else if (videoEl) {
    videoEl.currentTime = positionSeconds;
    isPlaying ? videoEl.play().catch(() => {}) : videoEl.pause();
  }

  setTimeout(() => (suppressEvents = false), 800);
}

function enforceHostState() {
  applyPlaybackState(lastState);
}

function emitPlayback(isPlaying) {
  if (suppressEvents || !isOwner) return;
  const positionSeconds = getCurrentPosition();
  lastState = { isPlaying, positionSeconds };
  savePlaybackCache(lastState);
  socket.emit('playback:update', { code, isPlaying, positionSeconds });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!isOwner || !started || !playerReady) return;
    emitPlayback(getIsPlayingNow());
  }, 3000);
}

function softSync({ isPlaying, positionSeconds }) {
  lastState = { isPlaying, positionSeconds };
  savePlaybackCache(lastState);
  if (!playerReady) return;

  const playingNow = getIsPlayingNow();
  const drift = Math.abs(getCurrentPosition() - positionSeconds);

  if (playingNow !== isPlaying || drift > DRIFT_THRESHOLD_SECONDS) {
    attemptResume(isPlaying, positionSeconds);
  }
}

function resync() {
  if (isOwner) {
    const isPlaying = getIsPlayingNow();
    const positionSeconds = getCurrentPosition();
    lastState = { isPlaying, positionSeconds };
    savePlaybackCache(lastState);
    socket.emit('playback:force-sync', { code, isPlaying, positionSeconds });
  } else {
    manualResyncViewer();
    socket.emit('room:resync', { code });
  }
}

function copyRoomLink() {
  navigator.clipboard.writeText(location.href);
  alert('Ссылка на комнату скопирована');
}

let copyToastTimer = null;

function showCopyToast(message) {
  const el = document.getElementById('copyToast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  // reflow, чтобы transition сработал повторно
  void el.offsetWidth;
  el.classList.add('show');

  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 200);
  }, 1200);
}

function copyText(text, label) {
  const okMsg = label === 'Название' ? 'Название скопировано' : `${label} скопирован`;
  navigator.clipboard.writeText(text).then(() => {
    showCopyToast(okMsg);
  }).catch(() => {
    showCopyToast('Не удалось скопировать');
  });
}

function startWatching() {
  started = true;
  hideOverlay();

  if (isOwner) {
    if (currentVideoType === 'youtube') ytPlayer.playVideo();
    else if (currentVideoType === 'twitch') twitchPlayer.play();
    else if (currentVideoType === 'player_capture' && capturePlayer?.doPlayPause) {
      capturePlayer.doPlayPause(true);
      const v = capturePlayer.videoEl;
      if (v && !v.dataset.captureBound) {
        v.dataset.captureBound = '1';
        v.addEventListener('play', () => emitPlayback(true));
        v.addEventListener('pause', () => emitPlayback(false));
        v.addEventListener('seeked', () => emitPlayback(!v.paused));
      }
    } else if (videoEl) {
      videoEl.play().catch(() => {});
    }
    startHeartbeat();
    startThumbnailCapture();
  } else {
    if (currentVideoType === 'player_capture' && capturePlayer?.videoEl) {
      const v = capturePlayer.videoEl;
      try { v.currentTime = 0; } catch (_) {}
      v.play().catch((e) => console.warn('[viewer] start play failed', e));
      setTimeout(() => softSync(lastState), 2000);
    } else {
      applyPlaybackState(lastState);
    }
  }
}

let cssFullscreenActive = false;

function isDocFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.webkitCurrentFullScreenElement ||
    cssFullscreenActive
  );
}

function setCssFullscreen(active) {
  const wrap = document.getElementById('playerWrap');
  if (!wrap) return;
  cssFullscreenActive = active;
  wrap.classList.toggle('css-fullscreen', active);
  onFullscreenChange();
}

function isIOSDevice() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
    /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)
  );
}

function toggleFullscreen(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();

  const wrap = document.getElementById('playerWrap');
  const video =
    getActiveVideoEl() ||
    document.querySelector('#player video') ||
    document.querySelector('#playerWrap video');

  console.log('[fs] toggleFullscreen', {
    isIOS: isIOSDevice(),
    inDocFs: isDocFullscreen(),
    hasVideo: !!video,
    videoReady: video?.readyState,
    paused: video?.paused,
    type: currentVideoType,
    webkitEnter: typeof video?.webkitEnterFullscreen,
  });

  if (!wrap) return;

  // уже в fullscreen (реальном или CSS-фейковом) — выходим
  if (isDocFullscreen()) {
    if (cssFullscreenActive) {
      setCssFullscreen(false);
      return;
    }
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.webkitCancelFullScreen;
    exit?.call(document);
    return;
  }

  // iOS: native webkitEnterFullscreen уводит видео в системный плеер —
  // вне DOM страницы, поэтому чат/кнопки поверх него не отрисовать никак.
  // Вместо этого растягиваем #playerWrap на весь экран через CSS —
  // работает одинаково для <video> (player_capture) и iframe (YouTube/Twitch),
  // а DOM остаётся нашим, так что чат-панель по-прежнему рендерится сверху.
  if (isIOSDevice()) {
    setCssFullscreen(true);
    return;
  }

  // десктоп / Android
  const req =
    wrap.requestFullscreen ||
    wrap.webkitRequestFullscreen ||
    wrap.webkitRequestFullScreen;
  if (req) {
    Promise.resolve(req.call(wrap)).catch((err) => {
      console.warn('[fs] requestFullscreen failed', err);
      if (video && typeof video.webkitEnterFullscreen === 'function') {
        try {
          video.webkitEnterFullscreen();
        } catch (_) {}
      }
    });
  } else if (video) {
    if (typeof video.webkitEnterFullscreen === 'function') {
      try {
        video.webkitEnterFullscreen();
      } catch (_) {}
    } else if (typeof video.requestFullscreen === 'function') {
      video.requestFullscreen().catch(() => {});
    }
  }
}

let fsControlsTimer = null;

function showFsControls() {
  const wrap = document.getElementById('playerWrap');
  if (!wrap) return;
  wrap.classList.remove('fs-controls-hidden');

  clearTimeout(fsControlsTimer);
  if (!isDocFullscreen()) return;

  fsControlsTimer = setTimeout(() => {
    if (isDocFullscreen()) {
      wrap.classList.add('fs-controls-hidden');
      // кнопки прячутся — попап громкости без видимой кнопки не нужен, закрываем вместе с ними
      document.getElementById('volumePopup')?.classList.add('hidden');
    }
  }, 3000);
}

function onFullscreenChange() {
  const inFullscreen = isDocFullscreen();
  const chatBtn = document.getElementById('fsChatToggleBtn');
  if (chatBtn) chatBtn.classList.toggle('hidden', !inFullscreen);

  document.getElementById('playerWrap')?.classList.toggle('in-fullscreen', inFullscreen);

  if (!inFullscreen) {
    document.getElementById('fsChatPanel')?.classList.add('hidden');
    document.getElementById('volumePopup')?.classList.add('hidden');
    document.getElementById('playerWrap')?.classList.remove('fs-controls-hidden');
    clearTimeout(fsControlsTimer);
  } else {
    showFsControls();
  }
}

document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

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

function renderParticipantRowsInto(container, list) {
  if (!container) return;
  container.innerHTML = '';

  const myName = socket?.user?.username || null;

  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'participant-row';

    const isMe = myName && p.username === myName;
    const vol = getUserVoiceVolume(p.username);

    row.innerHTML = `
      <div class="participant-row-main">
        <span>${p.username}${p.isOwner ? ' (Хост)' : ''}${isMe ? ' (вы)' : ''}</span>
        ${isOwner && !p.isOwner ? '<button type="button" class="kick-btn">Кикнуть</button>' : ''}
      </div>
      ${!isMe ? `
        <div class="participant-vol">
          <span class="participant-vol-label">🔊</span>
          <input type="range" class="participant-vol-slider" min="0" max="100" value="${vol}" data-username="${p.username}">
          <span class="participant-vol-value">${vol}%</span>
        </div>
      ` : ''}`;

    if (isOwner && !p.isOwner) {
      row.querySelector('.kick-btn').onclick = () => {
        if (confirm(`Кикнуть и заблокировать ${p.username} в этой комнате?`)) {
          socket.emit('room:kick', { code, targetUsername: p.username });

          const normalBannedOpen = !document.getElementById('bannedModal')?.classList.contains('hidden');
          const fsBannedOpen = !document.getElementById('fsBannedView')?.classList.contains('hidden');
          if (normalBannedOpen || fsBannedOpen) {
            socket.emit('room:banned-list', { code });
          }
        }
      };
    }

    const slider = row.querySelector('.participant-vol-slider');
    const valueEl = row.querySelector('.participant-vol-value');
    if (slider) {
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        if (valueEl) valueEl.textContent = v + '%';
        setUserVoiceVolume(p.username, v);
      });
    }

    container.appendChild(row);
  });
}

function renderParticipants(list) {
  document.getElementById('participantCount').textContent = list.length;
  renderParticipantRowsInto(document.getElementById('participantsList'), list);
  document.getElementById('bannedListBtn').classList.toggle('hidden', !isOwner);

  // та же логика, но для панели участников внутри fullscreen-чата
  const fsCountEl = document.getElementById('fsParticipantCount');
  if (fsCountEl) fsCountEl.textContent = list.length;
  renderParticipantRowsInto(document.getElementById('fsParticipantsList'), list);
  document.getElementById('fsBannedListBtn')?.classList.toggle('hidden', !isOwner);

  // бэйдж с числом участников прямо на кнопке ⚙️ во fullscreen
  const badge = document.getElementById('fsSettingsBadge');
  if (badge) {
    badge.textContent = list.length;
    badge.classList.toggle('hidden', list.length === 0);
  }
}

function renderBannedRowsInto(container, list) {
  if (!container) return;
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

function renderBannedList(list) {
  renderBannedRowsInto(document.getElementById('bannedList'), list);
  renderBannedRowsInto(document.getElementById('fsBannedList'), list);
}

function openFsParticipants() {
  socket.emit('room:participants', { code });
  document.getElementById('fsParticipantsPanel')?.classList.remove('hidden');
  hideFsBannedView();
}

function closeFsParticipants() {
  document.getElementById('fsParticipantsPanel')?.classList.add('hidden');
}

function toggleFsParticipants() {
  const panel = document.getElementById('fsParticipantsPanel');
  if (!panel) return;
  panel.classList.contains('hidden') ? openFsParticipants() : closeFsParticipants();
}

function showFsBannedView() {
  socket.emit('room:banned-list', { code });
  document.getElementById('fsParticipantsList')?.classList.add('hidden');
  document.getElementById('fsBannedListBtn')?.classList.add('hidden');
  document.getElementById('fsBannedView')?.classList.remove('hidden');
}

function hideFsBannedView() {
  document.getElementById('fsBannedView')?.classList.add('hidden');
  document.getElementById('fsParticipantsList')?.classList.remove('hidden');
  if (isOwner) document.getElementById('fsBannedListBtn')?.classList.remove('hidden');
}

function initChatInputPlaceholder() {
  const chatInputEl = document.getElementById('chatInput');
  if (!chatInputEl) return;
  const originalPlaceholder = chatInputEl.placeholder;
  chatInputEl.addEventListener('focus', () => { chatInputEl.placeholder = ''; });
  chatInputEl.addEventListener('blur', () => {
    if (!chatInputEl.value) chatInputEl.placeholder = originalPlaceholder;
  });
}

const VIDEO_TYPE_LABELS = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  drive: 'Google Диск',
  player_capture: 'Захват плеера',
  direct: 'Прямая ссылка',
  vk: 'VK',
};

function updateVideoChangeModeLabel(type) {
  const el = document.getElementById('videoChangeModeLabel');
  if (!el) return;
  el.textContent = VIDEO_TYPE_LABELS[type] || type || '—';
}

function destroyCurrentPlayer() {
  try {
    if (ytPlayer && typeof ytPlayer.destroy === 'function') {
      ytPlayer.destroy();
    }
  } catch (_) {}
  ytPlayer = null;

  try {
    if (twitchPlayer && typeof twitchPlayer.destroy === 'function') {
      twitchPlayer.destroy();
    }
  } catch (_) {}
  twitchPlayer = null;

  try {
    if (capturePlayer?.destroy) capturePlayer.destroy();
  } catch (_) {}
  capturePlayer = null;

  videoEl = null;
  playerReady = false;
  started = false;
  ageGateResolvedForVideo = false;
  ageGateHandling = false;

  const container = document.getElementById('player');
  if (container) container.innerHTML = '';
}

async function applyNewVideo(video, playback) {
  destroyCurrentPlayer();
  clearPlaybackCache();

  window.__captureVideoUrl = video?.url || null;
  window.__lastVideoUrl = video?.url || null;
  currentVideoType = video?.type || null;
  lastState = playback || { isPlaying: false, positionSeconds: 0 };
  updateVideoChangeModeLabel(video?.type);

  await renderPlayer(video);
  setTimeout(refreshCcButton, 800);

  if (isOwner) {
    setOverlay('Готово к просмотру', true);
  } else {
    setOverlay('Хост сменил видео — нажми, чтобы продолжить', true);
  }
}

async function changeVideoUrl() {
  if (!isOwner) return;
  const input = document.getElementById('videoChangeUrl');
  const btn = document.getElementById('videoChangeBtn');
  const url = (input?.value || '').trim();
  if (!url) {
    alert('Вставь новую ссылку');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Меняем...';
  }

  try {
    const data = await api(`/rooms/${code}/change-video`, {
      method: 'POST',
      body: { url },
    });
    if (input) input.value = '';
    await applyNewVideo(data.video, data.playback);
  } catch (err) {
    alert(err.message || 'Не удалось сменить видео');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Сменить';
    }
  }
}
window.changeVideoUrl = changeVideoUrl;

async function init() {
  const me = await api('/auth/me').catch(() => null);
  if (!me) return (location.href = '/index.html');

  document.getElementById('roomCodeValue').textContent = code;
  document.getElementById('roomCodeValue').onclick = () => copyText(code, 'Код');
  setOverlay('Загрузка комнаты...', false);

  const volumeSliderEl = document.getElementById('volumeSlider');
  if (volumeSliderEl) volumeSliderEl.value = getSavedVolume();
  initChatInputPlaceholder();
  initLockButtonsControl();

  socket = io();
  socket.on('connect', () => socket.emit('room:join', { code }));

  window.socket = socket;
  window.code = code;

  socket.on('chat:history', (list) => {
    list.forEach(({ username, text }) => addHistoryMessage({ username, text }));
  });

  socket.on('youtube:age-restricted-stream', async ({ url }) => {
    if (isOwner) return;
    const confirmed = await askAgeGate();
    if (!confirmed) {
      setOverlay('Хост включил контент 18+. Обнови страницу, если готов подтвердить возраст.', false);
      return;
    }
    renderDirectVideoUrl(url);
  });

  socket.on('room:state', async ({ video, playback, isOwner: ownerFlag, name }) => {
    isOwner = ownerFlag;
    window.__captureVideoUrl = video?.url || window.__captureVideoUrl || null;
    window.__lastVideoUrl = video?.url || null;
    updateVideoChangeModeLabel(video?.type);

    const cached = loadPlaybackCache();
    const serverPos = playback?.positionSeconds || 0;
    if (
      cached &&
      cached.videoUrl === (video?.url || null) &&
      serverPos < 2 &&
      cached.positionSeconds > 5
    ) {
      lastState = {
        isPlaying: cached.isPlaying,
        positionSeconds: cached.positionSeconds,
      };
    } else {
      lastState = playback || { isPlaying: false, positionSeconds: 0 };
    }

    if (lastState && typeof lastState.positionSeconds === 'number') {
      savePlaybackCache(lastState);
    }

    const nameEl = document.getElementById('roomNameValue');
    if (nameEl) {
      nameEl.textContent = name || 'Без названия';
      nameEl.onclick = () => copyText(name || '', 'Название');
    }

    setViewMode('chat');
    await renderPlayer(video);
    setTimeout(refreshCcButton, 800);

    if (isOwner) {
      setOverlay('Готово к просмотру', true);
    } else {
      updateWaitingOverlayText();
      showLocalSystemMessage(
        `Когда хост запускает видео, тебе нужно запустить у себя вручную (кнопкой или пробелом). После этого можно нажать «Синхронизировать», а сайт сам подстроит тебя автоматически, если отставание больше ${DRIFT_THRESHOLD_SECONDS} секунд.`
      );
    }
  });

window.__onCapturePlayerReload = (player) => {
  capturePlayer = player;
  currentVideoType = 'player_capture';
  playerReady = true;

  if (player?.videoEl) {
    player.videoEl.volume = getSavedVolume() / 100;
  }

  // хост: слушатели на НОВОМ video
  if (isOwner && player?.videoEl && !player.videoEl.dataset.captureBound) {
    const v = player.videoEl;
    v.dataset.captureBound = '1';
    v.addEventListener('play', () => emitPlayback(true));
    v.addEventListener('pause', () => emitPlayback(false));
    v.addEventListener('seeked', () => emitPlayback(!v.paused));
  }
  setTimeout(refreshCcButton, 500);
};

  socket.on('playback:update', (state) => {
    lastState = state;
    savePlaybackCache(state);

    if (!started) {
      updateWaitingOverlayText();
      return;
    }

    if (currentVideoType === 'player_capture' && capturePlayer?.videoEl) {
      const v = capturePlayer.videoEl;

      if (state.isPlaying) {
        if (v.paused) {
          v.play().catch((e) => console.warn('[viewer] sync play failed', e));
        }
      } else {
        if (!v.paused) v.pause();
      }
      return;
    }

    softSync(state);
  });

  socket.on('playback:force-sync', ({ isPlaying, positionSeconds }) => {
    if (isOwner) return;
    lastState = { isPlaying: !!isPlaying, positionSeconds: Number(positionSeconds) || 0 };
    savePlaybackCache(lastState);

    if (!started) {
      updateWaitingOverlayText();
      return;
    }

    applyPlaybackState(lastState);
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

  socket.on('room:video-changed', async ({ video, playback, by }) => {
    await applyNewVideo(video, playback);
  });

  socket.on('player_capture:streams', async ({ season, episode, voice, streams, meta, by }) => {
    if (isOwner) return;

    addMessage({
      username: 'Система',
      text: `Хост сменил на Сезон ${season}, Серия ${episode}`,
    });

    lastState = { isPlaying: false, positionSeconds: 0 };
    started = false;
    playerReady = false;

    const container = document.getElementById('player');
    const url = window.__captureVideoUrl;
    if (!container || !streams?.length) return;

    try {
      const mod = await import('/js/playerCapture/index.js?t=' + Date.now());
      capturePlayer = mod.renderFromStreams(streams, meta || {
        currentSeason: season,
        currentEpisode: episode,
      }, {
        isOwner: false,
        container,
        videoUrl: url,
      });
      currentVideoType = 'player_capture';
      playerReady = true;

    const v = capturePlayer.videoEl;
      if (v) {
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.addEventListener('error', () => {
          console.error('[viewer] video error', v.error);
        });
        // если буфер/HLS сам поставил на паузу — поднимаем, пока хост играет
        v.addEventListener('pause', () => {
          if (started && lastState.isPlaying) {
            setTimeout(() => {
              if (lastState.isPlaying && v.paused) {
                v.play().catch(() => {});
              }
            }, 200);
          }
        });
      }
      setTimeout(refreshCcButton, 500);
      setOverlay('Хост сменил серию — нажми, чтобы продолжить', true);
    } catch (e) {
      console.error('[viewer] streams error', e);
      setOverlay('Ошибка загрузки серии', false);
    }
  });

  socket.on('chat:message', addMessage);
  socket.on('room:error', (err) => alert(err.error));

  socket.on('voice:participants', (list) => {
    voiceParticipants = list;
    renderVoicePanel();
  });

  socket.on('voice:existing-participants', (list) => {
    // я только что зашёл в звонок — сам звоню каждому, кто уже там
    list.forEach((p) => callPeer(p.socketId));
  });

  socket.on('voice:user-left', ({ socketId }) => {
    const pc = peerConnections[socketId];
    if (pc) {
      try { pc.close(); } catch (_) {}
      delete peerConnections[socketId];
    }
    remoteAudioEls[socketId]?.remove();
    delete remoteAudioEls[socketId];
  });

  socket.on('voice:signal', (payload) => {
    handleVoiceSignal(payload).catch((e) => console.warn('[voice] signal error', e));
  });

  initViewMode();
}



document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !isOwner || !started) return;

  // если печатаем в чате / инпуте — пробел обычный
  const el = document.activeElement;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
  if (!playerFocused) return;

  e.preventDefault();

  if (currentVideoType === 'youtube') {
    const state = ytPlayer.getPlayerState();
    state === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
  } else if (currentVideoType === 'twitch') {
    twitchPlayer.isPaused() ? twitchPlayer.play() : twitchPlayer.pause();
  } else if (currentVideoType === 'player_capture' && capturePlayer?.videoEl) {
    const v = capturePlayer.videoEl;
    v.paused ? v.play().catch(() => {}) : v.pause();
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

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function usernameColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

function formatMessageHTML(username, text) {
  const isSystem = username === 'Система';
  const nameHTML = isSystem
    ? `<span style="color:var(--danger); font-weight:600;">Система</span>`
    : `<b style="color:${usernameColor(username)}">${escapeHTML(username)}</b>`;
  return `${nameHTML}: ${escapeHTML(text)}`;
}

function appendMessageTo(containerId, username, text) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = formatMessageHTML(username, text);
  container.appendChild(div);
  container.scrollTop = 1e9;
}

let fsNoticeTimer = null;

function showFsNotice(username, text) {
  if (!isDocFullscreen()) return;
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

function addHistoryMessage({ username, text }) {
  // старые сообщения из истории — без всплывающего уведомления в fullscreen, только сам текст
  appendMessageTo('messages', username, text);
  appendMessageTo('fsMessages', username, text);
}

function showLocalSystemMessage(text) {
  // видно только этому зрителю локально, не рассылается остальным по сокету
  appendMessageTo('messages', 'Система', text);
  appendMessageTo('fsMessages', 'Система', text);
}

const BUTTONS_LOCK_KEY = 'pw_buttons_locked';

function areButtonsLocked() {
  return localStorage.getItem(BUTTONS_LOCK_KEY) === '1';
}

function updateLockButtonAppearance() {
  const btn = document.getElementById('lockButtonsBtn');
  if (!btn) return;
  const locked = areButtonsLocked();
  btn.textContent = locked ? '🔒' : '🔓';
  btn.classList.toggle('lock-state-locked', locked);
  btn.classList.toggle('lock-state-unlocked', !locked);
}

function setButtonsLocked(locked) {
  localStorage.setItem(BUTTONS_LOCK_KEY, locked ? '1' : '0');
  updateLockButtonAppearance();
}

function initLockButtonsControl() {
  const btn = document.getElementById('lockButtonsBtn');
  if (!btn) return;
  updateLockButtonAppearance();

  let hoverTimer = null;
  let tooltipEl = null;

  function showTooltip() {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'lock-btn-tooltip';
    tooltipEl.textContent = 'Заблокировать/разблокировать движение кнопок плеера';
    btn.appendChild(tooltipEl);
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  function startHover() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(showTooltip, 3000);
  }

  function cancelHover() {
    clearTimeout(hoverTimer);
    hideTooltip();
  }

  // клик — сразу переключает состояние, без задержки
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    setButtonsLocked(!areButtonsLocked());
  });

  // 3 сек наведения (десктоп) — просто подсказка, ничего не переключает
  btn.addEventListener('mouseenter', startHover);
  btn.addEventListener('mouseleave', cancelHover);
}

function makeDraggable(el, storageKey) {
  const container = document.getElementById('playerWrap');
  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_THRESHOLD = 6;

  let longPressTimer = null;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function currentMode() {
    return isDocFullscreen() ? 'fullscreen' : 'normal';
  }

  function storageFullKey() {
    return `pw-pos:${storageKey}:${currentMode()}`;
  }

  function resetPosition() {
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
  }

  function applySavedPosition() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageFullKey()) || 'null'); } catch (_) {}

    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      resetPosition();
      return;
    }

    const p = container.getBoundingClientRect();
    if (!p.width || !p.height) return; // плеер скрыт (мобилка) — не трогаем

    const w = el.offsetWidth || 40;
    const h = el.offsetHeight || 40;
    if (saved.left < 0 || saved.top < 0 || saved.left > p.width - w || saved.top > p.height - h) {
      resetPosition(); // не влезает — дефолт, сохранённое не стираем
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

    // кнопки заблокированы через замочек в чате — long-press не запускаем,
    // pointerdown → pointerup засчитается как обычный клик
    if (areButtonsLocked()) {
      return;
    }

    // iPhone / узкий экран: drag кнопок FS отключаем —
    // long-press + capture ломает обычный тап в Chrome/Safari
    const isTouchUI =
      window.matchMedia('(pointer: coarse)').matches ||
      isIOSDevice() ||
      window.innerWidth <= 768;
    if (isTouchUI) {
      return;
    }

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
      } catch {}
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) > MOVE_CANCEL_THRESHOLD || Math.abs(e.clientY - startY) > MOVE_CANCEL_THRESHOLD) {
        clearTimeout(longPressTimer); // сдвинул до истечения таймера — это не долгое нажатие, отменяем
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
      // после реального перетаскивания гасим следующий click, чтобы отпускание мышки/пальца
      // не засчиталось как обычное нажатие кнопки (открытие чата / переключение fullscreen)
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

function setViewMode(mode) {
  document.body.classList.remove('view-chat-only', 'view-video-only');

  const btnChat = document.getElementById('btnShowChat');
  const btnVideo = document.getElementById('btnShowVideo');
  const hostControls = document.getElementById('hostControls');

  if (btnVideo) {
    btnVideo.style.display = isOwner ? '' : 'none';
  }

  // зритель всегда видит и видео, и чат одновременно — переключение вкладок только для хоста
  if (!isOwner) {
    btnChat.classList.add('active');
    if (hostControls) hostControls.classList.add('hidden');
    return;
  }

  if (mode === 'chat') {
    document.body.classList.add('view-chat-only');
    btnChat.classList.add('active');
    btnVideo.classList.remove('active');
    if (hostControls) hostControls.classList.add('hidden');
  } else {
    document.body.classList.add('view-video-only');
    btnVideo.classList.add('active');
    btnChat.classList.remove('active');
    if (hostControls) hostControls.classList.remove('hidden');
  }
}

function initViewMode() {
  // Зрители всегда в чате, хост тоже по умолчанию в чате
  setViewMode('chat');
}

const CC_STORAGE_KEY = 'pw_subtitles_on';
let subtitlesOn = localStorage.getItem(CC_STORAGE_KEY) === '1';

function persistSubtitlesPref() {
  localStorage.setItem(CC_STORAGE_KEY, subtitlesOn ? '1' : '0');
}

function forceYoutubeCaptionsOff() {
  if (!ytPlayer || subtitlesOn) return;
  try {
    ytPlayer.unloadModule('captions');
    ytPlayer.unloadModule('cc');
  } catch (_) {}
}

function getActiveVideoEl() {
  if (currentVideoType === 'player_capture' && capturePlayer?.videoEl) return capturePlayer.videoEl;
  if (videoEl) return videoEl;
  return null;
}

function refreshCcButton() {
  const btn = document.getElementById('ccBtn');
  if (!btn) return;

  if (currentVideoType === 'youtube' && ytPlayer) {
    btn.classList.remove('hidden-cc');
    btn.classList.toggle('active', subtitlesOn);
    return;
  }

  const v = getActiveVideoEl();
  const hasTracks = v && v.textTracks && v.textTracks.length > 0;
  if (!hasTracks) {
    btn.classList.add('hidden-cc');
    return;
  }
  btn.classList.remove('hidden-cc');
  btn.classList.toggle('active', subtitlesOn);
}

const VOLUME_STORAGE_KEY = 'pw_volume';

function getSavedVolume() {
  const v = parseInt(localStorage.getItem(VOLUME_STORAGE_KEY), 10);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 30;
}

function saveVolume(v) {
  localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
}

function applyVolumeToActivePlayer(v) {
  const frac = v / 100;
  if (currentVideoType === 'youtube' && ytPlayer) {
    try { ytPlayer.setVolume(v); } catch (_) {}
  } else if (currentVideoType === 'twitch' && twitchPlayer) {
    try { twitchPlayer.setVolume(frac); } catch (_) {}
  } else {
    const v_el = getActiveVideoEl();
    if (v_el) v_el.volume = frac;
  }
}

function positionVolumePopup() {
  const popup = document.getElementById('volumePopup');
  const btn = document.getElementById('volumeBtn');
  const container = document.getElementById('playerWrap');
  if (!popup || !btn || !container) return;

  const parentRect = container.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const popupW = popup.offsetWidth || 140;
  const popupH = popup.offsetHeight || 50;

  let left = btnRect.left - parentRect.left;
  let top = btnRect.bottom - parentRect.top + 8;

  // не влезает справа — прижимаем правым краем попапа к правому краю кнопки
  if (left + popupW > parentRect.width - 8) {
    left = btnRect.right - parentRect.left - popupW;
  }
  if (left < 8) left = 8;

  // не влезает снизу — открываем над кнопкой
  if (top + popupH > parentRect.height - 8) {
    top = btnRect.top - parentRect.top - popupH - 8;
  }
  if (top < 8) top = 8;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.style.right = 'auto';
  popup.style.bottom = 'auto';
}

function toggleVolumePopup(e) {
  e?.stopPropagation?.();
  const popup = document.getElementById('volumePopup');
  if (!popup) return;
  const willShow = popup.classList.contains('hidden');
  popup.classList.toggle('hidden');
  if (willShow) {
    requestAnimationFrame(positionVolumePopup);
  }
}
window.toggleVolumePopup = toggleVolumePopup;

document.getElementById('volumeSlider')?.addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  saveVolume(v);
  applyVolumeToActivePlayer(v);
});

document.addEventListener('click', (e) => {
  const popup = document.getElementById('volumePopup');
  if (!popup || popup.classList.contains('hidden')) return;
  if (!popup.contains(e.target) && e.target.id !== 'volumeBtn') {
    popup.classList.add('hidden');
  }
});

window.addEventListener('resize', () => {
  const popup = document.getElementById('volumePopup');
  if (popup && !popup.classList.contains('hidden')) positionVolumePopup();
});
document.addEventListener('fullscreenchange', () => {
  const popup = document.getElementById('volumePopup');
  if (popup && !popup.classList.contains('hidden')) requestAnimationFrame(positionVolumePopup);
});
document.addEventListener('webkitfullscreenchange', () => {
  const popup = document.getElementById('volumePopup');
  if (popup && !popup.classList.contains('hidden')) requestAnimationFrame(positionVolumePopup);
});

function applySubtitlesState() {
  if (currentVideoType === 'youtube' && ytPlayer) {
    try {
      if (subtitlesOn) {
        ytPlayer.loadModule('captions');
        try {
          ytPlayer.setOption('captions', 'track', { languageCode: 'ru' });
        } catch (_) {}
      } else {
        forceYoutubeCaptionsOff();
      }
    } catch (_) {}
    refreshCcButton();
    return;
  }

  const v = getActiveVideoEl();
  if (!v?.textTracks) {
    refreshCcButton();
    return;
  }

  for (let i = 0; i < v.textTracks.length; i++) {
    v.textTracks[i].mode = subtitlesOn ? 'showing' : 'hidden';
  }
  refreshCcButton();
}

function toggleSubtitles() {
  subtitlesOn = !subtitlesOn;
  persistSubtitlesPref();
  applySubtitlesState();
}

window.toggleSubtitles = toggleSubtitles;

setInterval(() => {
  if (currentVideoType === 'youtube' && ytPlayer && !subtitlesOn && playerReady) {
    forceYoutubeCaptionsOff();
  }
}, 4000);


const playerWrapEl = document.getElementById('playerWrap');

playerWrapEl?.addEventListener('pointerdown', () => {
  playerFocused = true;
  if (isDocFullscreen()) showFsControls();
}, true);

playerWrapEl?.addEventListener('mousemove', () => {
  if (isDocFullscreen()) showFsControls();
});

const catcherEl = document.getElementById('fsActivityCatcher');
catcherEl?.addEventListener('pointerdown', (e) => {
  playerFocused = true;
  e.stopPropagation();
  e.preventDefault();
  showFsControls();
});
catcherEl?.addEventListener('pointermove', () => showFsControls());

document.addEventListener('keydown', () => {
  if (isDocFullscreen()) showFsControls();
}, true);

window.addEventListener('blur', () => {
  if (isDocFullscreen()) showFsControls();
});
document.getElementById('chat')?.addEventListener('pointerdown', () => {
  playerFocused = false;
});

function usernameInitial(username) {
  return (username || '?').trim().charAt(0).toUpperCase();
}

function renderVoicePanel() {
  const panel = document.getElementById('voiceCallPanel');
  const text = document.getElementById('voiceCallPanelText');
  const avatarsEl = document.getElementById('voiceAvatars');
  const countEl = document.getElementById('voiceCountText');
  const hangupBtn = document.getElementById('voiceHangupBtn');
  const callBtn = document.getElementById('voiceCallBtn');
  if (!panel) return;

  const count = voiceParticipants.length;
  panel.classList.toggle('hidden', count === 0);
  panel.classList.toggle('joined', inVoiceCall);
  callBtn?.classList.toggle('in-call', inVoiceCall);

  if (count === 0) return;

  text.textContent = inVoiceCall ? 'Вы в звонке' : 'Присоединиться к звонку';
  countEl.textContent = count >= VOICE_WARN_THRESHOLD
    ? `В звонке: ${count} (может тормозить)`
    : `В звонке: ${count}`;
  hangupBtn.classList.toggle('hidden', !inVoiceCall);

  avatarsEl.innerHTML = '';
  voiceParticipants.slice(0, 5).forEach((p) => {
    const av = document.createElement('div');
    av.className = 'voice-avatar';
    av.style.background = usernameColor(p.username);
    av.textContent = usernameInitial(p.username);
    av.title = p.username;
    if (p.isOwner) {
      const crown = document.createElement('span');
      crown.className = 'voice-avatar-crown';
      crown.textContent = '👑';
      av.appendChild(crown);
    }
    avatarsEl.appendChild(av);
  });
  if (voiceParticipants.length > 5) {
    const more = document.createElement('div');
    more.className = 'voice-avatar';
    more.style.background = 'var(--surface)';
    more.textContent = `+${voiceParticipants.length - 5}`;
    avatarsEl.appendChild(more);
  }
}

function openVoiceConfirmModal() {
  document.getElementById('voiceCallConfirmModal')?.classList.remove('hidden');
}
function closeVoiceConfirmModal() {
  document.getElementById('voiceCallConfirmModal')?.classList.add('hidden');
}

function onVoiceCallBtnClick() {
  if (inVoiceCall) {
    leaveVoiceCall();
  } else {
    openVoiceConfirmModal();
  }
}
window.onVoiceCallBtnClick = onVoiceCallBtnClick;

async function startVoiceCall() {
  closeVoiceConfirmModal();
  if (inVoiceCall) return;

  if (voiceParticipants.length >= MAX_VOICE_PARTICIPANTS) {
    alert(`Звонок уже заполнен (максимум ${MAX_VOICE_PARTICIPANTS} человек) — попробуй позже.`);
    return;
  }

  try {
    localStream = await createProcessedLocalStream();
  } catch (e) {
    // voiceIsolation может не поддерживаться — пробуем без него
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      rawLocalStream = raw;
      localStream = raw;
    } catch (e2) {
      alert('Не удалось получить доступ к микрофону: ' + (e2.message || e2));
      return;
    }
  }

  await getIceServers(); // прогреваем кэш заранее, до прихода первого offer/answer
  inVoiceCall = true;
  socket.emit('voice:join', { code });
  renderVoicePanel();
}

function stopAllPeerConnections() {
  Object.keys(peerConnections).forEach((id) => {
    try { peerConnections[id].close(); } catch (_) {}
    delete peerConnections[id];
  });
  Object.keys(remoteAudioEls).forEach((id) => {
    remoteAudioEls[id]?.remove();
    delete remoteAudioEls[id];
  });
}

function leaveVoiceCall() {
  if (!inVoiceCall) return;
  inVoiceCall = false;
  socket.emit('voice:leave', { code });
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (rawLocalStream) {
    rawLocalStream.getTracks().forEach((t) => t.stop());
    rawLocalStream = null;
  }
  if (voiceAudioCtx) {
    try { voiceAudioCtx.close(); } catch (_) {}
    voiceAudioCtx = null;
  }
  stopAllPeerConnections();
  renderVoicePanel();
}
window.leaveVoiceCall = leaveVoiceCall;

let cachedIceServers = null;
let cachedIceServersExpiry = 0;

async function getIceServers() {
  const now = Date.now();
  if (cachedIceServers && now < cachedIceServersExpiry) return cachedIceServers;

  try {
    const data = await api('/voice/ice-servers');
    cachedIceServers = data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    // обновляем креды заранее, за минуту до истечения TTL, а не впритык
    cachedIceServersExpiry = now + Math.max(30, (data.ttlSeconds || 3600) - 60) * 1000;
  } catch (e) {
    console.warn('[voice] не удалось получить ICE-серверы, использую только STUN', e);
    cachedIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    cachedIceServersExpiry = now + 60 * 1000; // короткий кэш ошибки, чтобы не долбить сервер
  }
  return cachedIceServers;
}

function getOrCreatePeerConnection(remoteSocketId, iceServers) {
  if (peerConnections[remoteSocketId]) return peerConnections[remoteSocketId];

  const pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnections[remoteSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice:signal', { code, to: remoteSocketId, data: { type: 'ice-candidate', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    let audioEl = remoteAudioEls[remoteSocketId];
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      document.getElementById('voiceAudioContainer')?.appendChild(audioEl);
      remoteAudioEls[remoteSocketId] = audioEl;
    }
    audioEl.srcObject = e.streams[0];
    const peer = voiceParticipants.find((p) => p.socketId === remoteSocketId);
    if (peer) {
      audioEl.volume = getUserVoiceVolume(peer.username) / 100;
    }
  };

  pc.onconnectionstatechange = () => {
    if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) {
      try { pc.close(); } catch (_) {}
      delete peerConnections[remoteSocketId];
      remoteAudioEls[remoteSocketId]?.remove();
      delete remoteAudioEls[remoteSocketId];
    }
  };

  return pc;
}

async function callPeer(remoteSocketId) {
  const iceServers = await getIceServers();
  const pc = getOrCreatePeerConnection(remoteSocketId, iceServers);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice:signal', { code, to: remoteSocketId, data: { type: 'offer', sdp: offer } });
}

async function handleVoiceSignal({ from, data }) {
  const iceServers = await getIceServers();
  const pc = getOrCreatePeerConnection(from, iceServers);

  if (data.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice:signal', { code, to: from, data: { type: 'answer', sdp: answer } });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'ice-candidate' && data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
  }
}

function leaveRoom() {
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  } catch (_) {}
  stopThumbnailCapture();
  try {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (rawLocalStream) {
      rawLocalStream.getTracks().forEach((t) => t.stop());
      rawLocalStream = null;
    }
    if (voiceAudioCtx) {
      try { voiceAudioCtx.close(); } catch (_) {}
      voiceAudioCtx = null;
    }
    stopAllPeerConnections();
  } catch (_) {}
  try {
    if (capturePlayer?.destroy) capturePlayer.destroy();
  } catch (_) {}
  try {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  } catch (_) {}
  window.location.replace('/index.html');
}

function bindTap(el, handler) {
  if (!el) return;

  const id = el.id || el.className || 'btn';
  let lastFire = 0;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let touchHandled = false;
  const FIRE_GAP_MS = 350;
  const MOVE_PX = 14;

  const fire = (e, via) => {
    const now = Date.now();
    const gap = now - lastFire;
    if (gap < FIRE_GAP_MS) {
      console.log('[bindTap] SKIP (debounce)', id, via, 'gap=', gap);
      return;
    }
    lastFire = now;
    console.log('[bindTap] FIRE', id, via, {
      type: e?.type,
      pointerType: e?.pointerType,
      dragging: el.classList.contains('dragging'),
    });
    e?.preventDefault?.();
    e?.stopPropagation?.();
    try {
      handler(e);
    } catch (err) {
      console.error('[bindTap] handler error', id, err);
    }
  };

  el.addEventListener(
    'touchstart',
    (e) => {
      moved = false;
      touchHandled = false;
      const t = e.changedTouches?.[0] || e.touches?.[0];
      startX = t?.clientX ?? 0;
      startY = t?.clientY ?? 0;
      console.log('[bindTap] touchstart', id);
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      const t = e.changedTouches?.[0] || e.touches?.[0];
      if (!t) return;
      if (
        Math.abs(t.clientX - startX) > MOVE_PX ||
        Math.abs(t.clientY - startY) > MOVE_PX
      ) {
        moved = true;
      }
    },
    { passive: true }
  );

  el.addEventListener(
    'touchend',
    (e) => {
      console.log('[bindTap] touchend', id, { moved, dragging: el.classList.contains('dragging') });
      if (moved || el.classList.contains('dragging')) return;
      touchHandled = true;
      fire(e, 'touchend');
    },
    { passive: false }
  );

  el.addEventListener('click', (e) => {
    // после touchend браузер ещё шлёт click — игнорим, иначе toggle 2 раза
    if (touchHandled) {
      console.log('[bindTap] click ignored (after touch)', id);
      touchHandled = false;
      e.preventDefault?.();
      e.stopPropagation?.();
      return;
    }
    if (e.pointerType === 'touch') {
      console.log('[bindTap] click ignored (pointerType=touch)', id);
      return;
    }
    fire(e, 'click');
  });
}

bindTap(document.getElementById('fullscreenBtn'), toggleFullscreen);
bindTap(document.getElementById('fsChatToggleBtn'), toggleFsChat);
bindTap(document.getElementById('ccBtn'), toggleSubtitles);
bindTap(document.getElementById('volumeBtn'), toggleVolumePopup);
bindTap(document.getElementById('startBtn'), startWatching);
// Делаем функции доступными из HTML
window.setViewMode = setViewMode;
window.closeModal = closeModal;
window.toggleFullscreen = toggleFullscreen;
window.toggleFsChat = toggleFsChat;
window.closeFsChat = closeFsChat;
window.startWatching = startWatching;
window.resync = resync;
window.leaveRoom = leaveRoom;
window.openSettings = openSettings;
window.openBannedList = openBannedList;
window.copyRoomLink = copyRoomLink;
window.sendMessage = sendMessage;
window.toggleSubtitles = toggleSubtitles;


// --- Сохранённый размер fs-чата (ресайз за угол) ---
const FS_CHAT_SIZE_KEY = 'pw-size:fsChatPanel:fullscreen';
const FS_CHAT_MIN_W = 220;
const FS_CHAT_MIN_H = 200;

function getFsChatSavedSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(FS_CHAT_SIZE_KEY) || 'null');
    if (saved && typeof saved.width === 'number' && typeof saved.height === 'number') return saved;
  } catch (_) {}
  return null;
}

function saveFsChatSize(width, height) {
  localStorage.setItem(FS_CHAT_SIZE_KEY, JSON.stringify({ width, height }));
}

function applyFsChatPanelSize() {
  const panel = document.getElementById('fsChatPanel');
  const container = document.getElementById('playerWrap');
  if (!panel || !container || panel.classList.contains('hidden')) return;

  const saved = getFsChatSavedSize();
  if (!saved) return;

  const p = container.getBoundingClientRect();
  const maxW = Math.max(FS_CHAT_MIN_W, p.width - 16);
  const maxH = Math.max(FS_CHAT_MIN_H, p.height - 16);
  const width = Math.max(FS_CHAT_MIN_W, Math.min(saved.width, maxW));
  const height = Math.max(FS_CHAT_MIN_H, Math.min(saved.height, maxH));

  panel.style.width = width + 'px';
  panel.style.height = height + 'px';
}


// --- Fullscreen chat modal drag & position ---
function makeFsChatPanelDraggable() {
  const panel = document.getElementById('fsChatPanel');
  const handle = document.getElementById('fsChatHandle');
  const container = document.getElementById('playerWrap');
  if (!panel || !handle || !container) return;

  const STORAGE_KEY = 'pw-pos:fsChatPanel:fullscreen';

  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
  }

  /** позиция рядом с кнопкой чата (если localStorage пустой) */
  function positionNearChatBtn() {
    const btn = document.getElementById('fsChatToggleBtn');
    const parentRect = container.getBoundingClientRect();
    const panelW = panel.offsetWidth || 320;
    const panelH = panel.offsetHeight || 400;

    let left = 16;
    let top = 60;

    if (btn) {
      const btnRect = btn.getBoundingClientRect();
      // под кнопкой, чуть левее/правее чтобы не уезжало
      left = btnRect.left - parentRect.left;
      top = btnRect.bottom - parentRect.top + 8;

      // если не влезает снизу — ставим над кнопкой
      if (top + panelH > parentRect.height - 8) {
        top = btnRect.top - parentRect.top - panelH - 8;
      }
      // если не влезает справа — прижимаем вправо
      if (left + panelW > parentRect.width - 8) {
        left = parentRect.width - panelW - 8;
      }
    }

    left = clamp(left, 8, Math.max(8, parentRect.width - panelW - 8));
    top = clamp(top, 8, Math.max(8, parentRect.height - panelH - 8));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function applySavedPosition() {
    // панель скрыта — размеры нулевые, позицию поставит toggleFsChat при показе
    if (panel.classList.contains('hidden')) return;

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}

    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      positionNearChatBtn();
      return;
    }

    const p = container.getBoundingClientRect();
    const left = clamp(saved.left, 0, Math.max(0, p.width - panel.offsetWidth));
    const top = clamp(saved.top, 0, Math.max(0, p.height - panel.offsetHeight));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function savePosition(left, top) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#fsChatClose') || e.target.closest('#fsSettingsBtn')) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const parentRect = container.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;

    dragging = true;
    panel.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();

    const parentRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    let newLeft = origLeft + (e.clientX - startX);
    let newTop = origTop + (e.clientY - startY);

    // жёстко внутри границ
    newLeft = clamp(newLeft, 0, parentRect.width - panelRect.width);
    newTop = clamp(newTop, 0, parentRect.height - panelRect.height);

    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch {}

    const left = parseFloat(panel.style.left) || 0;
    const top = parseFloat(panel.style.top) || 0;
    savePosition(left, top);
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // при смене фуллскрина / ресайзе — поджимаем в границы
  const repositionIfFs = () => {
    if (isDocFullscreen()) {
      requestAnimationFrame(() => {
        applyFsChatPanelSize();
        applySavedPosition();
      });
    }
  };
  document.addEventListener('fullscreenchange', repositionIfFs);
  document.addEventListener('webkitfullscreenchange', repositionIfFs);

  window.addEventListener('resize', () => {
    if (isDocFullscreen() && !panel.classList.contains('hidden')) {
      applyFsChatPanelSize();
      applySavedPosition();
    }
  });

  // --- ресайз панели за угол ---
  const resizeHandleEl = document.getElementById('fsChatResizeHandle');
  let resizing = false;
  let startXR = 0, startYR = 0, startW = 0, startH = 0;

  resizeHandleEl?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    startXR = e.clientX;
    startYR = e.clientY;
    resizing = true;
    panel.classList.add('resizing');
    try { resizeHandleEl.setPointerCapture(e.pointerId); } catch {}
  });

  resizeHandleEl?.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    e.preventDefault();

    const parentRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const leftOffset = panelRect.left - parentRect.left;
    const topOffset = panelRect.top - parentRect.top;

    const maxW = Math.max(FS_CHAT_MIN_W, parentRect.width - leftOffset - 8);
    const maxH = Math.max(FS_CHAT_MIN_H, parentRect.height - topOffset - 8);

    let newW = startW + (e.clientX - startXR);
    let newH = startH + (e.clientY - startYR);

    newW = Math.max(FS_CHAT_MIN_W, Math.min(newW, maxW));
    newH = Math.max(FS_CHAT_MIN_H, Math.min(newH, maxH));

    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
  });

  function endResize(e) {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
    try { resizeHandleEl.releasePointerCapture(e.pointerId); } catch {}

    const rect = panel.getBoundingClientRect();
    saveFsChatSize(rect.width, rect.height);
  }

  resizeHandleEl?.addEventListener('pointerup', endResize);
  resizeHandleEl?.addEventListener('pointercancel', endResize);

  applyFsChatPanelSize();
  applySavedPosition();
}

function toggleFsChat() {
  const panel = document.getElementById('fsChatPanel');
  if (!panel) {
    console.warn('[fsChat] panel not found');
    return;
  }

  const willShow = panel.classList.contains('hidden');
  console.log('[fsChat] toggle', { willShow, wasHidden: willShow, inFs: isDocFullscreen() });
  panel.classList.toggle('hidden');

  if (willShow) {
    // после показа размеры уже известны — сначала применяем сохранённый размер, потом позицию
    requestAnimationFrame(() => {
      applyFsChatPanelSize();
      const saved = JSON.parse(localStorage.getItem('pw-pos:fsChatPanel:fullscreen') || 'null');
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        const container = document.getElementById('playerWrap');
        const parentRect = container.getBoundingClientRect();
        const panelW = panel.offsetWidth;
        const panelH = panel.offsetHeight;
        const left = Math.max(0, Math.min(saved.left, parentRect.width - panelW));
        const top = Math.max(0, Math.min(saved.top, parentRect.height - panelH));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      } else {
        // пустой localStorage → рядом с кнопкой чата
        const btn = document.getElementById('fsChatToggleBtn');
        const container = document.getElementById('playerWrap');
        if (btn && container) {
          const parentRect = container.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          const panelW = panel.offsetWidth;
          const panelH = panel.offsetHeight;

          let left = btnRect.left - parentRect.left;
          let top = btnRect.bottom - parentRect.top + 8;

          if (top + panelH > parentRect.height - 8) {
            top = btnRect.top - parentRect.top - panelH - 8;
          }
          if (left + panelW > parentRect.width - 8) {
            left = parentRect.width - panelW - 8;
          }
          left = Math.max(8, left);
          top = Math.max(8, top);

          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        }
      }

      const msgs = document.getElementById('fsMessages');
      if (msgs) msgs.scrollTop = 1e9;
    });
  }
}

function closeFsChat() {
  document.getElementById('fsChatPanel')?.classList.add('hidden');
}

try { makeFsChatPanelDraggable(); } catch (e) { console.error('[fsChatPanel]', e); }

document.getElementById('voiceCallConfirmBtn')?.addEventListener('click', startVoiceCall);
document.getElementById('voiceCallCancelBtn')?.addEventListener('click', closeVoiceConfirmModal);
document.getElementById('voiceHangupBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  leaveVoiceCall();
});
document.getElementById('voiceCallJoinArea')?.addEventListener('click', () => {
  if (!inVoiceCall) startVoiceCall();
});

// крестик
document.getElementById('fsChatClose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFsChat();
});

// шестерёнка + участники внутри fullscreen-чата
document.getElementById('fsSettingsBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFsParticipants();
});
document.getElementById('fsParticipantsClose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFsParticipants();
});
document.getElementById('fsBannedListBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  showFsBannedView();
});
document.getElementById('fsBannedBackBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  hideFsBannedView();
});

try {
  makeDraggable(document.getElementById('fullscreenBtn'), 'fullscreenBtn');
  makeDraggable(document.getElementById('fsChatToggleBtn'), 'fsChatToggleBtn');
  makeDraggable(document.getElementById('ccBtn'), 'ccBtn');
  makeDraggable(document.getElementById('volumeBtn'), 'volumeBtn');
} catch (e) { console.error('[makeDraggable]', e); }

init();