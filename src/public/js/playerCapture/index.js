// index.js (playerCapture)

import { createIframePlayer } from './iframeManager.js';
import { detectMeta } from './detector.js';
import { showEpisodeControls, hideEpisodeControls } from './controls.js';

export async function renderPlayerCapture(video, { isOwner, container }) {
  container.innerHTML = `
    <div style="
      display:flex;
      align-items:center;
      justify-content:center;
      height:100%;
      color:#fff;
      background:#111;
      flex-direction:column;
      gap:12px;
    ">
      <div style="font-size:32px;">⏳</div>
      <div>Ищем видеопоток...</div>
    </div>
  `;

  let meta = video.meta || {};
  let streams = [];

try {
    const res = await fetch('/api/player-capture/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
      url: video.url,
      episode: video.meta?.currentEpisode || null,
      roomCode: window.code,
      onlyCache: !isOwner, // зритель — только кэш
    }),
    });

    const data = await res.json();
    console.log('[playerCapture] extract result:', data); // ← смотри это в консоли браузера

    if (data.success) {
      if (isOwner && window.socket && window.code && data.streams?.length) {
        window.socket.emit('player_capture:streams', {
          code: window.code,
          season: data.meta?.currentSeason || 1,
          episode: data.meta?.currentEpisode || 1,
          voice: data.meta?.currentVoice || null,
          streams: data.streams,
          playerIframes: data.playerIframes || [],
          meta: data.meta,
        });
      }
      if (data.streams?.length) {
        return renderNativePlayer(data.streams[0], data.meta || meta, { isOwner, container, videoUrl: video.url });
        }
        if (data.playerIframes?.length) {
        return renderPlayerIframe(data.playerIframes[0], data.meta || meta, { isOwner, container, videoUrl: video.url });
        }
    }

    // Показываем реальную ошибку с сервера
      return renderFallback(video.url, data.meta || meta, { 
        isOwner, 
        container,
        errorMessage: data.error || data.message || 'Не удалось найти плеер',
        videoUrl: video.url,
    });

    } catch (e) {
    console.error('[playerCapture] fetch error', e);
      return renderFallback(video.url, meta, { 
        isOwner, 
        container,
        errorMessage: e.message,
        videoUrl: video.url,
    });
  }
}

function renderPlayerIframe(playerUrl, meta, { isOwner, container }) {
  container.innerHTML = '';
  
  const iframe = document.createElement('iframe');
  iframe.src = playerUrl;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.referrerPolicy = 'no-referrer';
  container.appendChild(iframe);

    const hasMultipleEpisodes = (meta.seasons?.length > 1) || (meta.totalEpisodes > 1);
    if (isOwner && (hasMultipleEpisodes || meta.voices?.length)) {
        showEpisodeControls(meta);
    } else {
        hideEpisodeControls();
    }

  return {
    type: 'player_capture',
    iframe,
    meta,
    getCurrentPosition: () => 0,
    getIsPlayingNow: () => false,
    doPlayPause: () => {},
    seekTo: () => {},
  };
}

function renderNativePlayer(stream, meta, { isOwner, container, videoUrl }) {
  container.innerHTML = '';
  const videoEl = document.createElement('video');
  videoEl.id = 'captureVideo';
  videoEl.src = `/api/stream/relay?url=${encodeURIComponent(stream.url)}`;
  videoEl.controls = isOwner;
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.volume = 0.3;
    container.appendChild(videoEl);

  if (isOwner) {
    videoEl.addEventListener('play', () => {
      if (window.socket && window.code) {
        window.socket.emit('playback:update', {
          code: window.code,
          isPlaying: true,
          positionSeconds: videoEl.currentTime || 0,
        });
      }
    });
    videoEl.addEventListener('pause', () => {
      if (window.socket && window.code) {
        window.socket.emit('playback:update', {
          code: window.code,
          isPlaying: false,
          positionSeconds: videoEl.currentTime || 0,
        });
      }
    });
  }


  // перезагрузка видео при смене серии: заново дёргаем /extract с новым episode
  const reloadWithEpisode = async (episode, playerLabel) => {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;background:#111;">
        <div>⏳ Загружаем${playerLabel ? ` «${playerLabel}»` : ` серию ${episode}`}...</div>
      </div>
    `;

    const res = await fetch('/api/player-capture/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          url: videoUrl,
          episode,
          player: playerLabel || null,
          roomCode: window.code,
        }),
    });
    const data = await res.json();

    if (data.success && data.streams?.length) {
      if (isOwner && window.socket && window.code) {
        window.socket.emit('player_capture:streams', {
          code: window.code,
          season: data.meta?.currentSeason || 1,
          episode,
          voice: data.meta?.currentVoice || null,
          streams: data.streams,
          playerIframes: data.playerIframes || [],
          meta: data.meta,
        });
      }
      const player = renderNativePlayer(data.streams[0], data.meta || meta, { isOwner, container, videoUrl });
      // важно: room.js должен знать новый videoEl
      if (typeof window.__onCapturePlayerReload === 'function') {
        window.__onCapturePlayerReload(player);
      }
      return player;
    } else if (data.success && data.playerIframes?.length) {
      const player = renderPlayerIframe(data.playerIframes[0], data.meta || meta, { isOwner, container });
      if (typeof window.__onCapturePlayerReload === 'function') {
        window.__onCapturePlayerReload(player);
      }
      return player;
    } else {
      renderFallback(videoUrl, data.meta || meta, {
        isOwner,
        container,
        errorMessage: data.error || 'Не удалось загрузить серию',
        videoUrl,
      });
    }
  };

  if (isOwner && (meta.seasons?.length > 1 || meta.totalEpisodes > 1 || meta.voices?.length || (meta.players && meta.players.length > 1))) {
    showEpisodeControls(meta, reloadWithEpisode);
  } else {
    hideEpisodeControls();
  }

  return {
    type: 'player_capture',
    videoEl,
    meta,
    getCurrentPosition: () => videoEl.currentTime || 0,
    getIsPlayingNow: () => !videoEl.paused,
    doPlayPause: (play) => play ? videoEl.play().catch(() => {}) : videoEl.pause(),
    seekTo: (sec) => { videoEl.currentTime = sec; },
  };
}

export function renderFromStreams(streams, meta, { isOwner, container, videoUrl }) {
  if (!streams?.length) {
    return renderFallback(videoUrl || '', meta || {}, {
      isOwner,
      container,
      errorMessage: 'Нет потоков',
      videoUrl,
    });
  }
  return renderNativePlayer(streams[0], meta || {}, { isOwner, container, videoUrl });
}

function renderFallback(url, meta, { isOwner, container, errorMessage, videoUrl }) {
  container.innerHTML = `
    <div style="
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      height:100%;
      color:#fff;
      text-align:center;
      padding:24px;
      background:#111;
    ">
      <div style="font-size:48px; margin-bottom:16px;">🎬</div>
      <h3 style="margin:0 0 8px;">Не удалось встроить плеер</h3>
      <p style="opacity:0.7; margin:0 0 12px; max-width:420px; line-height:1.5;">
        ${errorMessage || 'Сайт использует сильную защиту'}
      </p>
      <p style="opacity:0.5; font-size:13px; max-width:420px;">
        Если есть выбор плеера (например «4К Качество») — переключи его справа<br>
        и подожди повторной загрузки.
      </p>
    </div>
  `;

  const hasPlayers = meta.players && meta.players.length > 1;
  const hasMultipleEpisodes = (meta.seasons?.length > 1) || (meta.totalEpisodes > 1);

  if (isOwner && (hasMultipleEpisodes || meta.voices?.length || hasPlayers)) {
    const reloadWithEpisode = async (episode, playerLabel) => {
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;background:#111;">
          <div>⏳ Загружаем${playerLabel ? ` «${playerLabel}»` : ` серию ${episode}`}...</div>
        </div>
      `;

      const res = await fetch('/api/player-capture/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          url: videoUrl || url,
          episode,
          player: playerLabel || null,
          roomCode: window.code,
        }),
      });
      const data = await res.json();

      if (data.success && data.streams?.length) {
        if (isOwner && window.socket && window.code) {
          window.socket.emit('player_capture:streams', {
            code: window.code,
            season: data.meta?.currentSeason || 1,
            episode,
            voice: data.meta?.currentVoice || null,
            streams: data.streams,
            playerIframes: data.playerIframes || [],
            meta: data.meta,
          });
        }
        const player = renderNativePlayer(data.streams[0], data.meta || meta, {
          isOwner,
          container,
          videoUrl: videoUrl || url,
        });
        if (typeof window.__onCapturePlayerReload === 'function') {
          window.__onCapturePlayerReload(player);
        }
        return player;
      } else if (data.success && data.playerIframes?.length) {
        const player = renderPlayerIframe(data.playerIframes[0], data.meta || meta, {
          isOwner,
          container,
        });
        if (typeof window.__onCapturePlayerReload === 'function') {
          window.__onCapturePlayerReload(player);
        }
        return player;
      } else {
        renderFallback(videoUrl || url, data.meta || meta, {
          isOwner,
          container,
          errorMessage: data.error || data.message || 'Не удалось загрузить',
          videoUrl: videoUrl || url,
        });
      }
    };

    showEpisodeControls(meta, reloadWithEpisode);
  } else {
    hideEpisodeControls();
  }

  return {
    type: 'player_capture',
    meta,
    getCurrentPosition: () => 0,
    getIsPlayingNow: () => false,
    doPlayPause: () => {},
    seekTo: () => {},
  };
}