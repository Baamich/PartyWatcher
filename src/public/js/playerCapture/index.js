// index.js (playerCapture)

import { createIframePlayer } from './iframeManager.js';
import { detectMeta } from './detector.js';
import { showEpisodeControls, hideEpisodeControls } from './controls.js';

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

    const setupSource = async (streamToPlay) => {
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
            if (data.fatal) {
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
            }
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