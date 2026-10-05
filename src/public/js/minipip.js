// Мини-плеер PartyWatcher. Подключается на всех страницах сайта.
//  1) Страница с большим плеером вызывает PWMini.enterPip(...): видео уходит в окно браузера (Picture-in-Picture).
//  2) Если после этого перейти на другую страницу сайта, браузер закрывает окно PiP,
//     а на новой странице в углу появляется мини-плеер (из него окно PiP можно открыть снова).
//  3) Сессия лежит в sessionStorage: живёт, пока открыта вкладка, и не лезет в другие вкладки.
(function () {
  if (window.PWMini) return;

  const SS_KEY = 'pw_mini_session';
  const LS_POS = 'pw_mini_pos';
  const LS_W = 'pw_mini_w';
  const LS_SND = 'pw_mini_sound'; // запомненный звук мини-плеера: { muted, volume }
  const HLS_URL = '/vendor/hls.min.js'; // свой файл: не зависит от CDN и нужен для строгой CSP
  const POLL_MS = 5000;
  const MIN_W = 240;
  const MAX_W = 640;

  let leaving = false;
  let pausedByMini = null;
  let volSlider = null;
  let quietVol = false;   // программное изменение громкости — в настройку не сохраняем
  let wantSound = false;  // хотим звук, но браузер мог его не дать

  let session = null;
  let root = null;
  let video = null;
  let offlineEl = null;
  let muteBtn = null;
  let hls = null;
  let pollTimer = null;
  let hlsPromise = null;
  // undefined — состояние ещё не применяли; null — эфира нет; строка — playbackId
  let currentPlaybackId = undefined;

  // ---------- утилиты ----------

  function ssGet() {
    try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch (_) { return null; }
  }
  function ssSet(s) {
    try {
      if (s) sessionStorage.setItem(SS_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SS_KEY);
    } catch (_) {}
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function clamp(v, min, max) { return Math.max(min, Math.min(v, max)); }
  function sndGet() {
    try {
      const o = JSON.parse(lsGet(LS_SND) || 'null');
      if (o && typeof o.volume === 'number') return { muted: !!o.muted, volume: clamp(o.volume, 0, 1) };
    } catch (_) {}
    return null;
  }
  function sndSet(muted, volume) {
    lsSet(LS_SND, JSON.stringify({ muted: !!muted, volume: clamp(volume, 0, 1) }));
  }

  function normPath(p) {
    let s = String(p || '');
    try { s = decodeURIComponent(s); } catch (_) {}
    return s.toLowerCase().replace(/\/+$/, '') || '/';
  }

  function pipSupported() {
    return !!(document.pictureInPictureEnabled && HTMLVideoElement.prototype.requestPictureInPicture);
  }

  // ---------- жизненный цикл страницы ----------

  // при уходе со страницы браузер сам закрывает окно PiP — это не «пользователь закрыл мини-окно»
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('pageshow', (e) => { if (e.persisted) leaving = false; });

  // закрыли окно PiP, пока смотрели другую вкладку, — видео ставим на паузу (чтобы не гудело в фоне),
  // а когда вернулись на вкладку, продолжаем с живого края
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !pausedByMini) return;
    const v = pausedByMini;
    pausedByMini = null;
    try {
      if (v.seekable && v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1);
    } catch (_) {}
    v.play().catch(() => {});
  });

  function watchPip(v, { onClosed, alwaysTrack = false }) {
    if (v.dataset.pwMiniWatch) return;
    v.dataset.pwMiniWatch = '1';

    // запоминаем звук, чтобы на следующей странице мини-плеер заиграл так же
    v.addEventListener('volumechange', () => {
      if (quietVol) return;
      if (!alwaysTrack && document.pictureInPictureElement !== v) return;
      const s = ssGet();
      if (s) {
        s.muted = v.muted;
        s.volume = v.volume;
        ssSet(s);
      }
      sndSet(v.muted, v.volume); // что выбрал человек, то и будет по умолчанию
    });

    v.addEventListener('leavepictureinpicture', () => {
      // если страница уходит, таймер просто не успеет сработать и сессия останется
      setTimeout(() => {
        if (leaving) return;
        onClosed();
        if (document.visibilityState === 'hidden') {
          v.pause();
          pausedByMini = v;
        }
      }, 100);
    });
  }

  // ---------- вход из большого плеера ----------

  // Возвращает текст ошибки или null, если всё получилось
  async function enterPip({ video: v, streamer, returnPath }) {
    if (!pipSupported()) return 'Браузер не поддерживает мини-окно';
    if (!v || v.classList.contains('hidden') || v.readyState < 1) return 'Мини-окно доступно, пока идёт эфир';

    try {
      await v.requestPictureInPicture();
    } catch (err) {
      return 'Не удалось открыть мини-окно: ' + (err.message || err.name);
    }

    if (root) destroyFloating(); // на этой странице уже был угловой мини-плеер другого стрима — заменяем

    const pref = sndGet();
    ssSet({
      streamer: String(streamer || '').toLowerCase(),
      returnPath: String(returnPath || '/'),
      muted: pref ? pref.muted : v.muted,
      volume: pref ? pref.volume : v.volume,
    });
    watchPip(v, { onClosed: () => ssSet(null) }); // закрыли окно на этой же странице — всё вернулось в плеер
    return null;
  }

  // ---------- угловой мини-плеер (после перехода по сайту) ----------

  function injectStyles() {
    if (document.getElementById('pwMiniStyles')) return;
    const st = document.createElement('style');
    st.id = 'pwMiniStyles';
    st.textContent = `
      .pwmini { position: fixed; right: 16px; bottom: 16px; width: 320px; z-index: 9000;
        display: flex; flex-direction: column; background: #000; overflow: hidden;
        border: 1px solid rgba(255,255,255,.18); border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.5); }
      .pwmini.in-pip { visibility: hidden; pointer-events: none; }
      .pwmini-head { display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 10px;
        background: rgba(28,28,32,.96); color: #fff; font-size: 12px; font-weight: 700;
        cursor: move; user-select: none; touch-action: none; }
      .pwmini-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pwmini-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }
      .pwmini.is-live .pwmini-dot { background: #ef4444; }
      .pwmini-btn { all: unset; width: 22px; height: 22px; display: flex; align-items: center;
        justify-content: center; border-radius: 6px; font-size: 13px; color: #fff; cursor: pointer; }
      .pwmini-btn:hover { background: rgba(255,255,255,.18); }
      .pwmini .pwmini-vol { width: 64px; height: 4px; margin: 0 4px; padding: 0; border: 0;
        background: transparent; box-shadow: none; accent-color: #fff; cursor: pointer; }
      .pwmini .pwmini-vol:focus { background: transparent; box-shadow: none; }
      .pwmini-body { position: relative; aspect-ratio: 16 / 9; background: #000; }
      .pwmini-body video { width: 100%; height: 100%; object-fit: contain; display: block; }
      .pwmini-hidden { visibility: hidden; }
      .pwmini-offline { position: absolute; inset: 0; display: flex; align-items: center;
        justify-content: center; padding: 8px; text-align: center; font-size: 13px;
        color: rgba(255,255,255,.55); }
      .pwmini-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; touch-action: none;
        background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,.4) 50%); }
    `;
    document.head.appendChild(st);
  }

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsPromise) {
      hlsPromise = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = HLS_URL;
        s.onload = () => resolve(window.Hls || null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    return hlsPromise;
  }

  function placeAt(left, top) {
    if (!root) return;
    const maxL = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - root.offsetHeight);
    root.style.left = clamp(left, 0, maxL) + 'px';
    root.style.top = clamp(top, 0, maxT) + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function applySavedPosition() {
    let saved = null;
    try { saved = JSON.parse(lsGet(LS_POS) || 'null'); } catch (_) {}
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return; // по умолчанию — правый нижний угол
    placeAt(saved.left, saved.top);
  }

  function bindDrag() {
    const head = root.querySelector('.pwmini-head');
    let dragging = false;
    let sx = 0, sy = 0, ol = 0, ot = 0;

    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input')) return;
      const r = root.getBoundingClientRect();
      ol = r.left; ot = r.top; sx = e.clientX; sy = e.clientY;
      dragging = true;
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      placeAt(ol + e.clientX - sx, ot + e.clientY - sy);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (_) {}
      lsSet(LS_POS, JSON.stringify({
        left: parseFloat(root.style.left) || 0,
        top: parseFloat(root.style.top) || 0,
      }));
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function bindResize() {
    const handle = root.querySelector('.pwmini-resize');
    let resizing = false;
    let sx = 0, startW = 0;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = root.getBoundingClientRect();
      placeAt(r.left, r.top); // переходим на привязку left/top, чтобы окно росло от левого верхнего угла
      startW = root.offsetWidth;
      sx = e.clientX;
      resizing = true;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const left = root.getBoundingClientRect().left;
      const maxW = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - left - 8));
      root.style.width = clamp(startW + e.clientX - sx, MIN_W, maxW) + 'px';
    });
    const end = (e) => {
      if (!resizing) return;
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      lsSet(LS_W, String(Math.round(root.offsetWidth)));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function updateMuteIcon() {
    if (!muteBtn || !video) return;
    muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    if (volSlider) volSlider.value = String(Math.round(video.volume * 100));
  }

  // браузер не дал стартовать со звуком: включим при первом клике/клавише на странице
  function armSoundOnGesture() {
    const once = (ev) => {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('keydown', once, true);
      if (root && ev.target instanceof Node && root.contains(ev.target)) return; // кликнули по самому мини-плееру — управляют сами
      if (video && wantSound && video.muted) {
        video.muted = false;
        updateMuteIcon();
      }
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }

  function playVideo() {
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        // после перехода браузер может не дать стартовать со звуком — стартуем без звука, включить можно кнопкой 🔊
        if (err && err.name === 'NotAllowedError' && !video.muted) {
          quietVol = true; // это не выбор человека, в настройку не пишем
          video.muted = true;
          setTimeout(() => { quietVol = false; }, 100);
          updateMuteIcon();
          video.play().catch(() => {});
          armSoundOnGesture();
        }
      });
    }
  }

  function build() {
    injectStyles();

    root = document.createElement('div');
    root.className = 'pwmini';
    root.innerHTML = `
      <div class="pwmini-head">
        <span class="pwmini-dot"></span>
        <span class="pwmini-title"></span>
        <input type="range" class="pwmini-vol" min="0" max="100" title="Громкость">
        <button type="button" class="pwmini-btn" data-act="mute" title="Звук">🔇</button>
        <button type="button" class="pwmini-btn" data-act="pip" title="Мини-окно поверх всех окон">⧉</button>
        <button type="button" class="pwmini-btn" data-act="back" title="К плееру">↩</button>
        <button type="button" class="pwmini-btn" data-act="close" title="Закрыть и выключить звук">×</button>
      </div>
      <div class="pwmini-body">
        <video class="pwmini-hidden" playsinline></video>
        <div class="pwmini-offline">Загрузка…</div>
      </div>
      <div class="pwmini-resize" title="Потяни, чтобы изменить размер"></div>
    `;
    document.body.appendChild(root);

    root.querySelector('.pwmini-title').textContent = session.streamer;
    video = root.querySelector('video');
    offlineEl = root.querySelector('.pwmini-offline');
    muteBtn = root.querySelector('[data-act="mute"]');
    const pipBtn = root.querySelector('[data-act="pip"]');
    volSlider = root.querySelector('.pwmini-vol');

    // запомненная настройка важнее: звук включали в мини-плеере — он включён сразу
    const pref = sndGet();
    video.volume = pref ? pref.volume : typeof session.volume === 'number' ? clamp(session.volume, 0, 1) : 0.5;
    video.muted = pref ? pref.muted : !!session.muted;
    wantSound = !video.muted;
    updateMuteIcon();
    video.addEventListener('volumechange', updateMuteIcon);

    const w = parseInt(lsGet(LS_W), 10);
    if (w >= MIN_W && w <= MAX_W) root.style.width = w + 'px';
    applySavedPosition();

    bindDrag();
    bindResize();

    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 0.5;
      wantSound = !video.muted;
      sndSet(video.muted, video.volume);
      updateMuteIcon();
    });

    volSlider.addEventListener('input', () => {
      const v = parseInt(volSlider.value, 10) / 100;
      video.volume = v;
      if (v > 0 && video.muted) video.muted = false;
      wantSound = !video.muted && v > 0;
      sndSet(video.muted, v);
    });

    if (!pipSupported()) {
      pipBtn.style.display = 'none';
    } else {
      pipBtn.addEventListener('click', async () => {
        if (document.pictureInPictureElement === video) {
          try { await document.exitPictureInPicture(); } catch (_) {}
          return;
        }
        if (video.classList.contains('pwmini-hidden') || video.readyState < 1) return;
        try { await video.requestPictureInPicture(); } catch (_) {}
      });
      video.addEventListener('enterpictureinpicture', () => root && root.classList.add('in-pip'));
      watchPip(video, {
        alwaysTrack: true,
        onClosed: () => root && root.classList.remove('in-pip'),
      });
    }

    root.querySelector('[data-act="back"]').addEventListener('click', () => {
      const s = ssGet() || session;
      location.href = (s && s.returnPath) || '/streams.html';
    });
    root.querySelector('[data-act="close"]').addEventListener('click', closeFloating);
  }

  function showOffline(text) {
    if (!root) return;
    offlineEl.textContent = text || 'Стрим сейчас офлайн';
    offlineEl.style.display = 'flex';
    video.classList.add('pwmini-hidden');
  }

  function destroyHls() {
    if (hls) {
      try { hls.destroy(); } catch (_) {}
      hls = null;
    }
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    }
  }

  function attach(id) {
    const src = `/media/live/${id}/master.m3u8?t=${Date.now()}`;

    loadHls().then((H) => {
      if (!root || currentPlaybackId !== id) return;

      if (H && H.isSupported()) {
        hls = new H({
          capLevelToPlayerSize: true, // маленькое окно — берём качество поменьше, меньше лагов на слабом интернете
          lowLatencyMode: false,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4,
          maxLiveSyncPlaybackRate: 1.15,
          backBufferLength: 6,
          liveDurationInfinity: true,
          manifestLoadingMaxRetry: 8,
          levelLoadingMaxRetry: 8,
          fragLoadingMaxRetry: 8,
        });
        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(H.Events.MANIFEST_PARSED, () => {
          video.classList.remove('pwmini-hidden');
          playVideo();
        });
        hls.on(H.Events.ERROR, (_e, data) => {
          if (!data || !data.fatal) return;
          if (data.type === H.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); } catch (_) {}
          } else {
            currentPlaybackId = undefined; // на ближайшем опросе подключимся заново
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.classList.remove('pwmini-hidden');
        playVideo();
      } else {
        showOffline('Браузер не поддерживает HLS');
      }
    });
  }

  function applyState(isLive, playbackId) {
    if (!root) return;
    const id = isLive && playbackId ? playbackId : null;

    root.classList.toggle('is-live', !!id);
    if (id === currentPlaybackId) return;
    currentPlaybackId = id;

    destroyHls();
    if (!id) {
      showOffline();
      return;
    }
    offlineEl.style.display = 'none';
    attach(id);
  }

  async function refresh() {
    if (!root || !session) return;
    try {
      const res = await fetch('/api/streamers/' + encodeURIComponent(session.streamer) + '/live-status', {
        credentials: 'same-origin',
      });
      if (res.status === 404) {
        currentPlaybackId = undefined;
        destroyHls();
        showOffline('Стример не найден');
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      applyState(!!d.isLive, d.streamPlaybackId || null);
    } catch (_) {
      // сеть моргнула — оставляем как есть до следующего опроса
    }
  }

  function openFloating(s) {
    if (root) return;
    session = s;
    build();
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  }

  // убрать окно, не трогая сессию
  function destroyFloating() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (video && document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    }
    destroyHls();
    if (root) root.remove();
    root = null;
    video = null;
    offlineEl = null;
    muteBtn = null;
    volSlider = null;
    currentPlaybackId = undefined;
  }

  // крестик: закрыть, остановить звук и забыть сессию
  function closeFloating() {
    destroyFloating();
    ssSet(null);
  }

  window.addEventListener('resize', () => {
    if (!root || !root.style.left) return;
    placeAt(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
  });

  function init() {
    const s = ssGet();
    if (!s || !s.streamer) return;

    // мы уже на странице с большим плеером этого стрима — «вернулись», сессия больше не нужна
    if (normPath(location.pathname) === normPath(s.returnPath)) {
      ssSet(null);
      return;
    }
    openFloating(s);
  }

  window.PWMini = { enterPip, pipSupported, closeFloating };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();