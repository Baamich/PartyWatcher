// Плеер VK Видео в комнате: iframe video_ext.php?…&js_api=1 + управление через postMessage.
// Протокол (как в их vk.com/js/api/videoplayer.js, сам скрипт не грузим):
// шлём { method: 'init' } → iframe отвечает event 'inited'; до этого команды копятся в очереди.
// Команды: play, pause, seek { time }, set_volume { volume 0..1 }. В каждом ответе iframe — его
// состояние (state, time, duration…) и event: timeupdate, started, resumed, paused, seeked, ended, error.
// Интерфейс тот же, что у плеера Kodik (js/kodik/player.js): комната работает с ними одинаково.

const MAX_EXTRAPOLATE_S = 2;

export function createVkPlayer(container, { url, volume, on = {} }) {
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock';
  iframe.allowFullscreen = true;
  iframe.style.cssText = 'width:100%;height:100%;border:0';
  iframe.src = url;
  container.appendChild(iframe);

  let inited = false;
  let queue = [];
  let origin = '*';
  let time = 0;
  let timeAt = 0;
  let playing = false;
  let started = false; // видео хоть раз пошло — позиции можно верить
  let startedAt = 0;
  let lastVolume = typeof volume === 'number' ? volume : null;
  let destroyed = false;
  // наше видео «oid_id»: по нему узнаём, что VK после конца ролика сам включил рекомендацию
  const ownId = (url.match(/[?&]oid=(-?\d+)&id=(\d+)/) || []).slice(1).join('_');
  let restoredAt = 0;

  const post = (msg) => {
    try { iframe.contentWindow?.postMessage(msg, origin); } catch (_) {}
  };
  const send = (msg) => {
    if (inited) post(msg);
    else queue.push(msg);
  };
  const setTime = (s) => {
    time = s;
    timeAt = Date.now();
  };

  function onMessage(e) {
    if (destroyed || e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.event !== 'string') return;
    if (origin === '*') origin = e.origin; // дальше шлём только на домен VK
    if (typeof d.time === 'number') setTime(d.time);

    switch (d.event) {
      case 'inited':
        // VK по окончании ролика перезагружает iframe со следующим рекомендованным видео —
        // в комнате это разъехалось бы у всех: возвращаем своё (не чаще раза в 10 с, чтобы не зациклиться)
        if (ownId && d.videoId && String(d.videoId) !== ownId && Date.now() - restoredAt > 10000) {
          restoredAt = Date.now();
          iframe.src = url;
          return;
        }
        inited = true;
        if (lastVolume !== null) post({ method: 'set_volume', volume: lastVolume });
        queue.splice(0).forEach(post);
        break;
      case 'started':
      case 'resumed':
        if (!started) {
          started = true;
          startedAt = Date.now();
        }
        playing = true;
        on.play?.();
        break;
      case 'paused':
        playing = false;
        on.pause?.();
        break;
      case 'ended':
      case 'error':
        playing = false;
        break;
      case 'seeked':
        on.seek?.();
        break;
    }
  }
  window.addEventListener('message', onMessage);
  // новая страница в iframe — заново init (иначе команды уйдут в пустоту)
  iframe.addEventListener('load', () => {
    inited = false;
    playing = false;
    started = false;
    origin = '*';
    post({ method: 'init' });
  });

  return {
    iframe,
    get url() { return url; },
    getCurrentTime() {
      if (!playing) return time;
      return time + Math.min(MAX_EXTRAPOLATE_S, (Date.now() - timeAt) / 1000);
    },
    isPlaying() { return playing; },
    isReady() { return started && Date.now() - startedAt > 1500; },
    play() { send({ method: 'play' }); },
    pause() { send({ method: 'pause' }); },
    seek(s) {
      const sec = Math.max(0, Number(s) || 0);
      setTime(sec);
      send({ method: 'seek', time: sec });
    },
    setVolume(frac) {
      const vol = Math.round(Math.min(1, Math.max(0, frac)) * 100) / 100;
      if (vol === lastVolume) return; // приглушение под голос зовёт это каждые 100 мс
      lastVolume = vol;
      if (inited) post({ method: 'set_volume', volume: vol });
    },
    destroy() {
      destroyed = true;
      queue = [];
      window.removeEventListener('message', onMessage);
      try { iframe.src = 'about:blank'; } catch (_) {}
      iframe.remove();
    },
  };
}
