(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PWLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 1100;
  const MAX_H = 10000; // холст растёт вниз до 10 000 (вверх, влево и вправо за края нельзя)
  const DEFAULTS = {
    profile: [
      { id: 'banner', type: 'banner', x: 0, y: 0, w: 1100, h: 220 },
      { id: 'avatar', type: 'avatar', x: 20, y: 172, w: 120, h: 120, shape: 'circle' },
      { id: 'info', type: 'info', x: 160, y: 232, w: 600, h: 90 },
      { id: 'vods', type: 'vods', x: 0, y: 340, w: 1100, h: 320 },
      { id: 'follow', type: 'follow', x: 900, y: 240, w: 180, h: 44 }, // кнопка «Подписаться»
    ],
    live: [
      { id: 'player', type: 'player', x: 0, y: 0, w: 764, h: 430 },
      { id: 'chat', type: 'chat', x: 780, y: 0, w: 320, h: 430 },
    ],
  };
  // место в редакторе по режимам (1760 — влезает в окно браузера на экране 1920 с полями). Страница занимает ширину
  // до самого правого блока, но не меньше MIN_W — старые макеты (профиль 1100, эфир 1600) выглядят как раньше,
  // а шире становятся только те, кто растянул
  const WM = { profile: 1760, live: 1760 };
  const MIN_W = { profile: 1100, live: 1600 };

  // ошибка с ключом словаря: в браузере текст сразу переведён, на сервере роут переводит по e.i18nKey
  function layoutError(key, vars) {
    const g = typeof window !== 'undefined' ? window : null;
    const e = new Error(g && g.t ? g.t('layout.err.' + key, vars) : key);
    e.i18nKey = 'layout.err.' + key;
    e.vars = vars;
    return e;
  }
  const LIMITS = {
    profile: { custom: 12, photos: 4, links: 12, bgs: 2, sides: 2 },
    live: { custom: 8, photos: 2, links: 6, bgs: 0, sides: 2 }, // фото-блоки в эфире больше не добавляются (бока — через 🖼️), старые показываются
  };
  // фон страницы профиля: до 2 заливок (цвет или фото) и переход между ними
  const BG_FX = ['fade', 'sharp', 'diagonal', 'wave', 'zigzag', 'steps', 'arc', 'stripes', 'dots', 'radial'];
  const BG_FITS = ['cover', 'contain', 'tile'];
  const CUSTOM_TYPES = { profile: ['shape', 'text', 'image', 'link'], live: ['text', 'image', 'link'] };
  const FONTS = {
    system: 'inherit',
    serif: 'Georgia, serif',
    mono: '"Courier New", monospace',
    rounded: '"Trebuchet MS", sans-serif',
    display: 'Impact, "Arial Black", sans-serif',
  };
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMG_CHARS = 900000;
  // анимированные GIF хранятся как есть (пережатие через canvas убило бы анимацию): до ~1,2 МБ и не больше 2 на макет
  const MAX_GIF_CHARS = 1700000;
  const GIF_MAX = 2;
  const MAX_TOTAL_IMG_CHARS = 5000000;
  const isGif = (s) => typeof s === 'string' && s.startsWith('data:image/gif');
  const imgOk = (s) => typeof s === 'string' && s.length <= (isGif(s) ? MAX_GIF_CHARS : MAX_IMG_CHARS) && IMG_RE.test(s);
  // все картинки макета: блоки обоих режимов и фоны профиля
  function allImages(L) {
    const out = [];
    for (const m of ['profile', 'live']) for (const b of L?.[m]?.blocks || []) if (b.img) out.push(b.img);
    for (const f of L?.profile?.bg?.fills || []) if (f.img) out.push(f.img);
    for (const m of ['profile', 'live']) for (const k of ['l', 'r']) if (L?.[m]?.sides?.[k]?.img) out.push(L[m].sides[k].img);
    return out;
  }
  const gifCount = (L) => allImages(L).filter(isGif).length;
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
    b.y = Math.round(num(b.y, 0, MAX_H - b.h, 0)); // низ блока тоже не ниже MAX_H
    return b;
  }

  // реальная ширина холста: до правого края самого правого блока, в пределах [MIN_W, WM]
  // minWidth — заданная вручную ширина страницы профиля (layout.profile.width): место справа есть и без блоков
  function canvasWidth(blocks, mode = 'profile', minWidth = 0) {
    const max = WM[mode] || 1100, min = Math.max(MIN_W[mode] || max, Number(minWidth) || 0);
    let right = 0;
    for (const b of blocks || []) right = Math.max(right, (Number(b.x) || 0) + (Number(b.w) || 0));
    return Math.round(Math.min(max, Math.max(min, right)));
  }

  // недостающий родной блок (макет сохранён до его появления): вниз слоёв, а кнопку «Подписаться» — наверх,
  // чтобы её не закрыли свои фигуры
  function addDefault(blocks, d) {
    if (d.type === 'follow') blocks.push(clone(d));
    else blocks.unshift(clone(d));
  }

  // аватар всегда выше баннера: если он в списке раньше, ставим сразу за баннером.
  // «Имя и описание» и «Подписаться» — всегда выше и баннера, и аватара (кнопок слоёв у них нет)
  function fixOrder(blocks) {
    const bi = blocks.findIndex((b) => b.type === 'banner');
    const ai = blocks.findIndex((b) => b.type === 'avatar');
    if (bi >= 0 && ai >= 0 && ai < bi) {
      const [a] = blocks.splice(ai, 1);
      blocks.splice(bi, 0, a);
    }
    for (const t of ['info', 'follow']) {
      const i = blocks.findIndex((b) => b.type === t);
      const top = Math.max(blocks.findIndex((b) => b.type === 'banner'), blocks.findIndex((b) => b.type === 'avatar'));
      if (i >= 0 && i < top) {
        const [x] = blocks.splice(i, 1);
        blocks.splice(top, 0, x);
      }
    }
    // «Подписаться» — поверх «Имени и описания» (иначе текст описания закрывает кнопку)
    const ii = blocks.findIndex((b) => b.type === 'info');
    const fi = blocks.findIndex((b) => b.type === 'follow');
    if (ii >= 0 && fi >= 0 && fi < ii) {
      const [f] = blocks.splice(fi, 1);
      blocks.splice(ii, 0, f); // info сдвинулся на ii − 1, кнопка встаёт сразу за ним
    }
  }

  function syncChat(blocks) {
    const p = blocks.find((b) => b.type === 'player');
    const c = blocks.find((b) => b.type === 'chat');
    if (p && c) c.h = p.h;
  }

  function counts(blocks, bg, sides) {
    let custom = 0, photos = 0, links = 0;
    for (const b of blocks) {
      if (b.type === 'shape' || b.type === 'text') custom++;
      if (b.type === 'image' || (b.type === 'shape' && b.img)) photos++;
      if (b.type === 'link') links++;
    }
    return {
      custom, photos, links,
      bgs: bg && Array.isArray(bg.fills) ? bg.fills.length : 0,
      sides: sides ? ['l', 'r'].filter((k) => sides[k]).length : 0,
    };
  }

  // одна заливка: цвет или фото (с цветом под ним); битое фото — ошибка, пустая заливка — null
  function cleanFill(f) {
    if (!f || typeof f !== 'object') return null;
    if (f.img) {
      if (!imgOk(f.img)) throw layoutError('badImage');
      const out = { img: f.img, fit: BG_FITS.includes(f.fit) ? f.fit : 'cover', c: COLOR_RE.test(f.c) ? f.c : '#000000' };
      // положение фото на боку: 'out' — к краю окна, 'in' — к профилю/эфиру, нет — по центру
      if (f.ax === 'out' || f.ax === 'in') out.ax = f.ax;
      return out;
    }
    return COLOR_RE.test(f.c) ? { c: f.c } : null;
  }

  // бока страницы профиля (слева и справа от холста, во всю высоту окна): { l, r } — заливки; пусто — null
  // ширина страницы профиля, выбранная вручную: null — «по блокам», иначе 1100…1760
  const PAGE_WIDTHS = [1280, 1440, 1600, 1760];
  function cleanWidth(v) {
    const n = Math.round(Number(v));
    return PAGE_WIDTHS.includes(n) ? n : null;
  }

  function cleanSides(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of ['l', 'r']) { const f = cleanFill(raw[k]); if (f) out[k] = f; }
    return out.l || out.r ? out : null;
  }

  // фон: { fills: [{ c } | { img, fit }] (1–2), pos 0–100 — где переход, dir 'v' (сверху вниз) | 'h' (слева направо),
  // fx — эффект перехода, soft 0–50 — ширина перехода }. Пустой или битый — null (фона нет)
  function cleanBg(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fills)) return null;
    const fills = [];
    for (const f of raw.fills.slice(0, LIMITS.profile.bgs)) {
      const cf = cleanFill(f);
      if (cf) fills.push(cf);
    }
    if (!fills.length) return null;
    return {
      fills,
      pos: Math.round(num(raw.pos, 0, 100, 50) * 10) / 10,
      dir: raw.dir === 'h' ? 'h' : 'v',
      fx: BG_FX.includes(raw.fx) ? raw.fx : 'fade',
      soft: Math.round(num(raw.soft, 0, 50, 20) * 10) / 10,
      // true — фон у зрителей на всю страницу (фото закреплено в окне); иначе только под профилем, как раньше
      ...(raw.full === true && { full: true }),
    };
  }

  function withDefaults(raw) {
    const out = { v: 1 };
    for (const mode of ['profile', 'live']) {
      const src = Array.isArray(raw?.[mode]?.blocks) ? raw[mode].blocks : [];
      const blocks = clone(src);
      for (const d of DEFAULTS[mode]) if (!blocks.some((b) => b.id === d.id)) addDefault(blocks, d);
      blocks.forEach((b) => clampBlock(b, mode));
      fixOrder(blocks);
      syncChat(blocks);
      out[mode] = { blocks };
    }
    // фон — только у профиля; в браузере битый фон просто не показываем (на сервере он уже очищен)
    try { out.profile.bg = cleanBg(raw?.profile?.bg); } catch { out.profile.bg = null; }
    try { out.profile.sides = cleanSides(raw?.profile?.sides); } catch { out.profile.sides = null; }
    out.profile.width = cleanWidth(raw?.profile?.width);
    try { out.live.sides = cleanSides(raw?.live?.sides); } catch { out.live.sides = null; }
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

  // ---- стиль блока «Имя и описание» (ist: n — ник, d — описание, x — фон и рамка) и кнопки «Подписаться»
  // (fst: a — «Подписаться», b — «Вы подписаны», anim — анимация при нажатии). Нет поля — обычный вид сайта
  const SHADOWS = ['none', 'soft', 'glow'];
  // значки кнопки: только эмодзи до Unicode 13 (новые на Windows 10 — пустые квадраты)
  const FOLLOW_ICONS = { none: '', heart: '❤', heart2: '💜', star: '★', bell: '🔔', plus: '+', check: '✓', fire: '🔥', spark: '✨' };
  const FOLLOW_ANIMS = ['none', 'pop', 'slideL', 'slideR', 'fill', 'wave', 'flip', 'hearts', 'shake', 'glow'];
  const FOLLOW_DEF = {
    a: { t: '', ic: 'heart', bg: '#7c5cff', bg2: '#c084fc', c: '#ffffff', font: 'system', fs: 16, b: true, i: false, up: false, r: 10, bw: 0, bc: '#ffffff', sh: 'soft' },
    b: { t: '', ic: 'heart2', bg: '#2a2633', bg2: '', c: '#ffffff', font: 'system', fs: 16, b: true, i: false, up: false, r: 10, bw: 1, bc: '#7c5cff', sh: 'none' },
  };
  const colOr = (v, d) => (COLOR_RE.test(v) ? v : d);
  const pickOr = (v, list, d) => (list.includes(v) ? v : d);
  const fontOr = (v) => (FONTS[v] ? v : 'system');
  const ALIGNS = ['left', 'center', 'right'];
  const VALIGNS = ['top', 'center', 'bottom'];

  function cleanInfoStyle(s) {
    if (!s || typeof s !== 'object') return null;
    const n = s.n || {}, d = s.d || {}, x = s.x || {};
    return {
      n: {
        font: fontOr(n.font), fs: Math.round(num(n.fs, 12, 96, 28)), c: colOr(n.c, '#ffffff'), c2: colOr(n.c2, ''),
        b: n.b !== false, i: !!n.i, up: !!n.up, ls: Math.round(num(n.ls, -2, 20, 0) * 2) / 2, sh: pickOr(n.sh, SHADOWS, 'none'),
      },
      d: {
        font: fontOr(d.font), fs: Math.round(num(d.fs, 10, 40, 14)), c: colOr(d.c, '#b8b8c8'), i: !!d.i,
        lines: Math.round(num(d.lines, 1, 8, 2)), sh: pickOr(d.sh, SHADOWS, 'none'),
      },
      x: {
        bg: colOr(x.bg, '#000000'), op: Math.round(num(x.op, 0, 1, 0) * 100) / 100, r: Math.round(num(x.r, 0, 60, 0)),
        pad: Math.round(num(x.pad, 0, 40, 0)), bc: colOr(x.bc, '#ffffff'), bw: Math.round(num(x.bw, 0, 8, 0)),
        al: pickOr(x.al, ALIGNS, 'left'), va: pickOr(x.va, VALIGNS, 'top'), cnt: x.cnt !== false,
      },
    };
  }

  function cleanFollowState(s, d) {
    s = s && typeof s === 'object' ? s : {};
    return {
      t: String(s.t || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      ic: Object.prototype.hasOwnProperty.call(FOLLOW_ICONS, s.ic) ? s.ic : d.ic,
      bg: colOr(s.bg, d.bg), bg2: s.bg2 === undefined ? d.bg2 : colOr(s.bg2, ''), c: colOr(s.c, d.c),
      font: fontOr(s.font), fs: Math.round(num(s.fs, 10, 40, d.fs)), b: s.b === undefined ? d.b : !!s.b, i: !!s.i, up: !!s.up,
      r: Math.round(num(s.r, 0, 50, d.r)), bw: Math.round(num(s.bw, 0, 6, d.bw)), bc: colOr(s.bc, d.bc), sh: pickOr(s.sh, SHADOWS, d.sh),
    };
  }

  function cleanFollowStyle(s) {
    if (!s || typeof s !== 'object') return null;
    return { a: cleanFollowState(s.a, FOLLOW_DEF.a), b: cleanFollowState(s.b, FOLLOW_DEF.b), anim: pickOr(s.anim, FOLLOW_ANIMS, 'pop') };
  }

  // свои надписи кнопки «Подписаться» (сервер проверяет их на мат)
  function styleTexts(L) {
    const out = [];
    for (const b of L?.profile?.blocks || []) if (b.fst) for (const k of ['a', 'b']) if (b.fst[k]?.t) out.push(b.fst[k].t);
    return out;
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
    if (type === 'info') { const st = cleanInfoStyle(b.ist); if (st) o.ist = st; }
    if (type === 'follow') { const st = cleanFollowStyle(b.fst); if (st) o.fst = st; }

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
        if (!imgOk(b.img)) throw layoutError('badImage');
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
      for (const d of DEFAULTS[mode]) if (!seen.has(d.id)) addDefault(blocks, d);
      fixOrder(blocks);
      syncChat(blocks);
      const c = counts(blocks), L = LIMITS[mode];
      if (c.custom > L.custom) throw layoutError('tooManyBlocks', { n: L.custom });
      if (c.photos > L.photos) throw layoutError('tooManyPhotos', { n: L.photos });
      if (c.links > L.links) throw layoutError('tooManyLinks', { n: L.links });
      out[mode] = { blocks };
    }
    out.profile.bg = cleanBg(raw.profile?.bg);
    out.profile.sides = cleanSides(raw.profile?.sides);
    out.profile.width = cleanWidth(raw.profile?.width);
    out.live.sides = cleanSides(raw.live?.sides);
    if (gifCount(out) > GIF_MAX) throw layoutError('tooManyGifs', { n: GIF_MAX });
    if (allImages(out).reduce((n, s) => n + s.length, 0) > MAX_TOTAL_IMG_CHARS) throw layoutError('tooHeavy');
    return out;
  }

  const api = {
    fixOrder, W, WM, MIN_W, MAX_H, PAGE_WIDTHS, GIF_MAX, isGif, gifCount, DEFAULTS, LIMITS, FONTS, CUSTOM_TYPES, BG_FX, BG_FITS,
    FOLLOW_ICONS, FOLLOW_ANIMS, SHADOWS, cleanInfoStyle, cleanFollowStyle, styleTexts,
    defOf, minSize, clampBlock, syncChat, counts, canvasWidth, cleanBg, cleanSides, withDefaults, sanitize, clone,
  };
  if (typeof document === 'undefined') return api;

  // ---------- только браузер ----------

  api.applyVars = (el, b) => {
    el.style.setProperty('--x', b.x);
    el.style.setProperty('--y', b.y);
    el.style.setProperty('--w', b.w);
    el.style.setProperty('--h', b.h);
  };

  api.canvasHeight = (blocks) => Math.max(480, ...blocks.map((b) => b.y + b.h)) + 40;

  // ---------- фон профиля: две заливки и переход между ними ----------
  // Второй фон кладём поверх первого и показываем через маску: маска и задаёт форму перехода.
  // Маска строится в единицах холста (W×H), поэтому волны и точки не сплющиваются при масштабе.
  const svgUrl = (w, h, body, blur) => {
    const f = blur > 0.5 ? `<filter id="b" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${blur.toFixed(1)}"/></filter>` : '';
    const g = blur > 0.5 ? ' filter="url(#b)"' : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${f}<g fill="#000"${g}>${body}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  };

  function bgMask(bg, W, H) {
    const v = bg.dir !== 'h';
    const p = bg.pos, sft = bg.soft;
    const lo = Math.max(0, p - sft / 2), hi = Math.min(100, p + sft / 2);
    const to = v ? 'to bottom' : 'to right';
    const L = v ? H : W, C = v ? W : H; // длина вдоль перехода и поперёк
    const at = (p / 100) * L;
    // точка (поперёк w, вдоль u) → координаты svg
    const xy = (w, u) => (v ? `${w.toFixed(1)},${u.toFixed(1)}` : `${u.toFixed(1)},${w.toFixed(1)}`);
    const blur = (sft / 100) * L * 0.12;
    // фигура выходит за края на запас размытия: иначе размытие смешивает её край с пустотой,
    // и у боковых краёв (на всю страницу — заметно) проступает первый фон
    const pad = blur * 3 + 2;
    const area = (edge) => {
      const e = [[-pad, edge[0][1]], ...edge, [C + pad, edge[edge.length - 1][1]]];
      return `<path d="M${e.map(([w, u]) => xy(w, u)).join(' L')} L${xy(C + pad, L + pad)} L${xy(-pad, L + pad)} Z"/>`;
    };
    const amp = Math.max(12, C * 0.03);

    switch (bg.fx) {
      case 'sharp':
        return `linear-gradient(${to}, transparent ${p}%, #000 ${p}%)`;
      case 'diagonal':
        return `linear-gradient(${v ? 'to bottom right' : 'to top right'}, transparent ${lo}%, #000 ${hi}%)`;
      case 'radial': // первый фон в центре, второй вокруг
        return `radial-gradient(circle at 50% 50%, transparent ${lo}%, #000 ${hi}%)`;
      case 'wave': {
        const edge = [];
        for (let i = 0; i <= 64; i++) { const w = (C * i) / 64; edge.push([w, at + amp * Math.sin((w / C) * Math.PI * 8)]); }
        return svgUrl(W, H, area(edge), blur);
      }
      case 'zigzag': {
        const edge = [], n = 16;
        for (let i = 0; i <= n; i++) edge.push([(C * i) / n, at + (i % 2 ? amp : -amp)]);
        return svgUrl(W, H, area(edge), blur);
      }
      case 'steps': {
        const edge = [], n = 6, step = amp * 1.5;
        for (let i = 0; i < n; i++) {
          const u = at + (i - (n - 1) / 2) * step;
          edge.push([(C * i) / n, u], [(C * (i + 1)) / n, u]);
        }
        return svgUrl(W, H, area(edge), blur);
      }
      case 'arc': {
        const edge = [];
        for (let i = 0; i <= 64; i++) { const w = (C * i) / 64; edge.push([w, at - C * 0.08 * Math.sin((w / C) * Math.PI)]); }
        return svgUrl(W, H, area(edge), blur);
      }
      case 'stripes': { // жалюзи: полосы второго фона толстеют по ходу перехода
        const zone = Math.max(15, sft * 1.5) / 100 * L, u0 = at - zone / 2, n = 8, band = zone / n;
        let body = '';
        for (let i = 0; i < n; i++) {
          const t = band * ((i + 0.5) / n);
          body += v ? `<rect x="0" y="${(u0 + i * band).toFixed(1)}" width="${C}" height="${t.toFixed(1)}"/>`
            : `<rect x="${(u0 + i * band).toFixed(1)}" y="0" width="${t.toFixed(1)}" height="${C}"/>`;
        }
        body += v ? `<rect x="0" y="${(u0 + zone).toFixed(1)}" width="${C}" height="${Math.max(0, L - u0 - zone).toFixed(1)}"/>`
          : `<rect x="${(u0 + zone).toFixed(1)}" y="0" width="${Math.max(0, L - u0 - zone).toFixed(1)}" height="${C}"/>`;
        return svgUrl(W, H, body, 0);
      }
      case 'dots': { // точки растут по ходу перехода и сливаются во второй фон
        const zone = Math.max(15, sft * 1.5) / 100 * L, u0 = at - zone / 2;
        let g = C / 18;
        while ((C / g) * (zone / g) > 1500) g *= 1.25; // не больше ~1500 кружков
        let body = '';
        for (let u = u0 + g / 2; u < u0 + zone; u += g) {
          const r = (g * 0.72 * (u - u0)) / zone;
          if (r < 0.5) continue;
          for (let w = g / 2; w < C; w += g) {
            const [x, y] = v ? [w, u] : [u, w];
            body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
          }
        }
        body += v ? `<rect x="0" y="${(u0 + zone).toFixed(1)}" width="${C}" height="${Math.max(0, L - u0 - zone).toFixed(1)}"/>`
          : `<rect x="${(u0 + zone).toFixed(1)}" y="0" width="${Math.max(0, L - u0 - zone).toFixed(1)}" height="${C}"/>`;
        return svgUrl(W, H, body, 0);
      }
      default: // fade
        return `linear-gradient(${to}, transparent ${lo}%, #000 ${Math.max(hi, lo + 0.5)}%)`;
    }
  }

  function paintFill(el, f) {
    el.style.cssText = '';
    el.style.backgroundColor = f.c || 'transparent';
    if (f.img) {
      el.style.backgroundImage = `url("${f.img}")`;
      el.style.backgroundPosition = 'center';
      el.style.backgroundRepeat = f.fit === 'tile' ? 'repeat' : 'no-repeat';
      el.style.backgroundSize = f.fit === 'tile' ? `calc(var(--s, 1) * 400px)` : f.fit;
    }
  }

  api.paintFill = paintFill;
  // background-position фото бока: k — 'l' | 'r', ax — 'out' (к краю окна) | 'in' (к профилю/эфиру) | по центру
  api.sidePos = (k, ax) => (ax === 'out' ? (k === 'l' ? 'left center' : 'right center')
    : ax === 'in' ? (k === 'l' ? 'right center' : 'left center') : 'center');

  // какого размера фото на бок, чтобы на экране 1920×1080 заняло его целиком (окно без полосы прокрутки ~1903)
  api.sideSize = (viewW) => ({ w: Math.max(0, Math.round((1903 - viewW) / 2)), h: 1080 });

  // слой фона внутри холста: el — контейнер .pw-bg; W, H — размер холста в единицах
  api.paintBg = (el, bg, W, H) => {
    el.style.setProperty('--bgw', W);
    el.style.setProperty('--bgh', H);
    el.hidden = !bg;
    if (!bg) { el.replaceChildren(); return; }
    let a = el.children[0], b = el.children[1];
    if (!a) { a = document.createElement('div'); a.className = 'pw-bg-a'; el.appendChild(a); }
    paintFill(a, bg.fills[0]);
    if (bg.fills[1]) {
      if (!b) { b = document.createElement('div'); b.className = 'pw-bg-b'; el.appendChild(b); }
      paintFill(b, bg.fills[1]);
      const m = bgMask(bg, W, H);
      for (const k of ['maskImage', 'webkitMaskImage']) b.style[k] = m;
      for (const k of ['maskSize', 'webkitMaskSize']) b.style[k] = '100% 100%';
      for (const k of ['maskRepeat', 'webkitMaskRepeat']) b.style[k] = 'no-repeat';
    } else if (b) {
      b.remove();
    }
  };

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

  // ---- «Имя и описание»: стиль через CSS-переменные контейнера (правила — в blocks.css: .pw-ist .pw-i-name / .pw-i-desc).
  // el — .profile-info у зрителя или заливка блока в редакторе. Размеры — в единицах холста (× --s)
  const INFO_VARS = ['--in-font', '--in-fs', '--in-c', '--in-c2', '--in-w', '--in-i', '--in-up', '--in-ls', '--in-sh', '--in-f',
    '--id-font', '--id-fs', '--id-c', '--id-i', '--id-lines', '--id-sh', '--ib-bg', '--ib-r', '--ib-pad', '--ib-bw', '--ib-bc',
    '--ib-al', '--ib-jc', '--ib-va'];
  const textShadow = (sh, c) => (sh === 'glow' ? `0 0 calc(10px * var(--s, 1)) ${c}` : sh === 'soft' ? '0 2px 6px rgba(0,0,0,.6)' : 'none');

  api.paintInfo = (el, b) => {
    const s = b && b.ist;
    el.classList.toggle('pw-ist', !!s);
    el.classList.toggle('pw-i-grad', !!(s && s.n.c2));
    el.classList.toggle('pw-i-nocnt', !!(s && !s.x.cnt));
    if (!s) { INFO_VARS.forEach((k) => el.style.removeProperty(k)); return; }
    const { n, d, x } = s;
    const set = (k, v) => el.style.setProperty(k, String(v));
    set('--in-font', FONTS[n.font]); set('--in-fs', n.fs); set('--in-c', n.c); set('--in-c2', n.c2 || n.c);
    set('--in-w', n.b ? 800 : 400); set('--in-i', n.i ? 'italic' : 'normal'); set('--in-up', n.up ? 'uppercase' : 'none');
    set('--in-ls', n.ls);
    // у градиентного ника буквы прозрачные: тень рисуем фильтром, иначе она проступает сквозь буквы
    const nsh = textShadow(n.sh, n.c2 || n.c);
    set('--in-sh', n.c2 ? 'none' : nsh);
    set('--in-f', n.c2 && n.sh !== 'none' ? `drop-shadow(${nsh})` : 'none');
    set('--id-font', FONTS[d.font]); set('--id-fs', d.fs); set('--id-c', d.c); set('--id-i', d.i ? 'italic' : 'normal');
    set('--id-lines', d.lines); set('--id-sh', textShadow(d.sh, d.c));
    set('--ib-bg', hexToRgba(x.bg, x.op)); set('--ib-r', x.r); set('--ib-pad', x.pad); set('--ib-bw', x.bw); set('--ib-bc', x.bc);
    set('--ib-al', x.al); set('--ib-jc', { left: 'flex-start', center: 'center', right: 'flex-end' }[x.al]);
    set('--ib-va', { top: 'flex-start', center: 'center', bottom: 'flex-end' }[x.va]);
  };

  // ---- кнопка «Подписаться»: два состояния и анимация перехода ----
  const FOLLOW_PROPS = ['background', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textTransform', 'borderRadius', 'border', 'boxShadow'];
  const FOLLOW_TEXT = { a: 'layout.follow.follow', b: 'layout.follow.following' };
  api.followLabel = (st, which) => {
    const ic = FOLLOW_ICONS[st.ic] || '';
    const txt = st.t || (typeof window !== 'undefined' && window.t ? window.t(FOLLOW_TEXT[which]) : '');
    return (ic ? ic + ' ' : '') + txt;
  };
  function paintFollowState(el, st) {
    Object.assign(el.style, {
      background: st.bg2 ? `linear-gradient(135deg, ${st.bg}, ${st.bg2})` : st.bg,
      color: st.c,
      fontFamily: FONTS[st.font],
      fontSize: `calc(${st.fs} * var(--s, 1) * 1px)`,
      fontWeight: st.b ? '700' : '400',
      fontStyle: st.i ? 'italic' : 'normal',
      textTransform: st.up ? 'uppercase' : 'none',
      borderRadius: st.r >= 50 ? '999px' : `calc(${st.r} * var(--s, 1) * 1px)`,
      border: st.bw ? `calc(${st.bw} * var(--s, 1) * 1px) solid ${st.bc}` : 'none',
      boxShadow: st.sh === 'glow' ? `0 0 calc(16px * var(--s, 1)) ${st.bg2 || st.bg}` : st.sh === 'soft' ? '0 4px 14px rgba(0,0,0,.35)' : 'none',
    });
  }
  // false — стиля нет (у кнопки обычный вид и подпись сайта)
  api.paintFollow = (el, fst, following) => {
    const which = following ? 'b' : 'a';
    const st = fst && fst[which];
    el.classList.toggle('pw-fs', !!st);
    if (!st) { FOLLOW_PROPS.forEach((k) => { el.style[k] = ''; }); return false; }
    paintFollowState(el, st);
    el.textContent = api.followLabel(st, which);
    return true;
  };

  // анимация при нажатии: swap() перерисовывает кнопку в новом состоянии (вызывается в нужный момент)
  api.playFollowAnim = (el, fst, toFollowing, swap) => {
    let anim = (fst && fst.anim) || 'none';
    if (anim === 'hearts' && !toFollowing) anim = 'pop'; // сердечки — только на подписку
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) anim = 'none';
    const once = (cls, ms, after) => {
      el.classList.remove(cls);
      void el.offsetWidth; // перезапуск, если класс уже был
      el.classList.add(cls);
      setTimeout(() => { el.classList.remove(cls); if (after) after(); }, ms);
    };
    switch (anim) {
      case 'pop': case 'shake': case 'glow':
        swap();
        once('pw-fa-' + anim, 650);
        break;
      case 'flip':
        once('pw-fa-flip-out', 170, () => { swap(); once('pw-fa-flip-in', 230); });
        break;
      case 'slideL': case 'slideR': case 'fill': {
        // новое состояние «наезжает» поверх старого слоем, потом кнопка перерисовывается
        const which = toFollowing ? 'b' : 'a';
        const ov = document.createElement('span');
        ov.className = 'pw-fa-sweep pw-fa-' + anim;
        paintFollowState(ov, fst[which]);
        Object.assign(ov.style, { border: 'none', boxShadow: 'none', borderRadius: 'inherit' });
        ov.textContent = api.followLabel(fst[which], which);
        el.classList.add('pw-fa-host');
        el.appendChild(ov);
        setTimeout(() => { swap(); ov.remove(); el.classList.remove('pw-fa-host'); }, 460);
        break;
      }
      case 'wave': { // буквы новой надписи подпрыгивают по очереди
        swap();
        const txt = el.textContent;
        el.textContent = '';
        [...txt].forEach((ch, i) => {
          const s = document.createElement('span');
          s.className = 'pw-fa-ch';
          s.style.animationDelay = i * 35 + 'ms';
          s.textContent = ch === ' ' ? '\u00a0' : ch;
          el.appendChild(s);
        });
        setTimeout(() => { if (el.querySelector('.pw-fa-ch')) el.textContent = txt; }, 560 + txt.length * 35);
        break;
      }
      case 'hearts': { // значки вылетают из кнопки вверх
        swap();
        once('pw-fa-pop', 650);
        const r = el.getBoundingClientRect();
        const ic = FOLLOW_ICONS[fst.b.ic] || '❤';
        for (let i = 0; i < 8; i++) {
          const p = document.createElement('span');
          p.className = 'pw-fa-heart';
          p.textContent = ic;
          Object.assign(p.style, {
            left: r.left + r.width * (0.15 + Math.random() * 0.7) + 'px',
            top: r.top + r.height * 0.4 + 'px',
            fontSize: Math.max(12, r.height * 0.45) + 'px',
            color: fst.b.c,
            animationDelay: i * 45 + 'ms',
          });
          p.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
          document.body.appendChild(p);
          setTimeout(() => p.remove(), 1300);
        }
        break;
      }
      default:
        swap();
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

  // уменьшаем до maxSide и пережимаем в webp/jpeg, пока не влезет в лимит.
  // opts.gif — GIF берём как есть, чтобы не пропала анимация (только там, где GIF разрешён: свои блоки и фон)
  api.imageToDataUrl = async (file, maxSide = 900, opts = {}) => {
    if (!file || !/^image\//.test(file.type)) throw layoutError('notImage');
    const bmp = await createImageBitmap(file);
    if (opts.gif && file.type === 'image/gif') {
      const url = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(layoutError('notImage'));
        fr.readAsDataURL(file);
      });
      if (url.length > MAX_GIF_CHARS) throw layoutError('gifTooHeavy', { mb: 1.2 });
      return { url, w: bmp.width, h: bmp.height, gif: true };
    }
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