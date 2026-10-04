// Не даёт экрану и компьютеру уснуть, пока у страницы есть хотя бы одна «причина» (video, voice, live...).
// Использование: PWWake.set('video', true) — включить, PWWake.set('video', false) — выключить.
(function () {
  if (window.PWWake) return;

  const reasons = new Set();
  let lock = null;
  let busy = false;
  let again = false;

  async function apply() {
    if (!('wakeLock' in navigator)) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        if (reasons.size === 0) {
          if (lock) {
            const l = lock;
            lock = null;
            try { await l.release(); } catch (_) {}
          }
        } else if (!lock && document.visibilityState === 'visible') {
          try {
            const l = await navigator.wakeLock.request('screen');
            lock = l;
            l.addEventListener('release', () => { if (lock === l) lock = null; });
          } catch (_) {}
        }
      } while (again);
    } finally {
      busy = false;
    }
  }

  function set(reason, on) {
    if (on) reasons.add(reason);
    else reasons.delete(reason);
    apply(); // безопасно вызывать часто: если всё уже в порядке, ничего не делает
  }

  // браузер сам снимает блокировку, когда вкладка скрыта; вернулись на вкладку — берём снова
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') apply();
  });

  window.PWWake = { set };
})();