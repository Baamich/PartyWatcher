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

const DRIFT_THRESHOLD_SECONDS = 3; // совпадает с текстом системной подсказки для зрителей

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
    const container = document.getElementById('player');
    container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls' : ''} src="${url}"></video>`;
    videoEl = document.getElementById('videoEl');
    videoEl.volume = 0.3;
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

  async function handleYoutubeError(errorCode) {
    if (![100, 101, 150].includes(errorCode)) return;

    if (!isOwner) {
      setOverlay('Видео заблокировано YouTube — жду, пока хост подтвердит возраст 18+', false);
      return;
    }

    const confirmed = await askAgeGate();
    if (!confirmed) {
      setOverlay('Без подтверждения возраста это видео недоступно', false);
      return;
    }

    setOverlay('Получаю поток через yt-dlp...', false);
    try {
      const data = await api('/youtube-capture/age-restricted-extract', {
        method: 'POST',
        body: { code }, // теперь это глобальный код комнаты, не код ошибки
      });
      renderDirectVideoUrl(data.url);
      socket.emit('youtube:age-restricted-stream', { code, url: data.url });
      setOverlay('Готово к просмотру', true);
    } catch (err) {
      setOverlay('Не удалось получить видео: ' + (err.message || ''), false);
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
      container.innerHTML = `<video id="videoEl" ${isOwner ? 'controls' : ''} src="${video.url}"></video>`;
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
            e.target.setVolume(30);
            e.target.unloadModule('captions'); // жёстко гасит субтитры, даже если в аккаунте зрителя стоит "всегда показывать"
            resolve();
          },
          onStateChange: (e) => {
            if (suppressEvents) return;
            if (!isOwner) return;
            if (e.data === YT.PlayerState.PLAYING) emitPlayback(true);
            else if (e.data === YT.PlayerState.PAUSED) emitPlayback(false);
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
  socket.emit('playback:update', { code, isPlaying, positionSeconds: getCurrentPosition() });
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
      if (v && !v.dataset.captureBoundBound) {
        v.dataset.captureBound = '1';
        v.addEventListener('play', () => emitPlayback(true));
        v.addEventListener('pause', () => emitPlayback(false));
        v.addEventListener('seeked', () => emitPlayback(!v.paused));
      }
    } else if (videoEl) {
      videoEl.play().catch(() => {});
    }
    startHeartbeat();
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

function toggleFullscreen() {
  const wrap = document.getElementById('playerWrap');
  if (!document.fullscreenElement) wrap.requestFullscreen?.();
  else document.exitFullscreen?.();
}

let fsControlsTimer = null;

function showFsControls() {
  const wrap = document.getElementById('playerWrap');
  if (!wrap) return;
  wrap.classList.remove('fs-controls-hidden');

  clearTimeout(fsControlsTimer);
  if (!document.fullscreenElement) return;

  fsControlsTimer = setTimeout(() => {
    if (document.fullscreenElement) {
      wrap.classList.add('fs-controls-hidden');
    }
  }, 3000);
}

function onFullscreenChange() {
  const inFullscreen = !!document.fullscreenElement;
  const chatBtn = document.getElementById('fsChatToggleBtn');
  if (chatBtn) chatBtn.classList.toggle('hidden', !inFullscreen);

  document.getElementById('playerWrap')?.classList.toggle('in-fullscreen', inFullscreen);

  if (!inFullscreen) {
    document.getElementById('fsChatPanel')?.classList.add('hidden');
    document.getElementById('playerWrap')?.classList.remove('fs-controls-hidden');
    clearTimeout(fsControlsTimer);
  } else {
    showFsControls();
  }
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
  document.getElementById('roomCodeValue').onclick = () => copyText(code, 'Код');
  setOverlay('Загрузка комнаты...', false);

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
    lastState = playback;
    window.__captureVideoUrl = video?.url || window.__captureVideoUrl || null;

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

function formatMessageHTML(username, text) {
  const isSystem = username === 'Система';
  const nameHTML = isSystem
    ? `<span style="color:var(--danger); font-weight:600;">Система</span>`
    : `<b>${escapeHTML(username)}</b>`;
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

function makeDraggable(el, storageKey) {
  const container = document.getElementById('playerWrap');
  const LONG_PRESS_MS = 300;
  const MOVE_CANCEL_THRESHOLD = 6;

  let longPressTimer = null;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function currentMode() {
    return document.fullscreenElement ? 'fullscreen' : 'normal';
  }

  function storageFullKey() {
    return `pw-pos:${storageKey}:${currentMode()}`;
  }

  function applySavedPosition() {
    const saved = JSON.parse(localStorage.getItem(storageFullKey()) || 'null');
    if (saved) {
      el.style.left = saved.left + 'px';
      el.style.top = saved.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    } else {
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      el.style.bottom = '';
    }
  }

  function savePosition(left, top) {
    localStorage.setItem(storageFullKey(), JSON.stringify({ left, top }));
  }

  el.addEventListener('pointerdown', (e) => {
    moved = false;
    const rect = el.getBoundingClientRect();
    const parentRect = container.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;

    longPressTimer = setTimeout(() => {
      dragging = true;
      el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch {}
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

  document.addEventListener('fullscreenchange', applySavedPosition);
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
    // показываем только если селекты уже заполнены (есть опции)
    if (hostControls) {
      const hasOptions =
        document.querySelectorAll('#seasonSelect option').length > 0 ||
        document.querySelectorAll('#playerSelect option').length > 0;
      if (hasOptions) {
        hostControls.classList.remove('hidden');
      }
    }
  }
}

function initViewMode() {
  // Зрители всегда в чате, хост тоже по умолчанию в чате
  setViewMode('chat');
}

let subtitlesOn = false;

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

function toggleSubtitles() {
  subtitlesOn = !subtitlesOn;

  if (currentVideoType === 'youtube' && ytPlayer) {
    try {
      if (subtitlesOn) {
        ytPlayer.loadModule('captions');
        ytPlayer.setOption('captions', 'track', { languageCode: 'ru' });
      } else {
        ytPlayer.unloadModule('captions');
      }
    } catch (_) {}
    refreshCcButton();
    return;
  }

  const v = getActiveVideoEl();
  if (!v?.textTracks) {
    subtitlesOn = false;
    refreshCcButton();
    return;
  }

  for (let i = 0; i < v.textTracks.length; i++) {
    v.textTracks[i].mode = subtitlesOn ? 'showing' : 'hidden';
  }
  refreshCcButton();
}

window.toggleSubtitles = toggleSubtitles;


const playerWrapEl = document.getElementById('playerWrap');

playerWrapEl?.addEventListener('pointerdown', () => {
  playerFocused = true;
  if (document.fullscreenElement) showFsControls();
}, true); // capture — ловим до того, как событие съест внутренний элемент

playerWrapEl?.addEventListener('mousemove', () => {
  if (document.fullscreenElement) showFsControls();
});

// сам перехватчик: единственный способ поймать тап поверх iframe
const catcherEl = document.getElementById('fsActivityCatcher');
catcherEl?.addEventListener('pointerdown', (e) => {
  playerFocused = true;
  e.stopPropagation();
  e.preventDefault(); // первый тап только показывает кнопки, в плеер не проваливается
  showFsControls();
});
catcherEl?.addEventListener('pointermove', () => showFsControls());

// клавиши в фулскрине (пробел/стрелки) тоже "будят" кнопки
document.addEventListener('keydown', () => {
  if (document.fullscreenElement) showFsControls();
}, true);

// клик внутрь iframe (YouTube/Twitch) отбирает фокус у окна — используем это как сигнал активности
window.addEventListener('blur', () => {
  if (document.fullscreenElement) showFsControls();
});
document.getElementById('chat')?.addEventListener('pointerdown', () => {
  playerFocused = false;
});

function leaveRoom() {
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
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


// Делаем функции доступными из HTML
window.setViewMode = setViewMode;
window.closeModal = closeModal;

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
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const parentRect = container.getBoundingClientRect();
    const panelW = panel.offsetWidth || 320;
    const panelH = panel.offsetHeight || 400;

    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      const left = clamp(saved.left, 8, Math.max(8, parentRect.width - panelW - 8));
      const top = clamp(saved.top, 8, Math.max(8, parentRect.height - panelH - 8));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    } else {
      positionNearChatBtn();
    }
  }

  function savePosition(left, top) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#fsChatClose')) return;

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
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      // даём браузеру отрисовать размеры, потом позиционируем
      requestAnimationFrame(() => applySavedPosition());
    }
  });

  window.addEventListener('resize', () => {
    if (document.fullscreenElement && !panel.classList.contains('hidden')) {
      applySavedPosition();
    }
  });

  applySavedPosition();
}

function toggleFsChat() {
  const panel = document.getElementById('fsChatPanel');
  if (!panel) return;

  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');

  if (willShow) {
    // после показа размеры уже известны — ставим позицию
    requestAnimationFrame(() => {
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

makeFsChatPanelDraggable();

// крестик
document.getElementById('fsChatClose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFsChat();
});

makeDraggable(document.getElementById('fullscreenBtn'), 'fullscreenBtn');
makeDraggable(document.getElementById('fsChatToggleBtn'), 'fsChatToggleBtn');
makeDraggable(document.getElementById('ccBtn'), 'ccBtn');

init();