(function () {
  'use strict';
  const P = window.PWLayout;
  const tr = (k, v) => window.t(k, v); // в этом файле t — частое имя переменной, поэтому перевод через tr
  const $ = (id) => document.getElementById(id);
  const root = $('proEditor');
  if (!P || !root) return;

  const stage = $('proStage');
  const menu = $('proMenu');
  const shapeMenu = $('proShapeMenu');

  let layout = null;
  let mode = 'profile';
  let tool = 'select';
  let selId = null;
  let dirty = false;
  let sd = {};

  const blocks = () => layout[mode].blocks;
  const find = (id) => blocks().find((b) => b.id === id);
  const uid = () => 'b' + Math.random().toString(36).slice(2, 9);
  const toast = (m, t = 'error') => showToast(t, m);
  const scale = () => parseFloat(stage.style.getPropertyValue('--s')) || 1;
  // ---------- история: Ctrl+Z / Ctrl+Y ----------
  const HIST_MAX = 60;
  let hist = [], hi = -1, savedHi = -1, lastT = 0, lastInputT = 0, lastSel = null;
  let fitOpen = false, menuId = null, phone = false;

  // копия макета: строки с картинками остаются общими по ссылке, память не растёт
  const cloneLayout = (l) => {
    const out = { v: l.v };
    for (const m of ['profile', 'live']) {
      out[m] = {
        blocks: l[m].blocks.map((b) => ({
          ...b,
          ...(b.st && { st: { ...b.st } }),
          ...(b.fit && { fit: { ...b.fit } }),
          ...(b.points && { points: b.points.map((p) => p.slice()) }),
        })),
      };
    }
    return out;
  };

  const snap = () => ({
    layout: cloneLayout(layout),
    banner: typeof pendingBannerBase64 === 'string' ? pendingBannerBase64 : undefined,
    avatar: typeof pendingAvatarBase64 === 'string' ? pendingAvatarBase64 : undefined,
  });

  function updateHistBtns() {
    $('proUndoBtn').disabled = hi <= 0;
    $('proRedoBtn').disabled = hi >= hist.length - 1;
  }

  // вызывается ПОСЛЕ изменения макета
  function touch() {
    const now = Date.now();
    // правки в меню «три точки» на одном блоке подряд (набор, ползунок) склеиваем в один шаг
    const merge = now - lastInputT < 60 && lastSel === selId && now - lastT < 800 &&
      hi === hist.length - 1 && hi > 0 && hi !== savedHi;
    if (merge) hist[hi] = snap();
    else {
      hist.length = hi + 1;
      hist.push(snap());
      if (hist.length > HIST_MAX) { hist.shift(); savedHi--; }
      hi = hist.length - 1;
    }
    lastT = now;
    lastSel = selId;
    dirty = hi !== savedHi;
    updateHistBtns();
  }

  function goHist(i) {
    if (i < 0 || i >= hist.length || i === hi) return;
    hi = i;
    const s = hist[i];
    layout = cloneLayout(s.layout);
    pendingBannerBase64 = s.banner;
    pendingAvatarBase64 = s.avatar;
    if (typeof s.banner === 'string') setPreview('banner', s.banner);
    if (typeof s.avatar === 'string') setPreview('avatar', s.avatar);
    if (selId && !find(selId)) selId = null;
    lastT = 0;
    lastInputT = 0;
    closeMenu();
    dirty = hi !== savedHi;
    renderStage();
    updateHistBtns();
  }
  const undo = () => goHist(hi - 1);
  const redo = () => goHist(hi + 1);

  menu.addEventListener('input', () => { lastInputT = Date.now(); }, true);

  document.addEventListener('keydown', (e) => {
    if (root.classList.contains('hidden') || fitOpen) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const a = document.activeElement;
    if (a && a.matches('textarea, input[type="text"], input[type="number"]')) return; // там родная отмена ввода
    if (e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.code === 'KeyY') { e.preventDefault(); redo(); }
  });

  const TITLES = Object.fromEntries(['banner', 'avatar', 'info', 'vods', 'player', 'chat', 'shape', 'text', 'image', 'link'].map((k) => [k, tr('editor.block.' + k)]));
  const SHAPE_OPTS = ['rect', 'circle', 'triangle'].map((k) => [k, tr('editor.shape.' + k)]);
  const FONT_OPTS = ['system', 'serif', 'mono', 'rounded', 'display'].map((k) => [k, tr('editor.font.' + k)]);

  // ---------- мелкие помощники для DOM ----------
  function E(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  }
  const row = (label, ctrl) => E('label', { className: 'pm-row' }, E('span', { textContent: label }), ctrl);
  const color = (v, fn) => E('input', { type: 'color', value: v, oninput: (e) => fn(e.target.value) });
  const numInput = (v, min, max, fn, step = 1) => E('input', {
    type: 'number', min, max, step, value: v,
    oninput: (e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) fn(Math.min(max, Math.max(min, n))); },
  });
  // value строго ПОСЛЕ min/max/step, иначе ползунок округлит значение по умолчанию
  const range = (v, min, max, step, fn) => E('input', { type: 'range', min, max, step, value: v, oninput: (e) => fn(parseFloat(e.target.value)) });
  const select = (opts, v, fn) => {
    const s = E('select', { onchange: (e) => fn(e.target.value) });
    for (const [k, t] of opts) s.appendChild(E('option', { value: k, textContent: t, selected: k === v }));
    return s;
  };
  const button = (text, fn, cls = '') => E('button', { type: 'button', className: 'pm-btn ' + cls, textContent: text, onclick: fn });

  function pickFile() {
    return new Promise((res) => {
      const i = E('input', { type: 'file', accept: 'image/*' });
      i.onchange = () => res(i.files[0] || null);
      i.click();
    });
  }

  // ---------- сцена ----------
  function builtinFill(b) {
    const f = E('div', { className: 'pw-fill ph-' + b.type });
    const setImg = (u) => { f.style.backgroundImage = `url("${u}")`; };
    if (b.type === 'banner') {
      const u = typeof pendingBannerBase64 === 'string' ? pendingBannerBase64 : sd.streamerBannerUrl;
      if (u) setImg(u);
      P.applyFit(f, b);
    } else if (b.type === 'avatar') {
      const u = typeof pendingAvatarBase64 === 'string' ? pendingAvatarBase64 : sd.streamerAvatarUrl;
      if (u) setImg(u); else f.textContent = (sd.streamerName || '?')[0].toUpperCase();
      P.paintShape(f, b);
      P.applyFit(f, b);
    } else if (b.type === 'info') {
      f.append(E('b', { textContent: sd.streamerName || '' }), E('span', { textContent: ($('bioInput').value || tr('editor.bioStub')).slice(0, 120) }));
    } else if (b.type === 'vods') {
      f.append(E('div', { textContent: tr('editor.block.vods') }), E('div', { className: 'ph-grid' + (b.o === 'v' ? ' ph-grid-v' : '') }, ...Array.from({ length: b.o === 'v' ? 4 : 6 }, () => E('i'))));
    } else if (b.type === 'player') {
      f.append(E('span', { textContent: tr('editor.stub.player') }));
    } else if (b.type === 'chat') {
      f.append(E('div', { className: 'ph-chat-h', textContent: tr('editor.stub.chat') }), ...[0, 1, 2, 3, 4].map(() => E('div', { className: 'ph-line' })));
    }
    return f;
  }

  function makeEl(b) {
    let el;
    if (P.defOf(mode, b.id)) {
      el = E('div', { className: 'pw-block pw-builtin pw-' + b.type }, builtinFill(b));
      P.applyVars(el, b);
    } else {
      el = P.buildEl(b, true);
    }
    el.classList.add('pw-ed');
    el.dataset.id = b.id;
    if (mode === 'live' && b.type === 'image') el.classList.add('pw-back');
    if (b.id === selId) el.classList.add('sel');

    const dots = E('button', { type: 'button', className: 'pw-dots', textContent: '⋯', title: tr('editor.blockSettings') });
    dots.addEventListener('pointerdown', (e) => e.stopPropagation());
    dots.addEventListener('click', (e) => { e.stopPropagation(); selId = b.id; stage.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); openMenu(b, dots); });
    const rsz = E('div', { className: 'pw-rsz' });
    rsz.addEventListener('pointerdown', (e) => startResize(e, b, el));
    el.append(dots, E('div', { className: 'pw-size' }), rsz);
    el.addEventListener('pointerdown', (e) => startMove(e, b, el));
    return el;
  }

  function renderStage() {
    applyStageSize();
    if (phone && mode === 'live') {
      stage.replaceChildren(mobileLiveMock());
      updateInfo();
      return;
    }
    stage.style.setProperty('--ch', P.canvasHeight(blocks()));
    stage.replaceChildren(...blocks().map(makeEl));
    fitScale();
    updateInfo();
    refreshMenu(); // три точки всегда показывают актуальные пункты
  }

  function curW() { return P.WM[mode]; }
  function fitScale() { stage.style.setProperty('--s', Math.min(1, stage.clientWidth / curW()) || 1); }
  function applyStageSize() {
    stage.classList.toggle('pw-phone', phone);
    stage.style.maxWidth = (phone ? 390 : curW()) + 'px';
    stage.style.height = phone && mode === 'live' ? 'auto' : '';
  }
  // на телефоне эфир показывается обычной вёрстке: плеер сверху, чат снизу
  function mobileLiveMock() {
    return E('div', { className: 'ph-m-live' },
      E('div', { className: 'pw-fill ph-player' }, E('span', { textContent: tr('editor.stub.player') })),
      E('div', { className: 'pw-fill ph-chat' }, E('div', { className: 'ph-chat-h', textContent: tr('editor.stub.chat') }), ...[0, 1, 2, 3, 4].map(() => E('div', { className: 'ph-line' }))));
  }
  function refreshMenu() {
    if (!menuId || menu.classList.contains('hidden')) return;
    const b = find(menuId);
    if (!b) return closeMenu();
    const a = document.activeElement;
    if (menu.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return; // не сбиваем ввод
    const top = menu.scrollTop;
    buildMenu(b);
    menu.scrollTop = top;
  }

  function updateInfo() {
    if (phone) {
      $('proInfo').textContent = mode === 'live'
        ? tr('editor.phone.live')
        : tr('editor.phone.profile');
      return;
    }
    const c = P.counts(blocks()), L = P.LIMITS[mode];
    $('proInfo').textContent = tr('editor.info', { c: c.custom, cm: L.custom, p: c.photos, pm: L.photos, l: c.links, lm: L.links }) +
      (mode === 'live' ? tr('editor.infoLive') : '');
  }

  new ResizeObserver(() => fitScale()).observe(stage);

  // ---------- перемещение и ресайз ----------
  function startMove(e, b, el) {
    if (tool !== 'select' || e.button > 0) return;
    e.preventDefault();
    selId = b.id;
    stage.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    const s = scale(), sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y;
    let moved = false;
    const mv = (ev) => {
      b.x = ox + (ev.clientX - sx) / s;
      b.y = oy + (ev.clientY - sy) / s;
      P.clampBlock(b, mode);
      P.applyVars(el, b);
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      if (moved) { touch(); stage.style.setProperty('--ch', P.canvasHeight(blocks())); }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up, { once: true });
  }

  function startResize(e, b, el) {
    if (tool !== 'select') return;
    e.preventDefault();
    e.stopPropagation();
    const s = scale(), sx = e.clientX, sy = e.clientY, ow = b.w, oh = b.h;
    const lab = el.querySelector('.pw-size');
    el.classList.add('resizing');
    lab.textContent = `${b.w}×${b.h}`;
    const mv = (ev) => {
      b.w = Math.min(ow + (ev.clientX - sx) / s, curW() - b.x);
      if (b.type !== 'chat') b.h = oh + (ev.clientY - sy) / s; // высота чата = высоте плеера
      P.clampBlock(b, mode);
      P.syncChat(blocks());
      P.applyVars(el, b);
      const fl = el.querySelector('.pw-fill');
      if (fl && (b.img || b.fit)) P.applyFit(fl, b);
      if (b.type === 'player') {
        const c = blocks().find((x) => x.type === 'chat');
        const ce = c && stage.querySelector(`[data-id="${c.id}"]`);
        if (ce) P.applyVars(ce, c);
      }
      lab.textContent = `${b.w}×${b.h}`; // размер показывается прямо во время ресайза
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      el.classList.remove('resizing');
      touch();
      renderStage();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up, { once: true });
  }

  // ---------- кнопки-ссылки и слои ----------
  function addLink() {
    if (!canAdd('link')) return;
    addBlock({ id: uid(), type: 'link', x: (curW() - 220) / 2, y: 80, w: 220, h: 64, fill: '#7c5cff', label: tr('editor.linkLabel'), url: '', shape: 'rect', lc: '#ffffff', lf: 18, rd: 12 });
  }

  function toLink(b) {
    if (P.counts(blocks()).links >= P.LIMITS[mode].links) return toast(tr('editor.max.links', { n: P.LIMITS[mode].links }));
    if (b.shape === 'poly') return toast(tr('editor.polyNoLink'));
    if (b.type === 'text') {
      const st = b.st;
      Object.assign(b, { label: String(b.text || '').slice(0, 40), lc: st.color, lf: Math.min(80, st.fs), fill: st.bg, rd: Math.min(100, st.radius), shape: 'rect' });
      delete b.text;
      delete b.st;
    }
    b.type = 'link';
    b.url = b.url || '';
    b.label = b.label || '';
    touch();
    renderStage();
  }

  function fromLink(b) {
    const L = P.LIMITS[mode], c = P.counts(blocks());
    if (b.img) {
      if (c.photos >= L.photos) return toast(tr('editor.max.photos', { n: L.photos }));
      b.type = 'image';
    } else {
      if (mode === 'live') return toast(tr('editor.liveNoShape'));
      if (c.custom >= L.custom) return toast(tr('editor.max.custom', { n: L.custom }));
      b.type = 'shape';
    }
    for (const k of ['url', 'label', 'lc', 'lf', 'rd']) delete b[k];
    touch();
    renderStage();
  }

  // порядок в списке = слои: последний лежит сверху
  function moveLayer(b, dir) {
    const rest = blocks().filter((x) => x !== b);
    layout[mode].blocks = dir > 0 ? rest.concat(b) : [b].concat(rest);
    P.fixOrder(layout[mode].blocks);
    if (b.type === 'avatar' && dir < 0) toast(tr('editor.avatarAbove'), 'info');
    touch();
    renderStage();
  }

  // ---------- инструменты ----------
  function setTool(t) {
    tool = t;
    stage.classList.toggle('cutting', t.startsWith('cut-'));
    stage.classList.toggle('drawing', t !== 'select');
    const active = t.startsWith('cut-') ? 'scissors' : t;
    root.querySelectorAll('.pro-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === active));
  }

  function canAdd(type) {
    const c = P.counts(blocks()), L = P.LIMITS[mode];
    if ((type === 'text' || type === 'shape') && c.custom >= L.custom) { toast(tr('editor.max.custom', { n: L.custom })); return false; }
    if (type === 'image' && c.photos >= L.photos) { toast(tr('editor.max.photos', { n: L.photos })); return false; }
    if (type === 'link' && c.links >= L.links) { toast(tr('editor.max.photoLinks', { n: L.links })); return false; }
    return true;
  }

  const defaultStyle = () => ({ color: '#ffffff', bg: '#000000', bgOpacity: 0.35, fs: 28, bold: false, italic: false, underline: false, align: 'left', va: 'top', font: 'system', radius: 8, pad: 10, bc: '#ffffff', bw: 0, ls: 0, shadow: false, opacity: 1 });

  function addBlock(b) {
    P.clampBlock(b, mode);
    blocks().push(b);
    selId = b.id;
    touch();
    setTool('select');
    renderStage();
    const dots = stage.querySelector(`[data-id="${b.id}"] .pw-dots`);
    if (dots) openMenu(b, dots);
  }

  async function addImage(kind) {
    if (!canAdd(kind)) return;
    const f = await pickFile();
    if (!f) return;
    try {
      const { url, w, h } = await P.imageToDataUrl(f, kind === 'link' ? 600 : 900);
      const bw = kind === 'link' ? 200 : Math.min(320, w);
      const bh = kind === 'link' ? 80 : Math.round((bw * h) / w);
      const b = { id: uid(), type: kind, x: (curW() - bw) / 2, y: 80, w: bw, h: bh, img: url, ia: +(w / h).toFixed(3), shape: 'rect' };
      if (kind === 'link') { b.url = ''; b.label = ''; }
      addBlock(b);
    } catch (err) { toast(err.message); }
  }

  // «зажал и вытянул»: текст и фигуры ножниц
  stage.addEventListener('pointerdown', (e) => {
    if (tool === 'select') {
      if (e.target === stage) { selId = null; closeMenu(); renderStage(); }
      return;
    }
    if (e.target.closest('.pw-dots')) return;
    e.preventDefault();

    const s = scale(), r = stage.getBoundingClientRect();
    const pt = (ev) => ({ x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s });
    const free = tool === 'cut-free';
    const p0 = pt(e), pts = [p0];
    let box = null, el, poly, lab;

    if (free) {
      const NS = 'http://www.w3.org/2000/svg';
      el = document.createElementNS(NS, 'svg');
      el.setAttribute('class', 'pw-draw-svg');
      poly = document.createElementNS(NS, 'polyline');
      poly.setAttribute('fill', 'rgba(236,72,153,.15)');
      poly.setAttribute('stroke', '#ec4899');
      poly.setAttribute('stroke-width', '2');
      el.appendChild(poly);
    } else {
      lab = E('div', { className: 'pw-size' });
      lab.style.display = 'block';
      el = E('div', { className: 'pw-draw' + (tool === 'cut-circle' ? ' round' : '') }, lab);
    }
    stage.appendChild(el);

    const mv = (ev) => {
      const p = pt(ev);
      if (free) {
        pts.push(p);
        poly.setAttribute('points', pts.map((q) => `${q.x * s},${q.y * s}`).join(' '));
      } else {
        box = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
        Object.assign(el.style, { left: box.x * s + 'px', top: box.y * s + 'px', width: box.w * s + 'px', height: box.h * s + 'px' });
        lab.textContent = `${Math.round(box.w)}×${Math.round(box.h)}`;
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      el.remove();
      finishDraw(free ? pts : null, box);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up, { once: true });
  });

  function finishDraw(pts, box) {
    if (pts) {
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      if (pts.length < 8 || w < 30 || h < 30) { toast(tr('editor.lineTooShort')); return; }
      const step = Math.max(1, Math.ceil(pts.length / 60));
      const points = pts.filter((_, i) => i % step === 0).map((p) => [+(((p.x - x) / w) * 100).toFixed(1), +(((p.y - y) / h) * 100).toFixed(1)]);
      box = { x, y, w, h, points };
    }
    if (!box || box.w < 24 || box.h < 20) return;

    const isText = tool === 'text';
    if (!canAdd(isText ? 'text' : 'shape')) { setTool('select'); return; }
    const b = { id: uid(), x: box.x, y: box.y, w: box.w, h: box.h };
    if (isText) { b.type = 'text'; b.text = tr('editor.block.text'); b.st = defaultStyle(); }
    else {
      b.type = 'shape';
      b.fill = '#b89bff';
      b.shape = { 'cut-circle': 'circle', 'cut-triangle': 'triangle', 'cut-free': 'poly' }[tool] || 'rect';
      if (box.points) b.points = box.points;
    }
    addBlock(b);
  }

  // ---------- меню «три точки» ----------
  function closeMenu() { menuId = null; menu.classList.add('hidden'); menu.replaceChildren(); }

  async function changeBuiltinPhoto(b) {
    const f = await pickFile();
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return toast(tr('editor.fileTooBig'));
    try {
      const { url, w, h } = await P.imageToDataUrl(f, b.type === 'banner' ? 1600 : 512);
      b.ia = +(w / h).toFixed(3);
      delete b.fit;
      if (b.type === 'banner') { pendingBannerBase64 = url; setPreview('banner', url); }
      else { pendingAvatarBase64 = url; setPreview('avatar', url); }
      touch();
      renderStage();
    } catch (err) { toast(err.message); }
  }

  async function setPhoto(b) {
    if (b.type === 'shape' && !b.img && P.counts(blocks()).photos >= P.LIMITS[mode].photos) return toast(tr('editor.max.photos', { n: P.LIMITS[mode].photos }));
    const f = await pickFile();
    if (!f) return;
    try {
      const r = await P.imageToDataUrl(f, b.type === 'link' ? 600 : 900);
      b.img = r.url;
      b.ia = +(r.w / r.h).toFixed(3);
      delete b.fit;
      touch();
      renderStage();
    } catch (err) { toast(err.message); }
  }

  function removeBlock(id) {
    const b = find(id);
    if (!b || P.defOf(mode, id)) return;
    layout[mode].blocks = blocks().filter((x) => x.id !== id);
    selId = null;
    closeMenu();
    touch();
    renderStage();
  }

  function openMenu(b, anchor) {
    menuId = b.id;
    buildMenu(b);
    place(anchor.closest('.pw-ed') || anchor);
  }

  // меню рядом с блоком: справа, а если не помещается, то слева
  function place(el) {
    const r = el.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    let left = r.right + 12;
    if (left + w > innerWidth - 8) left = r.left - w - 12;
    if (left < 8) left = Math.max(8, innerWidth - w - 8);
    menu.style.left = left + 'px';
    menu.style.top = Math.max(8, Math.min(innerHeight - h - 8, r.top)) + 'px';
  }

  function buildMenu(b) {
    const body = E('div', { className: 'pm-body' });
    const add = (...n) => body.append(...n);
    const set = (fn) => (v) => { fn(v); touch(); renderStage(); };
    const t = b.type;

    if (t === 'banner' || t === 'avatar') add(button(tr('editor.m.changePhoto'), () => changeBuiltinPhoto(b)));
    if (t === 'avatar') add(row(tr('editor.m.shape'), select(SHAPE_OPTS, b.shape, set((v) => (b.shape = v)))));

    if (t === 'shape') {
      if (b.shape !== 'poly') add(row(tr('editor.m.shape'), select(SHAPE_OPTS, b.shape, set((v) => (b.shape = v)))));
      add(row(tr('editor.m.fill'), color(b.fill, set((v) => (b.fill = v)))));
      add(button(b.img ? tr('editor.m.replacePhoto') : tr('editor.m.photoIntoShape'), () => setPhoto(b)));
      if (b.img) add(button(tr('editor.m.removePhoto'), () => { delete b.img; delete b.fit; delete b.ia; touch(); renderStage(); }, 'pm-flat'));
    }

    if (t === 'image') {
      add(button(tr('editor.m.replacePhoto'), () => setPhoto(b)));
      add(row(tr('editor.m.shape'), select(SHAPE_OPTS, b.shape, set((v) => (b.shape = v)))));
    }

    if (t === 'link') {
      add(button(tr('editor.m.replacePhoto'), () => setPhoto(b)));
      add(row(tr('editor.m.label'), E('input', { type: 'text', value: b.label || '', maxLength: 40, oninput: (e) => { b.label = e.target.value; touch(); renderStage(); } })));
      add(row(tr('editor.m.url'), E('input', { type: 'text', value: b.url || '', placeholder: 'https://…', maxLength: 500, oninput: (e) => { b.url = e.target.value.trim(); touch(); } })));
      add(E('div', { className: 'pm-hint', textContent: tr('editor.m.urlHint') }));
      add(row(tr('editor.m.shape'), select(SHAPE_OPTS, b.shape, set((v) => (b.shape = v)))));
      add(row(tr('editor.m.buttonColor'), color(b.fill || '#7c5cff', set((v) => (b.fill = v)))));
      if (b.img) add(button(tr('editor.m.removePhoto'), () => { delete b.img; delete b.fit; delete b.ia; touch(); renderStage(); }, 'pm-flat'));
      add(row(tr('editor.m.textColor'), color(b.lc || '#ffffff', set((v) => (b.lc = v)))));
      add(row(tr('editor.m.textSize'), numInput(b.lf || 16, 8, 80, set((v) => (b.lf = v)))));
      if ((b.shape || 'rect') === 'rect') add(row(tr('editor.m.radius'), numInput(b.rd || 0, 0, 100, set((v) => (b.rd = v)))));
    }

    if (t === 'text') {
      const st = b.st;
      add(E('textarea', { className: 'pm-area', value: b.text, maxLength: 1000, oninput: (e) => { b.text = e.target.value; touch(); renderStage(); } }));
      add(row(tr('editor.m.font'), select(FONT_OPTS, st.font, set((v) => (st.font = v)))));
      add(row(tr('editor.m.size'), numInput(st.fs, 8, 200, set((v) => (st.fs = v)))));
      add(row(tr('editor.m.textColor'), color(st.color, set((v) => (st.color = v)))));
      add(row(tr('editor.m.bgColor'), color(st.bg, set((v) => (st.bg = v)))));
      add(row(tr('editor.m.bgOpacity'), range(st.bgOpacity, 0, 1, 0.05, set((v) => (st.bgOpacity = v)))));
      add(E('div', { className: 'pm-seg' },
        ...['bold', 'italic', 'underline'].map((k) => [k, tr('editor.m.' + k)]).map(([k, l]) =>
          button(l, (e) => { st[k] = !st[k]; touch(); e.currentTarget.classList.toggle('on', st[k]); renderStage(); }, 'pm-flat' + (st[k] ? ' on' : '')))));
      add(row(tr('editor.m.hAlign'), select([['left', tr('editor.m.left')], ['center', tr('editor.m.center')], ['right', tr('editor.m.right')]], st.align, set((v) => (st.align = v)))));
      add(row(tr('editor.m.vAlign'), select([['top', tr('editor.m.top')], ['center', tr('editor.m.center')], ['bottom', tr('editor.m.bottom')]], st.va, set((v) => (st.va = v)))));
      add(row(tr('editor.m.radius'), numInput(st.radius, 0, 200, set((v) => (st.radius = v)))));
      add(row(tr('editor.m.pad'), numInput(st.pad, 0, 60, set((v) => (st.pad = v)))));
      add(row(tr('editor.m.borderColor'), color(st.bc, set((v) => (st.bc = v)))));
      add(row(tr('editor.m.borderWidth'), numInput(st.bw, 0, 12, set((v) => (st.bw = v)))));
      add(row(tr('editor.m.letterSpacing'), numInput(st.ls, -2, 20, set((v) => (st.ls = v)), 0.5)));
      add(row(tr('editor.m.textShadow'), E('input', { type: 'checkbox', checked: st.shadow, onchange: (e) => { st.shadow = e.target.checked; touch(); renderStage(); } })));
      add(row(tr('editor.m.opacity'), range(st.opacity, 0.1, 1, 0.05, set((v) => (st.opacity = v)))));
    }

    if (t === 'banner' || t === 'avatar' || b.img) add(button(tr('editor.fit.title'), () => openFit(b), 'pm-flat'));
    if (t === 'vods') add(button(b.o === 'v' ? tr('editor.m.horizontal') : tr('editor.m.vertical'), () => { b.o = b.o === 'v' ? 'h' : 'v'; touch(); renderStage(); }, 'pm-flat'));
    if (t === 'shape' || t === 'image' || t === 'text') add(button(tr('editor.m.toLink'), () => toLink(b), 'pm-flat'));
    if (t === 'link') add(button(tr('editor.m.fromLink'), () => fromLink(b), 'pm-flat'));
    if (t !== 'avatar' && t !== 'banner' && !(t === 'image' && mode === 'live')) {
      add(button(tr('editor.m.front'), () => moveLayer(b, 1), 'pm-flat'));
      add(button(tr('editor.m.back'), () => moveLayer(b, -1), 'pm-flat'));
    }

    if (P.defOf(mode, b.id)) {
      add(button(tr('editor.m.resetPlace'), () => {
        Object.assign(b, P.clone(P.defOf(mode, b.id)));
        P.syncChat(blocks());
        touch(); renderStage(); closeMenu();
      }, 'pm-flat'));
      if (t === 'player' || t === 'chat') add(E('div', { className: 'pm-hint', textContent: t === 'player' ? tr('editor.m.playerHint') : tr('editor.m.chatHint') }));
    } else {
      add(button(tr('editor.m.delete'), () => removeBlock(b.id), 'pm-danger'));
    }

    menu.replaceChildren(E('div', { className: 'pm-title', textContent: TITLES[t] || tr('editor.block.default') }), body);
    menu.classList.remove('hidden');
  }

  // ---------- подгон фото ----------
  const FIT0 = { m: 'cover', z: 1, x: 50, y: 50 };
  const FIT_MODES = ['cover', 'contain', 'stretch'].map((k) => [k, tr('editor.fit.' + k)]);
  const clamp = (v, a, z) => Math.min(z, Math.max(a, v));

  function photoUrl(b) {
    if (b.type === 'banner') return typeof pendingBannerBase64 === 'string' ? pendingBannerBase64 : sd.streamerBannerUrl;
    if (b.type === 'avatar') return typeof pendingAvatarBase64 === 'string' ? pendingAvatarBase64 : sd.streamerAvatarUrl;
    return b.img;
  }

  async function openFit(b) {
    const url = photoUrl(b);
    if (!url) return toast(tr('editor.fit.noPhoto'));
    const im = new Image();
    im.src = url;
    try { await im.decode(); } catch { return toast(tr('editor.fit.openFailed')); }
    closeMenu();

    const prevFit = b.fit ? { ...b.fit } : undefined;
    const prevIa = b.ia;
    b.ia = +(im.naturalWidth / im.naturalHeight).toFixed(3);
    const fit = (b.fit = { ...FIT0, ...(prevFit || {}) });

    // окно предпросмотра: блок в уменьшенном виде + тусклое фото вокруг него
    const AW = 360, AH = 280;
    const ps = Math.min(220 / b.w, 160 / b.h, 3);
    const bw = b.w * ps, bh = b.h * ps;
    const wx = (AW - bw) / 2, wy = (AH - bh) / 2;

    const ghost = E('img', { src: url, draggable: false, className: 'fit-img fit-ghost' });
    const live = E('img', { src: url, draggable: false, className: 'fit-img' });
    const win = E('div', { className: 'fit-win' }, live);
    Object.assign(win.style, { left: wx + 'px', top: wy + 'px', width: bw + 'px', height: bh + 'px' });
    P.paintShape(win, b); // у окна та же форма, что у блока (круг, треугольник, линия…)
    const area = E('div', { className: 'fit-area' }, ghost, win);

    const info = E('div', { className: 'pm-hint' });
    const modeBtns = FIT_MODES.map(([m, t]) => button(t, () => { fit.m = m; draw(); }, 'pm-flat'));
    const zoom = range(fit.z, 1, 5, 0.05, (v) => { fit.z = v; draw(); });

    function draw() {
      const r = P.fitRect(fit, b.ia, b.w, b.h);
      Object.assign(live.style, { width: r.w * ps + 'px', height: r.h * ps + 'px', left: r.l * ps + 'px', top: r.t * ps + 'px' });
      Object.assign(ghost.style, { width: r.w * ps + 'px', height: r.h * ps + 'px', left: wx + r.l * ps + 'px', top: wy + r.t * ps + 'px' });
      zoom.value = fit.z;
      modeBtns.forEach((btn, i) => btn.classList.toggle('on', FIT_MODES[i][0] === fit.m));
      const full = Math.abs(r.w - b.w) < 1 && Math.abs(r.h - b.h) < 1;
      info.textContent = tr('editor.fit.info', { w: b.w, h: b.h, z: Math.round(fit.z * 100) }) +
        (fit.m === 'contain' ? tr('editor.fit.whole') : full ? tr('editor.fit.noCrop') : tr('editor.fit.cropped'));
      const f = stage.querySelector(`[data-id="${b.id}"] .pw-fill`);
      if (f) P.applyFit(f, b); // блок на сцене меняется вместе с окном
    }

    area.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, r0 = P.fitRect(fit, b.ia, b.w, b.h);
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / ps, dy = (ev.clientY - sy) / ps;
        if (Math.abs(b.w - r0.w) > 0.5) fit.x = clamp(((r0.l + dx) / (b.w - r0.w)) * 100, 0, 100);
        if (Math.abs(b.h - r0.h) > 0.5) fit.y = clamp(((r0.t + dy) / (b.h - r0.h)) * 100, 0, 100);
        draw();
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        fit.x = Math.round(fit.x * 10) / 10;
        fit.y = Math.round(fit.y * 10) / 10;
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up, { once: true });
    });
    area.addEventListener('wheel', (e) => {
      e.preventDefault();
      fit.z = clamp(+(fit.z - e.deltaY * 0.002).toFixed(2), 1, 5);
      draw();
    }, { passive: false });

    const finish = (ok) => {
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      fitOpen = false;
      if (ok) {
        if (JSON.stringify(fit) === JSON.stringify(FIT0)) delete b.fit; // стандартный подгон не храним
        if (JSON.stringify(b.fit) !== JSON.stringify(prevFit)) touch(); // один шаг истории на всё окно
      } else {
        if (prevFit) b.fit = prevFit; else delete b.fit;
        if (prevIa) b.ia = prevIa; else delete b.ia;
      }
      renderStage();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };

    const panel = E('div', { className: 'pro-fit' },
      E('div', { className: 'pm-title', textContent: tr('editor.fit.title') }),
      area,
      info,
      E('div', { className: 'pm-seg' }, ...modeBtns),
      row(tr('editor.fit.zoom'), zoom),
      E('div', { className: 'pm-hint', textContent: tr('editor.fit.hint') }),
      E('div', { className: 'pm-seg' },
        button(tr('editor.fit.reset'), () => { Object.assign(fit, FIT0); draw(); }, 'pm-flat'),
        button(tr('common.dialog.cancel'), () => finish(false), 'pm-flat'),
        button(tr('editor.fit.done'), () => finish(true))));
    const back = E('div', { className: 'pro-fit-back' }, panel);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) finish(false); });

    fitOpen = true;
    window.addEventListener('keydown', onKey, true);
    root.appendChild(back);
    draw();
  }

  // ---------- верхняя панель ----------
  root.querySelectorAll('[data-tool]').forEach((btn) => btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    if (phone) return toast(tr('editor.phoneReadOnly'));
    shapeMenu.classList.add('hidden');
    closeMenu();
    if (t === 'scissors') {
      if (mode === 'live') return;
      const r = btn.getBoundingClientRect();
      shapeMenu.style.left = r.left + 'px';
      shapeMenu.style.top = r.bottom + 6 + 'px';
      shapeMenu.classList.toggle('hidden');
      return;
    }
    if (t === 'image') return addImage('image');
    if (t === 'link') return addLink();
    setTool(t);
  }));

  shapeMenu.querySelectorAll('[data-cut]').forEach((b) => b.addEventListener('click', () => {
    shapeMenu.classList.add('hidden');
    setTool('cut-' + b.dataset.cut);
  }));

  function syncModeButtons() {
    root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode && (b.dataset.phone === '1') === phone));
    $('proScissors').disabled = mode === 'live' || phone;
  }
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    phone = b.dataset.phone === '1';
    selId = null;
    closeMenu();
    setTool('select');
    syncModeButtons();
    renderStage();
  }));

  root.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target) && !e.target.closest('.pw-dots')) closeMenu();
    if (!shapeMenu.contains(e.target) && !e.target.closest('#proScissors')) shapeMenu.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if (root.classList.contains('hidden')) return;
    if (e.key === 'Escape') { closeMenu(); shapeMenu.classList.add('hidden'); setTool('select'); }
    else if (e.key === 'Delete' && selId && !fitOpen && !menu.contains(document.activeElement) &&
      !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) removeBlock(selId);
  });

  // ---------- открыть / сохранить / закрыть ----------
  async function open() {
    const name = $('currentStreamerName').textContent.trim();
    sd = { streamerName: name, ...(window.__streamerData || {}) };
    try {
      const r = await api('/streamers/' + encodeURIComponent(name.toLowerCase()) + '/layout');
      layout = P.withDefaults(r.layout);
    } catch (err) {
      return toast(err.message || tr('editor.loadFailed'));
    }
    mode = 'profile';
    phone = false;
    hist = [snap()]; hi = 0; savedHi = 0; dirty = false; lastT = 0; lastInputT = 0;
    updateHistBtns();
    selId = null;
    syncModeButtons();
    setTool('select');
    root.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderStage();
  }

  async function closeEditor() {
    if (dirty && !(await PW.confirm(tr('editor.leave.text'), { title: tr('editor.leave.title'), okText: tr('editor.leave.ok'), danger: true }))) return;
    closeMenu();
    goToOwnProfile();
  }

  async function save() {
    for (const m of ['profile', 'live']) {
      for (const b of layout[m].blocks) {
        if (b.type === 'link' && b.url && !/^https?:\/\//i.test(b.url)) return toast(tr('editor.badUrl'));
      }
    }
    try {
      await api('/streamers/me/layout', { method: 'PUT', body: { layout } });
      const patch = {};
      if (typeof pendingAvatarBase64 === 'string') patch.streamerAvatarUrl = pendingAvatarBase64;
      if (typeof pendingBannerBase64 === 'string') patch.streamerBannerUrl = pendingBannerBase64;
      if (Object.keys(patch).length) await api('/streamers/me', { method: 'PATCH', body: patch });
      savedHi = hi;
      dirty = false;
      toast(tr('editor.layoutSaved'), 'success');
    } catch (err) { toast(err.message || tr('editor.saveFailed')); }
  }

  async function resetLayout() {
    if (!(await PW.confirm(tr('editor.resetConfirm.text'), { title: tr('editor.resetConfirm.title'), okText: tr('editor.fit.reset'), danger: true }))) return;
    try {
      await api('/streamers/me/layout', { method: 'PUT', body: { layout: null } });
      layout = P.withDefaults(null);
      hist = [snap()]; hi = 0; savedHi = 0; dirty = false;
      updateHistBtns();
      selId = null;
      closeMenu();
      renderStage();
    } catch (err) { toast(err.message || tr('editor.resetFailed')); }
  }

  $('openProBtn').addEventListener('click', open);
  $('proUndoBtn').addEventListener('click', undo);
  $('proRedoBtn').addEventListener('click', redo);
  $('proSaveBtn').addEventListener('click', save);
  $('proCloseBtn').addEventListener('click', closeEditor);
  $('proResetBtn').addEventListener('click', resetLayout);
})();