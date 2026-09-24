// index.js (playerCapture)

import { createIframePlayer } from './iframeManager.js';
import { detectMeta } from './detector.js';
import { showEpisodeControls, hideEpisodeControls } from './controls.js';

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

        let data = await res.json();
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
        container.innerHTML = `
          <div style="
            display:flex;align-items:center;justify-content:center;
            height:100%;color:#fff;background:#111;flex-direction:column;gap:12px;
          ">
            <div style="font-size:32px;">⏳</div>
            <div>Пробуем плеер «${label}»...</div>
          </div>
        `;

        const resNext = await fetch('/api/player-capture/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            url: video.url,
            episode: video.meta?.currentEpisode || null,
            player: label,
            roomCode: window.code,
          }),
        });
        const next = await resNext.json();
        console.log('[playerCapture] extract result (player:', label, '):', next);

        if (next.success && next.streams?.length) {
          data = next;
          break;
        }
        // сохраняем последний ответ с players, даже если streams пусто
        if (next.meta?.players?.length) {
          data = next;
        }
      }
    }

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
        const best = pickBestStream(data.streams);
        const m = { ...(data.meta || meta), currentQuality: best?.quality || null };
        return renderNativePlayer(best, m, {
          isOwner,
          container,
          videoUrl: video.url,
          allStreams: data.streams,
        });
      }
      if (data.playerIframes?.length) {
        return renderPlayerIframe(data.playerIframes[0], data.meta || meta, {
          isOwner,
          container,
          videoUrl: video.url,
        });
      }
    }

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

function renderPlayerIframe(playerUrl, meta, { isOwner, container, videoUrl }) {
  container.innerHTML = '';
  
  const iframe = document.createElement('iframe');
  iframe.src = playerUrl;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.referrerPolicy = 'no-referrer';
  container.appendChild(iframe);

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
        const player = renderNativePlayer(data.streams[0], data.meta || meta, {
          isOwner,
          container,
          videoUrl,
        });
        if (typeof window.__onCapturePlayerReload === 'function') {
          window.__onCapturePlayerReload(player);
        }
        return player;
      } else if (data.success && data.playerIframes?.length) {
        const player = renderPlayerIframe(data.playerIframes[0], data.meta || meta, {
          isOwner,
          container,
          videoUrl,
        });
        if (typeof window.__onCapturePlayerReload === 'function') {
          window.__onCapturePlayerReload(player);
        }
        return player;
      } else {
        renderFallback(videoUrl, data.meta || meta, {
          isOwner,
          container,
          errorMessage: data.error || data.message || 'Не удалось загрузить',
          videoUrl,
        });
      }
    };

    showEpisodeControls(meta, reloadWithEpisode);
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

function loadHlsScript() {
  return new Promise((resolve, reject) => {
    if (window.Hls) return resolve(window.Hls);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => reject(new Error('Не удалось загрузить hls.js'));
    document.head.appendChild(s);
  });
}

function renderNativePlayer(stream, meta, { isOwner, container, videoUrl, allStreams }) {
  container.innerHTML = '';
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

  let currentStream = stream;
  const streamsList = allStreams || [stream];
  let hlsInstance = null;
  let isRefreshingStream = false; // общий флаг вместо hlsInstance.__refreshing — переживает пересоздание hlsInstance
  let mediaRecoverTried = false;
  let consecutiveNetworkErrors = 0; // если CDN рвётся без чёткого 404/410 (CORS/timeout) несколько раз подряд — тоже повод обновить поток

    const setupSource = async (streamToPlay) => {
    mediaRecoverTried = false;      // новый источник — можно снова попробовать recoverMediaError при следующей ошибке
    consecutiveNetworkErrors = 0;   // и снова с нуля считать подряд идущие сетевые ошибки
    const streamUrl = streamToPlay.url;
    const isHls = streamToPlay.type === 'hls' || /\.m3u8(\?|$)/i.test(streamUrl) || /cinemap\.cc|cinemar\.cc|cfnd\./i.test(streamUrl);
    const refQ = streamToPlay.referer
      ? `&referer=${encodeURIComponent(streamToPlay.referer)}`
      : '';
    const playUrl = `/api/stream/relay?url=${encodeURIComponent(streamUrl)}${refQ}`;

    const toAbsolutePlaylist = (text) => {
      const origin = window.location.origin;
      const refSuffix = streamToPlay.referer
        ? `&referer=${encodeURIComponent(streamToPlay.referer)}`
        : '';
      const addRef = (path) => {
        if (!refSuffix || path.includes('referer=')) return path;
        return path + refSuffix;
      };
      return text
        .split('\n')
        .map((line) => {
          if (line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-KEY')) {
            return line.replace(
              /URI="(\/api\/stream\/relay\?url=[^"]+)"/,
              (_, path) => `URI="${origin}${addRef(path)}"`
            );
          }
          if (line.startsWith('/api/stream/relay?url=')) {
            return origin + addRef(line);
          }
          return line;
        })
        .join('\n');
    };

    try {
      if (hlsInstance) {
        try { hlsInstance.destroy(); } catch (_) {}
        hlsInstance = null;
      }
      if (isHls) {
        const Hls = await loadHlsScript();
        if (Hls.isSupported()) {
          hlsInstance = new Hls({
            enableWorker: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
          });

          if (streamToPlay.playlist) {
            const blob = new Blob([toAbsolutePlaylist(streamToPlay.playlist)], {
              type: 'application/vnd.apple.mpegurl',
            });
            hlsInstance.loadSource(URL.createObjectURL(blob));
          } else {
            hlsInstance.loadSource(playUrl);
          }

          hlsInstance.attachMedia(videoEl);
          hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            console.error('[capture] hls error', data);
            if (!data.fatal) return;

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              consecutiveNetworkErrors++;
            }

            // сетевые фатальные ошибки на уже "протухшей" подписанной ссылке
            // (410/404 от relay) не лечатся пересозданием Hls с тем же URL —
            // нужен свежий extract. То же самое, если CDN несколько раз подряд
            // обрывается без внятного кода (CORS/timeout) — тоже сигнал,
            // что со старой ссылкой что-то не так
            const isDeadLink =
              data.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (data.response?.code === 410 || data.response?.code === 404 || consecutiveNetworkErrors >= 3);

            if (isDeadLink && !isRefreshingStream) {
              console.warn('[capture] ссылка протухла (или CDN стабильно рвётся), запрашиваю свежий поток...');
              refreshExpiredStream();
              return;
            }

            // фатальную ошибку декодера часто можно вылечить без полной пересборки —
            // recoverMediaError() дешевле и не сбивает позицию воспроизведения
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoverTried) {
              mediaRecoverTried = true;
              console.warn('[capture] пробую recoverMediaError() перед пересборкой плеера');
              try {
                hlsInstance.recoverMediaError();
                return;
              } catch (_) {
                // не получилось — падаем в обычную пересборку ниже
              }
            }

            try { hlsInstance.destroy(); } catch (_) {}
            hlsInstance = new Hls({
              enableWorker: true,
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
            });
            if (streamToPlay.playlist) {
              const blob = new Blob([toAbsolutePlaylist(streamToPlay.playlist)], {
                type: 'application/vnd.apple.mpegurl',
              });
              hlsInstance.loadSource(URL.createObjectURL(blob));
            } else {
              hlsInstance.loadSource(playUrl);
            }
            hlsInstance.attachMedia(videoEl);
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = playUrl;
        } else {
          videoEl.src = playUrl;
        }
      } else {
        videoEl.src = playUrl;
      }
    } catch (e) {
      console.error('[capture] setupSource failed', e);
      videoEl.src = playUrl;
    }
  };

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
    const refreshAt = expiry.getTime() - 2 * 60 * 1000;
    const delay = refreshAt - Date.now();

    if (delay <= 0) {
      // ссылка уже истекла или истечёт вот-вот — обновляем сразу
      refreshExpiredStream();
      return;
    }

    console.log('[capture] запланировано проактивное обновление потока через', Math.round(delay / 1000), 'сек');
    proactiveRefreshTimer = setTimeout(() => refreshExpiredStream(), delay);
  }

  scheduleProactiveRefresh(currentStream.url);

    // независимый сторож: если видео "виснет" на буферизации дольше 12 сек —
  // считаем поток подвисшим, даже если hls.js не кинул fatal-ошибку явно
  let stallTimer = null;
  const STALL_TIMEOUT_MS = 12000;

  function armStallWatchdog() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (videoEl.paused || videoEl.ended) return; // пауза/конец — это не зависание
      if (isRefreshingStream) return; // обновление уже идёт — не запускаем второе поверх
      console.warn('[capture] видео виснет на буферизации дольше', STALL_TIMEOUT_MS / 1000, 'сек — пробую обновить поток');
      refreshExpiredStream();
    }, STALL_TIMEOUT_MS);
  }

  function disarmStallWatchdog() {
    clearTimeout(stallTimer);
  }

  videoEl.addEventListener('waiting', armStallWatchdog);
  videoEl.addEventListener('playing', disarmStallWatchdog);
  videoEl.addEventListener('pause', disarmStallWatchdog);

  async function refreshExpiredStream() {
    if (!isOwner) return; // только хост инициирует переизвлечение, зритель получит обновление через socket
    if (isRefreshingStream) return; // уже обновляем — не запускаем параллельно
    isRefreshingStream = true;
    disarmStallWatchdog();

    const wasPlaying = !videoEl.paused;
    const pos = videoEl.currentTime || 0;

    try {
      const res = await fetch('/api/player-capture/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          url: videoUrl,
          episode: meta?.currentEpisode || null,
          roomCode: window.code,
          forceRefresh: true, // игнорируем кэш на бэкенде — старая ссылка мертва
        }),
      });
      const data = await res.json();

      if (data.success && data.streams?.length) {
        refreshAttempts = 0; // успех — сбрасываем счётчик неудачных попыток

        if (window.socket && window.code) {
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
        const best = pickBestStream(data.streams);
        currentStream = best;
        if (meta) meta.currentQuality = best?.quality || null;

        await setupSource(best);
        scheduleProactiveRefresh(best.url); // сразу планируем следующее обновление для НОВОЙ ссылки

        const resume = () => {
          try { videoEl.currentTime = pos; } catch (_) {}
          if (wasPlaying) videoEl.play().catch(() => {});
        };
        if (videoEl.readyState >= 2) resume();
        else videoEl.addEventListener('loadeddata', resume, { once: true });
      } else {
        refreshAttempts++;
        console.error('[capture] не удалось получить свежий поток (попытка', refreshAttempts, '):', data.error || data.message);
        if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
          setTimeout(() => refreshExpiredStream(), RETRY_BASE_DELAY_MS * refreshAttempts); // растущая пауза: 4с, 8с, 12с
        } else {
          console.error('[capture] превышен лимит попыток обновления потока — сдаюсь');
        }
      }
    } catch (e) {
      refreshAttempts++;
      console.error('[capture] ошибка обновления протухшего потока (попытка', refreshAttempts, '):', e.message);
      if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
        setTimeout(() => refreshExpiredStream(), RETRY_BASE_DELAY_MS * refreshAttempts);
      }
    } finally {
      isRefreshingStream = false;
    }
  }

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

  const switchQuality = (quality) => {
    const next = streamsList.find((s) => String(s.quality) === String(quality));
    if (!next || next.url === currentStream.url) return;

    const wasPlaying = !videoEl.paused;
    const pos = videoEl.currentTime || 0;
    currentStream = next;
    if (meta) meta.currentQuality = quality;

    setupSource(next).then(() => {
      scheduleProactiveRefresh(next.url); // у другого качества обычно свой токен/срок жизни ссылки

      const resume = () => {
        try { videoEl.currentTime = pos; } catch (_) {}
        if (wasPlaying) videoEl.play().catch(() => {});
      };
      if (videoEl.readyState >= 2) resume();
      else videoEl.addEventListener('loadeddata', resume, { once: true });
    });
  };

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
      const best = pickBestStream(data.streams);
      const m = { ...(data.meta || meta), currentQuality: best?.quality || null };
      const player = renderNativePlayer(best, m, {
        isOwner,
        container,
        videoUrl,
        allStreams: data.streams,
      });
      if (typeof window.__onCapturePlayerReload === 'function') {
        window.__onCapturePlayerReload(player);
      }
      return player;
    } else if (data.success && data.playerIframes?.length) {
      const player = renderPlayerIframe(data.playerIframes[0], data.meta || meta, {
        isOwner,
        container,
        videoUrl,
      });
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

  const hasControls =
    isOwner &&
    (meta.seasons?.length > 1 ||
      meta.totalEpisodes > 1 ||
      meta.voices?.length ||
      (meta.players && meta.players.length > 1) ||
      streamsList.filter((s) => s.quality).length > 1);

  if (hasControls) {
    showEpisodeControls(meta, reloadWithEpisode, streamsList, switchQuality);
  } else {
    hideEpisodeControls();
  }

  return {
    type: 'player_capture',
    videoEl,
    meta,
    hls: () => hlsInstance,
    getCurrentPosition: () => videoEl.currentTime || 0,
    getIsPlayingNow: () => !videoEl.paused,
    doPlayPause: (play) => (play ? videoEl.play().catch(() => {}) : videoEl.pause()),
    seekTo: (sec) => { videoEl.currentTime = sec; },
    destroy: () => {
      clearTimeout(proactiveRefreshTimer);
      clearTimeout(stallTimer);
      videoEl.removeEventListener('waiting', armStallWatchdog);
      videoEl.removeEventListener('playing', disarmStallWatchdog);
      videoEl.removeEventListener('pause', disarmStallWatchdog);
      try { if (hlsInstance) hlsInstance.destroy(); } catch (_) {}
      hlsInstance = null;
    },
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
          videoUrl: videoUrl || url,
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