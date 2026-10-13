// Окна-карточки на холсте студии (🔔 События, 🎁 Награды): двигать за заголовок, тянуть за угол, × — скрыть.
// Не заезжают под меню слева, панель сверху и галочки справа. Раскладку отдаёт onLayout (страница сохраняет её сама)
(function () {
  if (window.PWCanvasWindows) return;

  function create({ canvas, picker, topBar, defRect, minW = 220, minH = 200, onLayout, onClose }) {
    let panels = {};
    const wins = new Map(); // id → элемент

    const topMin = () => (topBar ? topBar.offsetTop + topBar.offsetHeight + 12 : 0);
    function clampPos(el, left, top) {
      left = Math.max(0, left);
      top = Math.max(0, top);
      const nav = document.getElementById('wbNavFixed');
      if (nav && left < nav.offsetWidth + 8 && top < nav.offsetHeight) left = nav.offsetWidth + 20;
      if (left >= (nav ? nav.offsetWidth : 0)) top = Math.max(top, topMin());
      if (picker) left = Math.min(left, Math.max(0, picker.offsetLeft - el.offsetWidth - 12));
      return { left, top };
    }

    function fit() {
      let bottom = 900;
      wins.forEach((w) => { bottom = Math.max(bottom, w.offsetTop + w.offsetHeight + 40); });
      if (picker) bottom = Math.max(bottom, picker.offsetTop + picker.offsetHeight + 40);
      canvas.style.minHeight = bottom + 'px';
    }

    const rectOf = (id) => panels[id] || defRect(id);
    const readRect = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

    function makeMovable(el, id) {
      const head = el.querySelector('.wb-window-titlebar');
      const rsz = el.querySelector('.wb-resize-handle');
      let mode = null, sx = 0, sy = 0, a = 0, b = 0;
      const done = () => {
        if (!mode) return;
        mode = null;
        el.classList.remove('dragging');
        panels[id] = readRect(el);
        fit();
        onLayout?.(panels);
      };
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, select, label')) return;
        mode = 'move'; sx = e.clientX; sy = e.clientY; a = el.offsetLeft; b = el.offsetTop;
        el.classList.add('dragging');
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (mode !== 'move') return;
        const p = clampPos(el, a + e.clientX - sx, b + e.clientY - sy);
        el.style.left = p.left + 'px';
        el.style.top = p.top + 'px';
      });
      head.addEventListener('pointerup', done);
      head.addEventListener('pointercancel', done);
      rsz.addEventListener('pointerdown', (e) => {
        mode = 'size'; sx = e.clientX; sy = e.clientY; a = el.offsetWidth; b = el.offsetHeight;
        rsz.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      rsz.addEventListener('pointermove', (e) => {
        if (mode !== 'size') return;
        const maxW = picker ? picker.offsetLeft - el.offsetLeft - 12 : 2000;
        el.style.width = Math.min(maxW, Math.max(minW, a + e.clientX - sx)) + 'px';
        el.style.height = Math.max(minH, b + e.clientY - sy) + 'px';
      });
      rsz.addEventListener('pointerup', done);
      rsz.addEventListener('pointercancel', done);
    }

    // окно: возвращает { el, title, content } — страница сама наполняет заголовок и содержимое
    function open(id, cls = '') {
      if (wins.has(id)) return parts(wins.get(id));
      const el = document.createElement('div');
      el.className = 'wb-window cw-window ' + cls;
      el.dataset.id = id;
      el.innerHTML = `<div class="wb-window-titlebar"><span class="cw-title"></span><span class="cw-head-right"></span>
        <button type="button" class="cw-close">×</button></div><div class="wb-window-content"></div><div class="wb-resize-handle"></div>`;
      el.querySelector('.cw-close').addEventListener('click', () => onClose?.(id));
      const r = rectOf(id);
      Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      canvas.appendChild(el);
      wins.set(id, el);
      makeMovable(el, id);
      fit();
      return parts(el);
    }
    const parts = (el) => ({ el, title: el.querySelector('.cw-title'), right: el.querySelector('.cw-head-right'), close: el.querySelector('.cw-close'), content: el.querySelector('.wb-window-content') });

    function close(id) {
      wins.get(id)?.remove();
      wins.delete(id);
      fit();
    }

    // окно браузера поменяло размер: карточки, которые ещё не двигали, встают на новые места по умолчанию
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        wins.forEach((el, id) => {
          if (panels[id]) return;
          const r = defRect(id);
          Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        });
        fit();
      }, 200);
    });

    return {
      setPanels(p) { panels = p && typeof p === 'object' ? { ...p } : {}; },
      resetPanels() { panels = {}; wins.forEach((el, id) => { const r = defRect(id); Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); }); fit(); },
      open, close, has: (id) => wins.has(id), get: (id) => (wins.has(id) ? parts(wins.get(id)) : null), ids: () => [...wins.keys()], fit,
    };
  }

  // места по умолчанию: сетка карточек от меню до галочек, ниже панели сверху
  function gridRect({ index, picker, topBar, w = 300, h = 340, gap = 14, x0 = 220 }) {
    const y0 = topBar ? topBar.offsetTop + topBar.offsetHeight + 14 : 0;
    const avail = (picker?.offsetLeft || 1300) - 12 - x0;
    const cols = Math.max(1, Math.floor((avail + gap) / (w + gap)));
    return { x: x0 + (index % cols) * (w + gap), y: y0 + Math.floor(index / cols) * (h + gap), w, h };
  }

  window.PWCanvasWindows = { create, gridRect };
})();
