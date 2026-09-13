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
        body: JSON.stringify({ url: video.url, episode: video.meta?.currentEpisode || null }),
    });

    const data = await res.json();
    console.log('[playerCapture] extract result:', data); // ← смотри это в консоли браузера

    if (data.success) {
        if (data.streams?.length) {
        return renderNativePlayer(data.streams[0], data.meta || meta, { isOwner, container });
        }
        if (data.playerIframes?.length) {
        return renderPlayerIframe(data.playerIframes[0], data.meta || meta, { isOwner, container });
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

function renderNativePlayer(stream, meta, { isOwner, container }) {
  container.innerHTML = '';
  const videoEl = document.createElement('video');
  videoEl.id = 'captureVideo';
  videoEl.src = stream.url;
  videoEl.controls = isOwner;
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.volume = 0.3;
  container.appendChild(videoEl);

    const hasMultipleEpisodes = (meta.seasons?.length > 1) || (meta.totalEpisodes > 1);
    if (isOwner && (hasMultipleEpisodes || meta.voices?.length)) {
        showEpisodeControls(meta);
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