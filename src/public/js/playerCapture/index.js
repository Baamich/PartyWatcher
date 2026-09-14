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
    return renderFallback(video.url, meta, { 
        isOwner, 
        container,
        errorMessage: data.error || data.message || 'Не удалось найти плеер'
    });

    } catch (e) {
    console.error('[playerCapture] fetch error', e);
    return renderFallback(video.url, meta, { 
        isOwner, 
        container,
        errorMessage: e.message 
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

  // перезагрузка видео при смене серии: заново дёргаем /extract с новым episode
const reloadWithEpisode = async (episode) => {
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;background:#111;">
        <div>⏳ Загружаем серию ${episode}...</div>
      </div>
    `;

    const res = await fetch('/api/player-capture/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: videoUrl, episode, roomCode: window.code }),
    });
    const data = await res.json();

    if (data.success && data.streams?.length) {
      // хост отдаёт готовый поток всем зрителям — без их extract
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
      renderNativePlayer(data.streams[0], data.meta || meta, { isOwner, container, videoUrl });
    } else if (data.success && data.playerIframes?.length) {
      renderPlayerIframe(data.playerIframes[0], data.meta || meta, { isOwner, container });
    } else {
      renderFallback(videoUrl, meta, { isOwner, container, errorMessage: data.error || 'Не удалось загрузить серию' });
    }
  };

  if (isOwner && (meta.seasons?.length > 1 || meta.totalEpisodes > 1 || meta.voices?.length)) {
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

function renderFallback(url, meta, { isOwner, container, errorMessage }) {
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
        Открой консоль браузера (F12) → вкладка Network → запрос /extract<br>
        и посмотри, что именно вернул сервер.
      </p>
    </div>
  `;

    const hasMultipleEpisodes = (meta.seasons?.length > 1) || (meta.totalEpisodes > 1);
    if (isOwner && (hasMultipleEpisodes || meta.voices?.length)) {
        showEpisodeControls(meta);
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