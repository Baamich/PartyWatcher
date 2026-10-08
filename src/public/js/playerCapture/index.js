// index.js (playerCapture)

import { showEpisodeControls, hideEpisodeControls } from './controls.js';

const HLS_CONFIG = {
  enableWorker: true,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferHole: 0.5, // небольшие «дырки» в буфере (разрывы таймкодов у CDN) перепрыгиваем, а не зависаем
  nudgeMaxRetry: 6,   // сколько раз подтолкнуть воспроизведение, прежде чем считать это ошибкой
  nudgeOffset: 0.1,
  fragLoadingMaxRetry: 6,      // relay иногда медленно перебирает referer — даём сегменту больше попыток
  manifestLoadingMaxRetry: 3,
};

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showLoading(container, text) {
  container.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;background:#111;flex-direction:column;gap:12px;">' +
    '<div style="font-size:32px;">⏳</div><div class="pc-loading-text"></div></div>';
  container.querySelector('.pc-loading-text').textContent = text; // только как текст
}

function parseStreamExpiry(url) {
  const m = url.match(/:(\d{10}):/);
  if (!m) return null;
  const raw = m[1]; // ГГГГММДДЧЧ
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const date = new Date(year, month - 1, day, hour);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Выбрать поток: 720p → 1080p → лучшее из оставшихся */
function pickBestStream(streams) {
  if (!streams?.length) return null;
  const clean = streams.filter((s) => {
    const u = (s.url || '').toLowerCase();
    return s.url && !u.includes('.svg') && !u.includes('prem-icon') && !u.includes('/images/');
  });
  if (!clean.length) return streams[0];

  const byQ = (q) => clean.find((s) => String(s.quality || '').startsWith(String(q)));
  return byQ(720) || byQ(1080) || byQ(480) || byQ(360) || clean[0];
}

async function requestExtract(body) {
  const res = await fetch('/api/player-capture/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ roomCode: window.code, ...body }),
  });
  return res.json();
}

// хост раздаёт найденные потоки зрителям (сервер сам решает, сбрасывать ли позицию)
function emitStreams(data, season, episode) {
  if (!window.socket || !window.code || !data?.streams?.length) return;
  window.socket.emit('player_capture:streams', {
    code: window.code,
    season: season || data.meta?.currentSeason || 1,
    episode: episode || data.meta?.currentEpisode || 1,
    voice: data.meta?.currentVoice || null,
    streams: data.streams,
    playerIframes: data.playerIframes || [],
    meta: data.meta,
  });
}

// Один общий обработчик «сменить серию / плеер» для всех видов плеера (раньше было три копии)
function makeReloader(ctx) {
  const { container, videoUrl, isOwner } = ctx;
  return async (episode, playerLabel, season) => {
    try { ctx.current?.destroy?.(); } catch (_) {}
    showLoading(container, `Загружаем${playerLabel ? ` «${playerLabel}»` : ` серию ${episode}`}...`);

    let data;
    try {
      data = await requestExtract({ url: videoUrl, episode, season: season || null, player: playerLabel || null });
    } catch (e) {
      data = { success: false, error: e.message };
    }
    const meta = { ...(ctx.meta || {}), ...(data.meta || {}) };

    let player;
    if (data.success && data.streams?.length) {
      if (isOwner) emitStreams(data, season, episode);
      const best = pickBestStream(data.streams);
      player = renderNativePlayer(best, { ...meta, currentQuality: best?.quality || null }, {
        isOwner, container, videoUrl, allStreams: data.streams,
      });
    } else if (data.success && data.playerIframes?.length) {
      player = renderPlayerIframe(data.playerIframes[0], meta, { isOwner, container, videoUrl });
    } else {
      player = renderFallback(videoUrl, meta, {
        isOwner, container, videoUrl, errorMessage: data.error || data.message || 'Не удалось загрузить',
      });
    }
    if (typeof window.__onCapturePlayerReload === 'function') window.__onCapturePlayerReload(player);
    return player;
  };
}

function setupControls(meta, ctx, streamsList, switchQuality) {
  const hasControls =
    ctx.isOwner &&
    (meta.seasons?.length > 1 ||
      meta.totalEpisodes > 1 ||
      meta.voices?.length ||
      (meta.players && meta.players.length > 1) ||
      (streamsList || []).filter((s) => s.quality).length > 1);

  if (hasControls) showEpisodeControls(meta, makeReloader(ctx), streamsList, switchQuality);
  else hideEpisodeControls();
}

export async function renderPlayerCapture(video, { isOwner, container }) {
  showLoading(container, 'Ищем видеопоток...');

  const meta = video.meta || {};
  const season = meta.currentSeason || null;
  const episode = meta.currentEpisode || null;

  try {
    let data = await requestExtract({
      url: video.url,
      season,
      episode,
      onlyCache: !isOwner, // зритель — только кэш
    });
    console.log('[playerCapture] extract result:', data);

    // Универсальный перебор плееров: если у текущего нет streams —
    // пробуем остальные из meta.players по очереди.
    if (isOwner && data.meta?.players?.length > 1 && !data.streams?.length) {
      const tried = new Set();
      const first = data.meta.currentPlayer || data.meta.players[0];
      if (first) tried.add(first);

      for (const label of data.meta.players) {
        if (tried.has(label)) continue;
        tried.add(label);

        console.log('[playerCapture] нет streams, пробую плеер:', label);
        showLoading(container, `Пробуем плеер «${label}»...`);

        const next = await requestExtract({ url: video.url, season, episode, player: label });
        console.log('[playerCapture] extract result (player:', label, '):', next);

        if (next.success && next.streams?.length) {
          data = next;
          break;
        }
        // сохраняем последний ответ с players, даже если streams пусто
        if (next.meta?.players?.length) data = next;
      }
    }

    const m = { ...meta, ...(data.meta || {}) };
    if (data.success && data.streams?.length) {
      if (isOwner) emitStreams(data, season, episode);
      const best = pickBestStream(data.streams);
      return renderNativePlayer(best, { ...m, currentQuality: best?.quality || null }, {
        isOwner,
        container,
        videoUrl: video.url,
        allStreams: data.streams,
      });
    }
    if (data.success && data.playerIframes?.length) {
      return renderPlayerIframe(data.playerIframes[0], m, { isOwner, container, videoUrl: video.url });
    }
    return renderFallback(video.url, m, {
      isOwner,
      container,
      errorMessage: data.error || data.message || 'Не удалось найти плеер',
      videoUrl: video.url,
    });
  } catch (e) {
    console.error('[playerCapture] fetch error', e);
    return renderFallback(video.url, meta, { isOwner, container, errorMessage: e.message, videoUrl: video.url });
  }
}

function renderPlayerIframe(playerUrl, meta, { isOwner, container, videoUrl }) {
  container.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.src = /^https?:\/\//i.test(playerUrl) ? playerUrl : 'about:blank'; // javascript: в iframe запрещаем
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.referrerPolicy = 'no-referrer';
  container.appendChild(iframe);

  const player = {
    type: 'player_capture',
    iframe,
    meta,
    getCurrentPosition: () => 0,
    getIsPlayingNow: () => false,
    doPlayPause: () => {},
    seekTo: () => {},
    destroy: () => {},
  };
  setupControls(meta, { isOwner, container, videoUrl, meta, current: player });
  return player;
}

// hls.js грузим с нашего же сервера (/vendor/hls.min.js — отдаётся из npm-пакета hls.js):
// быстрее, не зависит от CDN и проходит строгую CSP.
let hlsLoadPromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('Не удалось загрузить ' + src));
    };
    document.head.appendChild(s);
  });
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoadPromise) {
    hlsLoadPromise = loadScriptOnce('/vendor/hls.min.js')
      .then(() => window.Hls)
      .catch((e) => {
        hlsLoadPromise = null;
        throw e;
      });
  }
  return hlsLoadPromise;
}

function renderNativePlayer(stream, meta, { isOwner, container, videoUrl, allStreams }) {
  container.innerHTML = ''; // убираем заглушку «Ищем видеопоток...»
  const videoEl = document.createElement('video');
  videoEl.id = 'captureVideo';
  videoEl.controls = isOwner;
  videoEl.playsInline = true;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.volume = 0.3;
  container.appendChild(videoEl);

  videoEl.addEventListener('error', () => {
    console.error('[capture] video error', videoEl.error);
  });

  let destroyed = false;
  let currentStream = stream;
  const streamsList = allStreams || [stream];
  // по этому списку зритель понимает, что хост прислал тот же самый поток и пересобирать плеер не нужно
  if (meta) meta.__streamUrls = streamsList.map((s) => s.url);
  let hlsInstance = null;
  let blobUrl = null;
  let isRefreshingStream = false; // общий флаг — переживает пересоздание hlsInstance
  let mediaRecoverStep = 0;       // 0 — ещё не лечили, 1 — recoverMediaError, 2 — + swapAudioCodec
  let consecutiveNetworkErrors = 0; // CDN рвётся без чёткого 404/410 (CORS/timeout) несколько раз подряд — повод обновить поток

  // восстановить позицию и play после пересборки источника
  function resumeAt(pos, wasPlaying) {
    const go = () => {
      if (destroyed) return;
      if (pos > 0.5) {
        try { videoEl.currentTime = pos; } catch (_) {}
      }
      if (wasPlaying) videoEl.play().catch(() => {});
    };
    if (videoEl.readyState >= 1) go();
    else videoEl.addEventListener('loadedmetadata', go, { once: true });
  }

  function destroyHls() {
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (_) {}
      hlsInstance = null;
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  function relayUrl(streamToPlay) {
    const refQ = streamToPlay.referer ? `&referer=${encodeURIComponent(streamToPlay.referer)}` : '';
    return `/api/stream/relay?url=${encodeURIComponent(streamToPlay.url)}${refQ}`;
  }

  function toAbsolutePlaylist(streamToPlay) {
    const origin = window.location.origin;
    const refSuffix = streamToPlay.referer ? `&referer=${encodeURIComponent(streamToPlay.referer)}` : '';
    const addRef = (p) => (!refSuffix || p.includes('referer=') ? p : p + refSuffix);
    return streamToPlay.playlist
      .split('\n')
      .map((line) => {
        if (line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-KEY')) {
          return line.replace(/URI="(\/api\/stream\/relay\?url=[^"]+)"/, (_, p) => `URI="${origin}${addRef(p)}"`);
        }
        if (line.startsWith('/api/stream/relay?url=')) return origin + addRef(line);
        return line;
      })
      .join('\n');
  }

  // Новый экземпляр hls.js ВСЕГДА с обработчиком ошибок.
  // Раньше после первой фатальной ошибки создавался голый Hls без обработчика —
  // следующая ошибка уже ничем не лечилась, и у зрителя «замерзал» кадр.
  function createHls(Hls, streamToPlay) {
    destroyHls();
    const hls = new Hls(HLS_CONFIG);
    hlsInstance = hls;

    if (streamToPlay.playlist) {
      blobUrl = URL.createObjectURL(new Blob([toAbsolutePlaylist(streamToPlay)], { type: 'application/vnd.apple.mpegurl' }));
      hls.loadSource(blobUrl);
    } else {
      hls.loadSource(relayUrl(streamToPlay));
    }
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.FRAG_LOADED, () => { consecutiveNetworkErrors = 0; });
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (hls !== hlsInstance) return; // ошибка от уже заменённого экземпляра
      if (!data.fatal) {
        console.debug('[capture] hls (не фатально):', data.details);
        return;
      }
      console.error('[capture] hls fatal:', data.type, data.details, data.response?.code || '');

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        consecutiveNetworkErrors++;
        // протухшая подписанная ссылка (410/404) или CDN стабильно рвётся — нужен свежий extract
        const isDeadLink =
          data.response?.code === 410 || data.response?.code === 404 || consecutiveNetworkErrors >= 3;
        if (isDeadLink && isOwner && !isRefreshingStream) {
          console.warn('[capture] ссылка протухла (или CDN стабильно рвётся), запрашиваю свежий поток...');
          refreshExpiredStream();
          return;
        }
        // зритель свежую ссылку сам не добудет — пересобираем (не чаще раза в 5 с), пока хост не пришлёт новую
        if (consecutiveNetworkErrors >= 3 && !isOwner) {
          rebuildSource('сеть рвётся ' + consecutiveNetworkErrors + ' раза подряд');
          return;
        }
        // штатный способ hls.js: перезапустить загрузку, позиция и буфер сохраняются
        try { hls.startLoad(); return; } catch (_) {}
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoverStep < 2) {
        mediaRecoverStep++;
        console.warn('[capture] ошибка декодера, восстанавливаю (шаг', mediaRecoverStep, ')');
        try {
          if (mediaRecoverStep === 2) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        } catch (_) {}
      }

      rebuildSource('fatal ' + data.details);
    });
    return hls;
  }

  async function setupSource(streamToPlay) {
    mediaRecoverStep = 0;
    consecutiveNetworkErrors = 0;
    const isHls =
      streamToPlay.type === 'hls' ||
      /\.m3u8(\?|$)/i.test(streamToPlay.url) ||
      /cinemap\.cc|cinemar\.cc|cfnd\./i.test(streamToPlay.url);

    try {
      if (isHls) {
        const Hls = await loadHlsScript();
        if (destroyed) return;
        if (Hls.isSupported()) {
          createHls(Hls, streamToPlay);
          return;
        }
      }
      destroyHls();
      videoEl.src = relayUrl(streamToPlay); // mp4 или Safari с нативным HLS
    } catch (e) {
      console.error('[capture] setupSource failed', e);
      destroyHls();
      videoEl.src = relayUrl(streamToPlay);
    }
  }

  // полная пересборка плеера на том же потоке с сохранением позиции (дешевле, чем Puppeteer)
  let lastRebuildAt = 0;
  async function rebuildSource(reason) {
    if (destroyed || Date.now() - lastRebuildAt < 5000) return;
    lastRebuildAt = Date.now();
    const pos = videoEl.currentTime || 0;
    const wasPlaying = !videoEl.paused;
    console.warn('[capture] пересобираю плеер:', reason, '— позиция', Math.round(pos), 'с');
    await setupSource(currentStream);
    resumeAt(pos, wasPlaying);
  }

  setupSource(currentStream);

  let proactiveRefreshTimer = null;
  let refreshAttempts = 0;
  const MAX_REFRESH_ATTEMPTS = 3;
  const RETRY_BASE_DELAY_MS = 4000;

  function scheduleProactiveRefresh(streamUrl) {
    clearTimeout(proactiveRefreshTimer);
    if (!isOwner) return; // зрители получают новую ссылку от хоста через сокет, сами не дёргают extract

    const expiry = parseStreamExpiry(streamUrl);
    if (!expiry) return;

    // обновляем за 2 минуты до истечения — с запасом на сетевые задержки
    const delay = expiry.getTime() - 2 * 60 * 1000 - Date.now();
    if (delay <= 0) {
      refreshExpiredStream();
      return;
    }
    console.log('[capture] запланировано проактивное обновление потока через', Math.round(delay / 1000), 'сек');
    proactiveRefreshTimer = setTimeout(() => refreshExpiredStream(), delay);
  }

  scheduleProactiveRefresh(currentStream.url);

  // ---- сторож буферизации: видео «ждёт» дольше 15 с ----
  // Лечим по нарастающей: startLoad → перепрыгнуть дырку → пересборка → (хост) свежая ссылка.
  // Раньше у зрителя после первой попытки сторож просто выключался — и кадр висел навсегда.
  let stallTimer = null;
  let stallStep = 0;
  const STALL_TIMEOUT_MS = 15000;
  const MIN_REFRESH_INTERVAL_MS = 90 * 1000; // не поднимать Puppeteer заново чаще, чем раз в 90 сек
  let lastRefreshAt = 0;

  function onStall() {
    if (destroyed || videoEl.paused || videoEl.ended || isRefreshingStream) return;
    stallStep++;
    if (stallStep === 1 && hlsInstance) {
      console.warn('[capture] буферизация зависла — startLoad()');
      try { hlsInstance.startLoad(); } catch (_) {}
    } else if (stallStep <= 2) {
      console.warn('[capture] буферизация зависла — перепрыгиваю на 1 с вперёд');
      try { videoEl.currentTime = (videoEl.currentTime || 0) + 1; } catch (_) {}
    } else if (stallStep === 3 || !isOwner || Date.now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) {
      rebuildSource('буферизация > ' + STALL_TIMEOUT_MS / 1000 + ' с');
    } else {
      console.warn('[capture] видео всё ещё виснет — запрашиваю свежий поток');
      refreshExpiredStream();
      return;
    }
    armStallWatchdog();
  }

  function armStallWatchdog() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(onStall, STALL_TIMEOUT_MS);
  }

  function disarmStallWatchdog() {
    clearTimeout(stallTimer);
    stallStep = 0; // playback пошло — при следующем стопоре снова начинаем с дешёвых шагов
  }

  videoEl.addEventListener('waiting', armStallWatchdog);
  videoEl.addEventListener('playing', disarmStallWatchdog);
  videoEl.addEventListener('pause', disarmStallWatchdog);

  // ---- сторож «замёрзшего кадра»: время идёт (звук играет), а новых кадров нет ----
  // Бывает при сбое декодера после склейки сегментов; событий waiting/error при этом нет.
  let lastFrames = -1;
  let lastTime = 0;
  let frozenHits = 0;
  const frozenTimer = setInterval(() => {
    if (destroyed || videoEl.paused || videoEl.seeking || videoEl.readyState < 3) {
      lastFrames = -1;
      return;
    }
    // в фоновой вкладке браузер сам перестаёт декодировать видео — это не зависание
    // (и сбрасываем замер, иначе при возврате на вкладку сработали бы ложно)
    if (document.visibilityState !== 'visible' || !videoEl.getVideoPlaybackQuality || !videoEl.videoWidth) {
      lastFrames = -1;
      return;
    }
    const frames = videoEl.getVideoPlaybackQuality().totalVideoFrames;
    const t = videoEl.currentTime;
    if (lastFrames >= 0 && frames === lastFrames && t - lastTime > 1.5) {
      frozenHits++;
      console.warn('[capture] кадр замёрз (время идёт, кадров нет), попытка', frozenHits);
      if (frozenHits === 1 && hlsInstance) {
        try { hlsInstance.recoverMediaError(); } catch (_) {}
        resumeAt(t, true);
      } else {
        frozenHits = 0;
        rebuildSource('замёрзший кадр');
      }
    } else if (frames !== lastFrames) {
      frozenHits = 0;
    }
    lastFrames = frames;
    lastTime = t;
  }, 3000);

  async function refreshExpiredStream() {
    if (!isOwner || destroyed) return; // только хост ходит в extract, зритель получит обновление через socket
    if (isRefreshingStream) return;
    isRefreshingStream = true;
    lastRefreshAt = Date.now();
    clearTimeout(stallTimer);

    const wasPlaying = !videoEl.paused;
    const pos = videoEl.currentTime || 0;

    try {
      const data = await requestExtract({
        url: videoUrl,
        season: meta?.currentSeason || null,
        episode: meta?.currentEpisode || null,
        forceRefresh: true, // игнорируем кэш на бэкенде — старая ссылка мертва
      });
      if (destroyed) return;

      if (data.success && data.streams?.length) {
        refreshAttempts = 0;
        emitStreams(data, meta?.currentSeason, meta?.currentEpisode); // та же серия — сервер позицию не сбросит
        const best = pickBestStream(data.streams);
        currentStream = best;
        if (meta) meta.currentQuality = best?.quality || null;

        await setupSource(best);
        scheduleProactiveRefresh(best.url);
        resumeAt(pos, wasPlaying);
      } else {
        refreshAttempts++;
        console.error('[capture] не удалось получить свежий поток (попытка', refreshAttempts, '):', data.error || data.message);
        if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
          setTimeout(() => refreshExpiredStream(), RETRY_BASE_DELAY_MS * refreshAttempts); // 4с, 8с
        } else {
          console.error('[capture] превышен лимит попыток обновления потока — сдаюсь');
        }
      }
    } catch (e) {
      refreshAttempts++;
      console.error('[capture] ошибка обновления потока (попытка', refreshAttempts, '):', e.message);
      if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
        setTimeout(() => refreshExpiredStream(), RETRY_BASE_DELAY_MS * refreshAttempts);
      }
    } finally {
      isRefreshingStream = false;
    }
  }

  const switchQuality = (quality) => {
    const next = streamsList.find((s) => String(s.quality) === String(quality));
    if (!next || next.url === currentStream.url) return;

    const wasPlaying = !videoEl.paused;
    const pos = videoEl.currentTime || 0;
    currentStream = next;
    if (meta) meta.currentQuality = quality;

    setupSource(next).then(() => {
      scheduleProactiveRefresh(next.url); // у другого качества обычно свой токен/срок жизни ссылки
      resumeAt(pos, wasPlaying);
    });
  };

  const player = {
    type: 'player_capture',
    videoEl,
    meta,
    hls: () => hlsInstance,
    getCurrentPosition: () => videoEl.currentTime || 0,
    getIsPlayingNow: () => !videoEl.paused,
    doPlayPause: (play) => (play ? videoEl.play().catch(() => {}) : videoEl.pause()),
    seekTo: (sec) => { videoEl.currentTime = sec; },
    destroy: () => {
      destroyed = true;
      clearTimeout(proactiveRefreshTimer);
      clearTimeout(stallTimer);
      clearInterval(frozenTimer);
      videoEl.removeEventListener('waiting', armStallWatchdog);
      videoEl.removeEventListener('playing', disarmStallWatchdog);
      videoEl.removeEventListener('pause', disarmStallWatchdog);
      destroyHls();
      // без этого старый <video> продолжает качать поток и отнимает канал у нового
      try { videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
    },
  };

  setupControls(meta, { isOwner, container, videoUrl, meta, current: player }, streamsList, switchQuality);
  return player;
}

export function renderFromStreams(streams, meta, { isOwner, container, videoUrl }) {
  if (!streams?.length) {
    return renderFallback(videoUrl || '', meta || {}, { isOwner, container, errorMessage: 'Нет потоков', videoUrl });
  }
  const best = pickBestStream(streams);
  const m = { ...(meta || {}), currentQuality: best?.quality || null };
  return renderNativePlayer(best, m, { isOwner, container, videoUrl, allStreams: streams });
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
        ${escHtml(errorMessage || 'Сайт использует сильную защиту')}
      </p>
      <p style="opacity:0.5; font-size:13px; max-width:420px;">
        Если есть выбор плеера (например «4К Качество») — переключи его справа<br>
        и подожди повторной загрузки.
      </p>
    </div>
  `;

  const player = {
    type: 'player_capture',
    meta,
    getCurrentPosition: () => 0,
    getIsPlayingNow: () => false,
    doPlayPause: () => {},
    seekTo: () => {},
    destroy: () => {},
  };
  setupControls(meta || {}, { isOwner, container, videoUrl: videoUrl || url, meta, current: player });
  return player;
}
