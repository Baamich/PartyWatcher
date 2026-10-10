(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PWLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 1100;
  const MAX_H = 4000;
  const DEFAULTS = {
    profile: [
      { id: 'banner', type: 'banner', x: 0, y: 0, w: 1100, h: 220 },
      { id: 'avatar', type: 'avatar', x: 20, y: 172, w: 120, h: 120, shape: 'circle' },
      { id: 'info', type: 'info', x: 160, y: 232, w: 600, h: 90 },
      { id: 'vods', type: 'vods', x: 0, y: 340, w: 1100, h: 320 },
    ],
    live: [
      { id: 'player', type: 'player', x: 0, y: 0, w: 764, h: 430 },
      { id: 'chat', type: 'chat', x: 780, y: 0, w: 320, h: 430 },
    ],
  };
  const WM = { profile: 1100, live: 1600 }; // ширина холста по режимам

  // ошибка с ключом словаря: в браузере текст сразу переведён, на сервере роут переводит по e.i18nKey
  function layoutError(key, vars) {
    const g = typeof window !== 'undefined' ? window : null;
    const e = new Error(g && g.t ? g.t('layout.err.' + key, vars) : key);
    e.i18nKey = 'layout.err.' + key;
    e.vars = vars;
    return e;
  }
  const LIMITS = {
    profile: { custom: 12, photos: 4, links: 12 },
    live: { custom: 8, photos: 2, links: 6 },
  };
  const CUSTOM_TYPES = { profile: ['shape', 'text', 'image', 'link'], live: ['text', 'image', 'link'] };
  const FONTS = {
    system: 'inherit',
    serif: 'Georgia, serif',
    mono: '"Courier New", monospace',
    rounded: '"Trebuchet MS", sans-serif',
    display: 'Impact, "Arial Black", sans-serif',
  };
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMG_CHARS = 900000;
  const SIMPLE_SHAPES = ['rect', 'circle', 'triangle'];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, min, max, d) => {
    v = Number(v);
    if (!Number.isFinite(v)) return d;
    return Math.min(max, Math.max(min, v));
  };
  const defOf = (mode, id) => DEFAULTS[mode].find((d) => d.id === id);

  function minSize(b, mode) {
    const d = defOf(mode, b.id);
    if (d) {
      if (d.type === 'player') { const w = Math.ceil(d.w * 0.9); return { w, h: Math.ceil((w * 9) / 16) }; }
      if (d.type === 'chat') return { w: 320, h: 1 };
      return { w: Math.ceil(d.w * 0.6), h: Math.ceil(d.h * 0.6) }; // базовые блоки можно уменьшать до 60%
    }
    return { w: 40, h: 24 };
  }

  function clampBlock(b, mode) {
    const W = WM[mode] || 1100;
    const min = minSize(b, mode);
    b.w = Math.round(num(b.w, min.w, W, min.w));
    b.h = Math.round(num(b.h, min.h, MAX_H, min.h));
    if (b.type === 'avatar') b.h = b.w;
    if (b.type === 'player') b.h = Math.round((b.w * 9) / 16);
    b.x = Math.round(num(b.x, 0, W - b.w, 0));
    b.y = Math.round(num(b.y, 0, MAX_H, 0));
    return b;
  }

  // аватар всегда выше баннера: если он в списке раньше, ставим сразу за баннером
  function fixOrder(blocks) {
    const bi = blocks.findIndex((b) => b.type === 'banner');
    const ai = blocks.findIndex((b) => b.type === 'avatar');
    if (bi >= 0 && ai >= 0 && ai < bi) {
      const [a] = blocks.splice(ai, 1);
      blocks.splice(bi, 0, a);
    }
  }

  function syncChat(blocks) {
    const p = blocks.find((b) => b.type === 'player');
    const c = blocks.find((b) => b.type === 'chat');
    if (p && c) c.h = p.h;
  }

  function counts(blocks) {
    let custom = 0, photos = 0, links = 0;
    for (const b of blocks) {
      if (b.type === 'shape' || b.type === 'text') custom++;
      if (b.type === 'image' || (b.type === 'shape' && b.img)) photos++;
      if (b.type === 'link') links++;
    }
    return { custom, photos, links };
  }

  function withDefaults(raw) {
    const out = { v: 1 };
    for (const mode of ['profile', 'live']) {
      const src = Array.isArray(raw?.[mode]?.blocks) ? raw[mode].blocks : [];
      const blocks = clone(src);
      for (const d of DEFAULTS[mode]) if (!blocks.some((b) => b.id === d.id)) blocks.unshift(clone(d));
      blocks.forEach((b) => clampBlock(b, mode));
      fixOrder(blocks);
      syncChat(blocks);
      out[mode] = { blocks };
    }
    return out;
  }

  function cleanStyle(s) {
    s = s && typeof s === 'object' ? s : {};
    const col = (v, d) => (COLOR_RE.test(v) ? v : d);
    return {
      color: col(s.color, '#ffffff'), bg: col(s.bg, '#000000'), bgOpacity: num(s.bgOpacity, 0, 1, 0),
      fs: Math.round(num(s.fs, 8, 200, 24)), bold: !!s.bold, italic: !!s.italic, underline: !!s.underline,
      align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
      va: ['top', 'center', 'bottom'].includes(s.va) ? s.va : 'top',
      font: FONTS[s.font] ? s.font : 'system',
      radius: Math.round(num(s.radius, 0, 200, 0)), pad: Math.round(num(s.pad, 0, 60, 8)),
      bc: col(s.bc, '#ffffff'), bw: Math.round(num(s.bw, 0, 12, 0)),
      ls: num(s.ls, -2, 20, 0), shadow: !!s.shadow, opacity: num(s.opacity, 0.1, 1, 1),
    };
  }

  const FIT_TYPES = ['banner', 'avatar', 'shape', 'image', 'link'];
  const FIT0 = { m: 'cover', z: 1, x: 50, y: 50 };

  function cleanFit(f) {
    if (!f || typeof f !== 'object') return null;
    return {
      m: ['cover', 'contain', 'stretch'].includes(f.m) ? f.m : 'cover',
      z: Math.round(num(f.z, 1, 5, 1) * 100) / 100,
      x: Math.round(num(f.x, 0, 100, 50) * 10) / 10,
      y: Math.round(num(f.y, 0, 100, 50) * 10) / 10,
    };
  }

  function cleanBlock(b, mode) {
    if (!b || typeof b !== 'object') return null;
    const id = String(b.id || '');
    if (!/^[\w-]{1,40}$/.test(id)) return null;
    const d = defOf(mode, id);
    const type = d ? d.type : String(b.type);
    if (!d && !CUSTOM_TYPES[mode].includes(type)) return null;

    const o = { id, type, x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) };
    if (!d) {
      if (!Number.isFinite(o.w)) o.w = 200;
      if (!Number.isFinite(o.h)) o.h = 100;
    }
    clampBlock(o, mode);

    if (type === 'avatar') o.shape = SIMPLE_SHAPES.includes(b.shape) ? b.shape : 'circle';
    if (type === 'vods') o.o = b.o === 'v' ? 'v' : 'h'; // вертикальный или горизонтальный список записей

    if (type === 'shape') {
      if (b.shape === 'poly') {
        const pts = Array.isArray(b.points)
          ? b.points.slice(0, 60).map((p) => [Math.round(num(p?.[0], 0, 100, 0) * 10) / 10, Math.round(num(p?.[1], 0, 100, 0) * 10) / 10])
          : [];
        if (pts.length < 3) return null;
        o.shape = 'poly';
        o.points = pts;
      } else o.shape = SIMPLE_SHAPES.includes(b.shape) ? b.shape : 'rect';
      o.fill = COLOR_RE.test(b.fill) ? b.fill : '#b89bff';
    }

    if (type === 'shape' || type === 'image' || type === 'link') {
      if (b.img) {
        if (typeof b.img !== 'string' || b.img.length > MAX_IMG_CHARS || !IMG_RE.test(b.img)) {
          throw layoutError('badImage');
        }
        o.img = b.img;
      }
    }
    if (type === 'image' && !o.img) return null;
    if (type === 'image' || type === 'link') o.shape = SIMPLE_SHAPES.includes(b.shape) ? b.shape : 'rect';

    if (type === 'link') {
      o.fill = COLOR_RE.test(b.fill) ? b.fill : '#7c5cff';
      o.label = String(b.label || '').slice(0, 40);
      o.lc = COLOR_RE.test(b.lc) ? b.lc : '#ffffff';
      o.lf = Math.round(num(b.lf, 8, 80, 16));
      o.rd = Math.round(num(b.rd, 0, 100, 0));
      const u = String(b.url || '').trim();
      o.url = /^https?:\/\/[^\s"'<>]{1,490}$/i.test(u) ? u : '';
    }
    if (FIT_TYPES.includes(type)) {
      const fit = cleanFit(b.fit);
      if (fit) o.fit = fit;
      const ia = Number(b.ia); // пропорции исходного фото (ширина / высота)
      if (Number.isFinite(ia) && ia > 0.05 && ia < 20) o.ia = Math.round(ia * 1000) / 1000;
    }
    if (type === 'text') {
      o.text = String(b.text || '').slice(0, 1000);
      o.st = cleanStyle(b.st);
    }
    return o;
  }

  // null — сброс макета; иначе бросает Error с понятным текстом
  function sanitize(raw) {
    if (raw === null) return null;
    if (!raw || typeof raw !== 'object') throw layoutError('badLayout');
    const out = { v: 1 };
    for (const mode of ['profile', 'live']) {
      const src = Array.isArray(raw[mode]?.blocks) ? raw[mode].blocks.slice(0, 60) : [];
      const seen = new Set();
      const blocks = [];
      for (const b of src) {
        const nb = cleanBlock(b, mode);
        if (!nb || seen.has(nb.id)) continue;
        seen.add(nb.id);
        blocks.push(nb);
      }
      for (const d of DEFAULTS[mode]) if (!seen.has(d.id)) blocks.unshift(clone(d));
      fixOrder(blocks);
      syncChat(blocks);
      const c = counts(blocks), L = LIMITS[mode];
      if (c.custom > L.custom) throw layoutError('tooManyBlocks', { n: L.custom });
      if (c.photos > L.photos) throw layoutError('tooManyPhotos', { n: L.photos });
      if (c.links > L.links) throw layoutError('tooManyLinks', { n: L.links });
      out[mode] = { blocks };
    }
    let imgChars = 0;
    for (const m of ['profile', 'live']) for (const b of out[m].blocks) imgChars += b.img ? b.img.length : 0;
    if (imgChars > 4000000) throw layoutError('tooHeavy');
    return out;
  }

  const api = { fixOrder, W, WM, MAX_H, DEFAULTS, LIMITS, FONTS, CUSTOM_TYPES, defOf, minSize, clampBlock, syncChat, counts, withDefaults, sanitize, clone };
  if (typeof document === 'undefined') return api;

  // ---------- только браузер ----------

  api.applyVars = (el, b) => {
    el.style.setProperty('--x', b.x);
    el.style.setProperty('--y', b.y);
    el.style.setProperty('--w', b.w);
    el.style.setProperty('--h', b.h);
  };

  api.canvasHeight = (blocks) => Math.max(480, ...blocks.map((b) => b.y + b.h)) + 40;

  api.paintShape = (el, b) => {
    el.style.borderRadius = '';
    el.style.clipPath = '';
    const s = b.shape;
    if (s === 'circle') el.style.borderRadius = '50%';
    else if (s === 'triangle') el.style.clipPath = 'polygon(50% 0,0 100%,100% 100%)';
    else if (s === 'poly' && Array.isArray(b.points)) el.style.clipPath = 'polygon(' + b.points.map((p) => p[0] + '% ' + p[1] + '%').join(',') + ')';
    else if (b.type === 'avatar') el.style.borderRadius = '14%';
  };

  // прямоугольник фото внутри блока (в тех же единицах, что bw/bh)
  api.fitRect = (fit, ia, bw, bh) => {
    const f = { ...FIT0, ...(fit || {}) };
    const ba = bw / bh;
    const a = ia > 0 ? ia : ba;
    const byH = f.m === 'contain' ? a < ba : a >= ba;
    let w, h;
    if (f.m === 'stretch') { w = bw; h = bh; }
    else if (byH) { h = bh; w = bh * a; }
    else { w = bw; h = bh === 0 ? 0 : bw / a; }
    w *= f.z;
    h *= f.z;
    return { w, h, l: ((bw - w) * f.x) / 100, t: ((bh - h) * f.y) / 100 };
  };

  // проценты, а не пиксели, поэтому подгон не ломается при масштабировании страницы
  api.applyFit = (el, b) => {
    el.style.backgroundRepeat = 'no-repeat';
    if (!b.fit || (!(b.ia > 0) && b.fit.m !== 'stretch')) {
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      return;
    }
    const f = { ...FIT0, ...b.fit };
    const r = api.fitRect(f, b.ia, b.w, b.h);
    el.style.backgroundSize = `${(r.w / b.w) * 100}% ${(r.h / b.h) * 100}%`;
    el.style.backgroundPosition = `${f.x}% ${f.y}%`;
  };

  const hexToRgba = (hex, a) => {
    const n = parseInt(String(hex).slice(1), 16) || 0;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  api.paintCustom = (el, b) => {
    api.applyVars(el, b);
    const f = el.querySelector('.pw-fill');
    f.removeAttribute('style');
    f.textContent = '';
    if (b.type === 'text') {
      const s = b.st || {};
      f.style.setProperty('--fs', s.fs);
      f.style.setProperty('--pd', s.pad);
      f.style.setProperty('--bw', s.bw);
      f.style.setProperty('--ls', s.ls);
      Object.assign(f.style, {
        color: s.color,
        background: hexToRgba(s.bg, s.bgOpacity),
        fontWeight: s.bold ? '700' : '400',
        fontStyle: s.italic ? 'italic' : 'normal',
        textDecoration: s.underline ? 'underline' : 'none',
        textAlign: s.align,
        justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[s.align],
        alignItems: { top: 'flex-start', center: 'center', bottom: 'flex-end' }[s.va],
        fontFamily: FONTS[s.font],
        borderRadius: `calc(${s.radius} * var(--s,1) * 1px)`,
        borderColor: s.bc,
        opacity: s.opacity,
        textShadow: s.shadow ? '0 2px 6px rgba(0,0,0,.6)' : 'none',
      });
      f.textContent = b.text || '';
    } else {
      f.style.background = b.img ? '' : b.fill || 'transparent';
      if (b.img) {
        f.style.backgroundImage = `url("${b.img}")`;
        api.applyFit(f, b);
      }
      api.paintShape(f, b);
      if (b.type === 'link') {
        f.textContent = b.label || '';
        f.style.setProperty('--lf', b.lf || 16);
        f.style.color = b.lc || '#ffffff';
        if ((b.shape || 'rect') === 'rect' && b.rd) f.style.borderRadius = `calc(${b.rd} * var(--s, 1) * 1px)`;
      }
    }
  };

  api.buildEl = (b, editing) => {
    const asLink = b.type === 'link' && !editing && b.url;
    const el = document.createElement(asLink ? 'a' : 'div');
    el.className = 'pw-block pw-custom pw-' + b.type;
    el.dataset.id = b.id;
    if (asLink) { el.href = b.url; el.target = '_blank'; el.rel = 'noopener noreferrer nofollow'; }
    const f = document.createElement('div');
    f.className = 'pw-fill';
    el.appendChild(f);
    api.paintCustom(el, b);
    return el;
  };

  // уменьшаем до maxSide и пережимаем в webp/jpeg, пока не влезет в лимит
  api.imageToDataUrl = async (file, maxSide = 900) => {
    if (!file || !/^image\//.test(file.type)) throw new Error('Нужна картинка');
    const bmp = await createImageBitmap(file);
    let side = maxSide;
    for (let i = 0; i < 5; i++) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      let url = c.toDataURL('image/webp', 0.82);
      if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.82);
      if (url.length <= MAX_IMG_CHARS) return { url, w: c.width, h: c.height };
      side *= 0.75;
    }
    throw layoutError('imageTooHeavy');
  };

  return api;
});