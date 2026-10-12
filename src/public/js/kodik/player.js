// Плеер Kodik в комнате: iframe их плеера + управление через postMessage.
// Команды: { key: 'kodik_player_api', value: { method: play|pause|seek|volume|change_episode } }.
// События из iframe: kodik_player_play/pause/seek/time_update/video_started/current_episode/…
// Время приходит раз в секунду (только пока идёт видео), между событиями позицию досчитываем сами.

const MAX_EXTRAPOLATE_S = 2; // буферизация: событий нет — дальше 2 с от последнего не «уезжаем»
// Kodik иногда молча теряет play или долго догружает место после перемотки — повторяем play, пока видео не пойдёт.
// Не пошло, а внутри плеера ещё не кликали — значит, браузер не разрешил запуск (нужен клик в плеере)
const PLAY_AFTER_SEEK_MS = 300;
const PLAY_RETRY_MS = 1500;
const PLAY_ATTEMPTS = 4;
const OWN_COMMAND_MS = 8000; // play/pause позже этого после нашей команды — сделал сам человек в плеере

function withEpisode(url, season, episode) {
  if (!season && !episode) return url;
  const p = new URLSearchParams();
  if (season) p.set('season', season);
  if (episode) p.set('episode', episode);
  return `${url}?${p}`;
}

export function createKodikPlayer(container, { url, season, episode, volume, on = {} }) {
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.style.cssText = 'width:100%;height:100%;border:0';
  iframe.src = withEpisode(url, season, episode);
  container.appendChild(iframe);

  let baseUrl = url;
  let time = 0;
  let timeAt = 0;
  let playing = false;
  let contentStarted = false; // реклама/заставка прошла, пошло само видео — теперь seek сработает
  let pendingSeek = null;
  let startedAt = 0;
  let lastVolume = typeof volume === 'number' ? volume : null;
  let destroyed = false;
  let playTimer = null;
  let playLoop = false; // идут попытки запуска (повторный play() от синхронизации их не сбрасывает)
  let playAttempts = 0;
  let lastSeekAt = 0;
  let lastCommandAt = 0;
  let activated = false; // в этой странице плеера уже кликали — браузер разрешает ей запуск
  let blockedReported = false;

  const send = (value) => {
    try { iframe.contentWindow?.postMessage({ key: 'kodik_player_api', value }, '*'); } catch (_) {}
  };
  const setTime = (s) => {
    time = s;
    timeAt = Date.now();
  };

  function onContentStart() {
    if (contentStarted) return;
    contentStarted = true;
    startedAt = Date.now();
    if (lastVolume !== null) send({ method: 'volume', volume: lastVolume });
    if (pendingSeek !== null) {
      const s = pendingSeek;
      pendingSeek = null;
      setTimeout(() => api.seek(s), 300);
    }
    on.started?.();
  }

  function onMessage(e) {
    if (destroyed || e.source !== iframe.contentWindow) return;
    const data = e.data;
    if (!data || typeof data !== 'object' || typeof data.key !== 'string') return;
    const v = data.value;

    switch (data.key) {
      case 'kodik_player_time_update':
        if (typeof v === 'number') setTime(v);
        onContentStart();
        break;
      case 'kodik_player_video_started':
        onContentStart();
        break;
      case 'kodik_player_play':
        if (Date.now() - lastCommandAt > OWN_COMMAND_MS) activated = true;
        playAttempts = 0;
        playing = true;
        timeAt = Date.now();
        on.play?.();
        break;
      case 'kodik_player_pause':
        if (Date.now() - lastCommandAt > OWN_COMMAND_MS) activated = true;
        time = api.getCurrentTime();
        playing = false;
        on.pause?.();
        break;
      case 'kodik_player_video_ended':
        playing = false;
        break;
      case 'kodik_player_seek': {
        const s = typeof v === 'number' ? v : Number(v?.time);
        if (Number.isFinite(s)) setTime(s);
        on.seek?.();
        break;
      }
      case 'kodik_player_current_episode':
        on.episode?.({
          season: Number(v?.season) || null,
          episode: Number(v?.episode) || null,
          translationId: Number(v?.translation?.id) || null,
          translationTitle: typeof v?.translation?.title === 'string' ? v.translation.title : null,
        });
        break;
    }
  }
  window.addEventListener('message', onMessage);
  // новая страница в iframe (своя смена озвучки, серия с перезагрузкой) — плеер стартует заново:
  // громкость и отложенная перемотка применятся при следующем старте видео
  iframe.addEventListener('load', () => {
    contentStarted = false;
    playing = false;
    activated = false; // новая страница — разрешение на запуск от прошлого клика пропало
    blockedReported = false;
    clearTimeout(playTimer);
    playLoop = false;
    playAttempts = 0;
  });

  const api = {
    iframe,
    get url() { return baseUrl; },
    getCurrentTime() {
      if (!playing) return time;
      return time + Math.min(MAX_EXTRAPOLATE_S, (Date.now() - timeAt) / 1000);
    },
    isPlaying() { return playing; },
    // видео идёт и отложенная перемотка уже применилась — позиции можно верить
    isReady() { return contentStarted && pendingSeek === null && Date.now() - startedAt > 1500; },
    // До загрузки плеера Kodik сам запустит его по этой команде. А вот после паузы браузер не даёт
    // чужому iframe снова включить звук, пока внутри него не было клика — тогда просим кликнуть (on.blocked)
    play() {
      if (playing || playLoop) return;
      playLoop = true;
      const tryPlay = () => {
        // до старта видео одна команда запускает загрузку плеера — повторять нечего
        if (destroyed || playing || (!contentStarted && playAttempts > 0)) {
          playLoop = false;
          return;
        }
        if (playAttempts >= PLAY_ATTEMPTS) {
          playLoop = false;
          if (activated) {
            playAttempts = 0; // в плеер кликали — просто долго грузится; следующая синхронизация попробует снова
          } else if (!blockedReported) {
            blockedReported = true;
            on.blocked?.();
          }
          return;
        }
        playAttempts++;
        lastCommandAt = Date.now();
        send({ method: 'play' });
        playTimer = setTimeout(tryPlay, PLAY_RETRY_MS);
      };
      playTimer = setTimeout(tryPlay, Math.max(0, PLAY_AFTER_SEEK_MS - (Date.now() - lastSeekAt)));
    },
    pause() {
      clearTimeout(playTimer);
      playLoop = false;
      playAttempts = 0;
      lastCommandAt = Date.now();
      send({ method: 'pause' });
    },
    seek(s) {
      const sec = Math.max(0, Number(s) || 0);
      if (!contentStarted) {
        pendingSeek = sec > 1 ? sec : null;
        return;
      }
      setTime(sec);
      lastSeekAt = Date.now();
      send({ method: 'seek', seconds: sec });
    },
    setVolume(frac) {
      const vol = Math.round(Math.min(1, Math.max(0, frac)) * 100) / 100;
      if (vol === lastVolume) return; // приглушение под голос зовёт это каждые 100 мс
      lastVolume = vol;
      if (contentStarted) send({ method: 'volume', volume: vol });
    },
    // та же озвучка — переключаем серию без перезагрузки; другая ссылка — грузим её
    load(nextUrl, s, ep) {
      pendingSeek = null;
      playing = false;
      setTime(0);
      if (nextUrl === baseUrl && contentStarted && (s || ep)) {
        send({ method: 'change_episode', season: s || undefined, episode: ep || 1, without_reload: true });
        return;
      }
      baseUrl = nextUrl;
      iframe.src = withEpisode(nextUrl, s, ep);
    },
    destroy() {
      destroyed = true;
      clearTimeout(playTimer);
      window.removeEventListener('message', onMessage);
      try { iframe.src = 'about:blank'; } catch (_) {}
      iframe.remove();
    },
  };
  return api;
}
