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
    // Пробуем достать прямые потоки с сервера
    const res = await fetch('/api/player-capture/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url: video.url }),
    });
    const data = await res.json();

    if (data.success && data.streams?.length) {
      streams = data.streams;
      if (data.meta) meta = { ...meta, ...data.meta };
    }
  } catch (e) {
    console.warn('[playerCapture] extract failed', e);
  }

  // Если нашли поток — играем через <video>
  if (streams.length > 0) {
    return renderNativePlayer(streams[0], meta, { isOwner, container });
  }

  // Иначе — fallback (заглушка + возможность открыть в новой вкладке)
  return renderFallback(video.url, meta, { isOwner, container });
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

  if (isOwner && (meta.seasons?.length || meta.voices?.length)) {
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

function renderFallback(url, meta, { isOwner, container }) {
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
      <h3 style="margin:0 0 8px;">Прямой поток не найден</h3>
      <p style="opacity:0.7; margin:0 0 20px; max-width:420px; line-height:1.5;">
        Сайт сильно защищён или использует динамическую загрузку плеера.<br>
        Пока можно открыть страницу в новой вкладке.
      </p>
      <a href="${url}" target="_blank" rel="noopener" style="
        padding:12px 24px;
        background:#7c3aed;
        color:#fff;
        border-radius:8px;
        text-decoration:none;
        font-weight:500;
      ">Открыть в новой вкладке</a>
    </div>
  `;

  if (isOwner && (meta.seasons?.length || meta.voices?.length)) {
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