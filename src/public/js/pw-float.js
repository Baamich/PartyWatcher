// Мини-пульт стримера «📌 Поверх окон» (студия): время эфира, зрители, чат, события, кнопки виджетов.
// Chrome / Edge / Opera / Яндекс на компьютере — Document Picture-in-Picture: окно висит поверх всех программ,
// внутри — /workbench/float.html во фрейме. Без поддержки — обычное маленькое окно (не поверх остальных).
// Размер окна помним в localStorage (pw_float_size)
(function () {
  if (window.PWFloat) return;
  const LS = 'pw_float_size';
  const PAGE = '/workbench/float.html';
  let pip = null;

  function size() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || 'null');
      if (s && s.w >= 260 && s.w <= 1200 && s.h >= 240 && s.h <= 1400) return s;
    } catch (_) {}
    return { w: 360, h: 560 };
  }
  function remember(win) {
    try { localStorage.setItem(LS, JSON.stringify({ w: win.innerWidth, h: win.innerHeight })); } catch (_) {}
  }

  async function open() {
    if (pip) { try { pip.focus(); } catch (_) {} return; }
    const s = size();
    if ('documentPictureInPicture' in window) {
      try {
        const win = await window.documentPictureInPicture.requestWindow({ width: s.w, height: s.h });
        pip = win;
        const d = win.document;
        d.title = t('common.float.title');
        const st = d.createElement('style');
        st.textContent = 'html,body{margin:0;height:100%;background:#0e0e12;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}';
        d.head.appendChild(st);
        const f = d.createElement('iframe');
        f.src = PAGE + '?pip=1';
        f.allow = 'clipboard-write; autoplay';
        d.body.appendChild(f);
        let rt = null;
        win.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => remember(win), 400); });
        win.addEventListener('pagehide', () => { remember(win); pip = null; });
        return;
      } catch (_) {
        pip = null; // браузер не дал (не по клику, политика) — обычное окно
      }
    }
    const w = window.open(PAGE, 'pwfloat', `popup,width=${s.w},height=${s.h}`);
    if (!w) return window.PW?.toast(t('common.float.blocked'), 'error');
    window.PW?.toast(t('common.float.noPip'), 'info');
  }

  window.PWFloat = { open, supported: 'documentPictureInPicture' in window };
  window.pwOpenFloat = open; // для data-click в разметке
})();
