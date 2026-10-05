const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const LS_KEY = 'pw_ctor_chat';
const HEX6 = /^[0-9a-f]{6}$/;

const DEFAULTS = {
  layout: 'list', valign: 'bottom', align: 'left', maxw: 100, opacity: 100, gap: 6,
  size: 22, font: '', weight: 400, italic: false, ls: 0, lh: 130,
  color: 'ffffff', shadow: true, strokeOn: false, strokeC: '000000', strokeW: 2,
  bgOn: false, bg: '000000', bgalpha: 60, grad: false, bg2: '7c3aed', blur: 0,
  radius: 8, pad: 8, borderOn: false, bc: 'ffffff', bw: 1,
  stripeOn: false, stripeC: '7c3aed', stripeW: 4,
  glowOn: false, glowC: 'a855f7', glowS: 12,
  owner: 'e5484d', nickMode: 'text', nickPlate: false, nickCaps: false, showSrc: true,
  anim: 'slide', fadeOn: false, fade: 40, max: 30,
};

const PRESETS = [
  { name: 'Классика', v: {} },
  { name: 'Тёмные плашки', v: { bgOn: true, bg: '000000', bgalpha: 60, radius: 12, pad: 12, gap: 8 } },
  { name: 'Стекло', v: { bgOn: true, bg: 'ffffff', bgalpha: 14, blur: 12, radius: 14, pad: 12, borderOn: true, bc: 'ffffff', bw: 1, gap: 8 } },
  { name: 'Неон', v: { color: 'f5f3ff', weight: 700, bgOn: true, bg: '0b0b1a', bgalpha: 75, radius: 10, pad: 12, borderOn: true, bc: 'a855f7', bw: 2, owner: 'a855f7', anim: 'pop', gap: 8 } },
  { name: 'Градиент', v: { weight: 700, bgOn: true, grad: true, bg: '7c3aed', bg2: 'ec4899', bgalpha: 70, radius: 16, pad: 14, gap: 8 } },
  { name: 'Контур', v: { weight: 800, size: 26, shadow: false, strokeOn: true, strokeC: '000000', strokeW: 3 } },
  { name: 'Минимал', v: { size: 20, weight: 500, shadow: false, bgOn: true, bg: '111111', bgalpha: 35, radius: 6, anim: 'fade' } },
  { name: 'Плоская плашка', v: { layout: 'bar', size: 26, weight: 600, align: 'center', bgOn: true, bg: '0b0b12', bgalpha: 88, pad: 20, nickMode: 'auto', anim: 'fade', stripeOn: true, stripeC: '7c3aed', stripeW: 6, shadow: false } },
  { name: 'Лента', v: { layout: 'row', size: 22, weight: 600, bgOn: true, bg: '000000', bgalpha: 60, radius: 24, pad: 14, gap: 10, nickMode: 'auto', nickPlate: true, max: 12 } },
  { name: 'Киберпанк', v: { color: 'e0f7ff', weight: 700, bgOn: true, bg: '0a0f1e', bgalpha: 80, radius: 2, pad: 12, stripeOn: true, stripeC: '00e5ff', stripeW: 5, glowOn: true, glowC: '00e5ff', glowS: 14, nickMode: 'auto', nickCaps: true, ls: 1, owner: 'ff2bd6', gap: 8 } },
  { name: 'Пастель', v: { color: '3b2f4a', weight: 600, shadow: false, bgOn: true, bg: 'ffd6e8', grad: true, bg2: 'c9e4ff', bgalpha: 92, radius: 18, pad: 14, nickMode: 'auto', owner: 'ff7ab8', anim: 'pop', gap: 8 } },
  { name: 'Ретро', v: { font: 'Courier New', color: '7cfc00', weight: 700, shadow: false, bgOn: true, bg: '000000', bgalpha: 80, radius: 0, pad: 10, borderOn: true, bc: '7cfc00', bw: 2, ls: 1, nickCaps: true, gap: 8 } },
];

// dep — строка видна, только когда включён родитель; when — своё условие
const FIELDS = [
  { group: 'Раскладка' },
  { k: 'layout', type: 'select', label: 'Вид чата', opts: [['list', 'Список'], ['bar', 'Плоская плашка внизу (одно сообщение)'], ['row', 'Лента в одну строку']] },
  { k: 'valign', type: 'select', label: 'Положение на экране', opts: [['bottom', 'Внизу'], ['top', 'Вверху']] },
  { k: 'align', type: 'select', label: 'Выравнивание', opts: [['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']] },
  { k: 'maxw', type: 'range', label: 'Макс. ширина сообщения', min: 30, max: 100, unit: '%', when: (s) => s.layout === 'list' },
  { k: 'gap', type: 'range', label: 'Расстояние между сообщениями', min: 0, max: 30, unit: 'px', when: (s) => s.layout !== 'bar' },
  { k: 'opacity', type: 'range', label: 'Непрозрачность всего чата', min: 20, max: 100, unit: '%' },

  { group: 'Текст' },
  { k: 'size', type: 'range', label: 'Размер текста', min: 10, max: 80, unit: 'px' },
  { k: 'font', type: 'text', label: 'Шрифт (установленный на ПК)', ph: 'Segoe UI' },
  { k: 'weight', type: 'select', num: true, label: 'Толщина', opts: [[400, 'Обычная'], [500, 'Средняя'], [700, 'Жирная'], [800, 'Очень жирная']] },
  { k: 'italic', type: 'switch', label: 'Наклонный текст' },
  { k: 'ls', type: 'range', label: 'Расстояние между буквами', min: 0, max: 6, unit: 'px' },
  { k: 'lh', type: 'range', label: 'Межстрочный интервал', min: 100, max: 200, unit: '%' },
  { k: 'color', type: 'color', label: 'Цвет текста' },
  { k: 'shadow', type: 'switch', label: 'Тень у текста' },
  { k: 'strokeOn', type: 'switch', label: 'Контур у букв' },
  { k: 'strokeC', type: 'color', label: 'Цвет контура', dep: 'strokeOn' },
  { k: 'strokeW', type: 'range', label: 'Толщина контура', min: 1, max: 4, unit: 'px', dep: 'strokeOn' },

  { group: 'Сообщение' },
  { k: 'bgOn', type: 'switch', label: 'Фон под сообщением' },
  { k: 'bg', type: 'color', label: 'Цвет фона', dep: 'bgOn' },
  { k: 'bgalpha', type: 'range', label: 'Непрозрачность фона', min: 0, max: 100, unit: '%', dep: 'bgOn' },
  { k: 'grad', type: 'switch', label: 'Градиент фона', dep: 'bgOn' },
  { k: 'bg2', type: 'color', label: 'Второй цвет градиента', dep: 'grad' },
  { k: 'blur', type: 'range', label: 'Размытие под плашкой', min: 0, max: 20, unit: 'px', dep: 'bgOn' },
  { k: 'radius', type: 'range', label: 'Скругление углов', min: 0, max: 24, unit: 'px' },
  { k: 'pad', type: 'range', label: 'Отступ внутри', min: 0, max: 20, unit: 'px' },
  { k: 'borderOn', type: 'switch', label: 'Рамка' },
  { k: 'bc', type: 'color', label: 'Цвет рамки', dep: 'borderOn' },
  { k: 'bw', type: 'range', label: 'Толщина рамки', min: 1, max: 4, unit: 'px', dep: 'borderOn' },
  { k: 'stripeOn', type: 'switch', label: 'Цветная полоска слева' },
  { k: 'stripeC', type: 'color', label: 'Цвет полоски', dep: 'stripeOn' },
  { k: 'stripeW', type: 'range', label: 'Толщина полоски', min: 2, max: 12, unit: 'px', dep: 'stripeOn' },
  { k: 'glowOn', type: 'switch', label: 'Свечение вокруг сообщения' },
  { k: 'glowC', type: 'color', label: 'Цвет свечения', dep: 'glowOn' },
  { k: 'glowS', type: 'range', label: 'Сила свечения', min: 4, max: 40, unit: 'px', dep: 'glowOn' },

  { group: 'Ники' },
  { k: 'owner', type: 'color', label: 'Плашка на твоём нике' },
  { k: 'nickMode', type: 'select', label: 'Цвет ников зрителей', opts: [['text', 'Как у текста'], ['auto', 'Разноцветные (как на сайте)']] },
  { k: 'nickPlate', type: 'switch', label: 'Ник на цветной плашке' },
  { k: 'nickCaps', type: 'switch', label: 'Ники ЗАГЛАВНЫМИ' },
  { k: 'showSrc', type: 'switch', label: 'Метки источника (BOT, TWITCH)' },

  { group: 'Анимация и очистка' },
  { k: 'anim', type: 'select', label: 'Анимация появления', opts: [['slide', 'Выезд'], ['pop', 'Всплытие'], ['fade', 'Появление'], ['none', 'Без анимации']] },
  { k: 'fadeOn', type: 'switch', label: 'Сообщения исчезают' },
  { k: 'fade', type: 'number', label: 'Через сколько секунд', min: 1, max: 3600, dep: 'fadeOn' },
  { k: 'max', type: 'number', label: 'Сколько сообщений на экране', min: 5, max: 100 },
];

const VARS = [
  { v: '{user}', d: 'ник того, кто написал команду' },
  { v: '{streamer}', d: 'имя канала' },
  { v: '{title}', d: 'название стрима' },
  { v: '{viewers}', d: 'сколько людей в чате' },
  { v: '{uptime}', d: 'сколько идёт эфир' },
  { v: '{count}', d: 'сколько раз команду уже использовали' },
  { v: '{args}', d: 'всё, что зритель написал после команды' },
  { v: '{target}', d: 'первое слово после команды (без @) или ник автора' },
  { v: '{arg1}', d: 'первое слово после команды' },
  { v: '{arg2}', d: 'второе слово после команды' },
  { v: '{random}', d: 'случайное число 1–100' },
  { v: '{random:1-30}', d: 'случайное число в диапазоне; {random:30} — от 1 до 30' },
  { v: '{dice}', d: 'кубик 1–6' },
  { v: '{coin}', d: 'орёл или решка' },
  { v: '{choice:да|нет|может}', d: 'случайный вариант из списка через |' },
  { v: '{calc:2+2*3}', d: 'калькулятор: + - * / % и скобки' },
  { v: '{time}', d: 'время по Москве; {time:+1} — другой часовой пояс' },
  { v: '{date}', d: 'дата по Москве' },
];

const EXAMPLES = [
  { label: 'Рандом до N', name: 'рандом', args: [{ name: 'число', optional: false }], response: 'Случайное число до {число}: {random:{число}}' },
  { label: 'Кубик', name: 'кубик', args: [], response: '🎲 {user} бросил кубик: {random:6}' },
  { label: 'Монетка', name: 'монетка', args: [], response: '{user}, выпало: {coin}' },
  { label: 'Выбор', name: 'выбери', args: [], response: '{user}, я выбираю: {choice:первое|второе|третье}' },
  { label: 'Калькулятор', name: 'посчитай', args: [{ name: 'пример', optional: false }], response: '{args} = {calc:{args}}' },
  { label: 'Обнять', name: 'обнять', args: [{ name: 'кого', optional: false }], response: '{user} обнимает {кого} 🤗' },
  { label: 'Время', name: 'время', args: [], response: 'Сейчас {time:+3} по Москве, {date:+3}' },
  { label: 'Эфир', name: 'эфир', args: [], response: 'Идёт «{title}». Эфиру: {uptime}. Зрителей: {viewers}' },
];

const ICON_EDIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

let st = loadState();
let mode = 'chat';
let myName = 'Стример';
let commands = [];
let editingCmd = null;
let modalArgs = [];
let tryTouched = false;
let tryTimer = null;
let pvToken = 0;

// ---------- настройки ----------

function loadState() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; }
  catch (_) { return { ...DEFAULTS }; }
}
function saveState() { try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (_) {} }

function num(v, min, max, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}
const pick = (v, list, d) => (list.includes(v) ? v : d);

function sanitize() {
  st.size = num(st.size, 10, 80, 22);
  st.bgalpha = num(st.bgalpha, 0, 100, 60);
  st.fade = num(st.fade, 1, 3600, 40);
  st.max = num(st.max, 5, 100, 30);
  st.blur = num(st.blur, 0, 20, 0);
  st.radius = num(st.radius, 0, 24, 8);
  st.pad = num(st.pad, 0, 20, 8);
  st.gap = num(st.gap, 0, 30, 6);
  st.strokeW = num(st.strokeW, 1, 4, 2);
  st.bw = num(st.bw, 1, 4, 1);
  st.maxw = num(st.maxw, 30, 100, 100);
  st.opacity = num(st.opacity, 20, 100, 100);
  st.ls = num(st.ls, 0, 6, 0);
  st.lh = num(st.lh, 100, 200, 130);
  st.stripeW = num(st.stripeW, 2, 12, 4);
  st.glowS = num(st.glowS, 4, 40, 12);
  st.weight = [400, 500, 700, 800].includes(Number(st.weight)) ? Number(st.weight) : 400;
  st.layout = pick(st.layout, ['list', 'bar', 'row'], 'list');
  st.valign = pick(st.valign, ['bottom', 'top'], 'bottom');
  st.align = pick(st.align, ['left', 'center', 'right'], 'left');
  st.nickMode = pick(st.nickMode, ['text', 'auto'], 'text');
  st.anim = pick(st.anim, ['slide', 'pop', 'fade', 'none'], 'slide');
  ['color', 'bg', 'bg2', 'owner', 'strokeC', 'bc', 'stripeC', 'glowC'].forEach((k) => {
    if (!HEX6.test(st[k])) st[k] = DEFAULTS[k];
  });
  st.font = String(st.font || '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40);
  ['bgOn', 'grad', 'shadow', 'strokeOn', 'borderOn', 'fadeOn', 'italic', 'stripeOn', 'glowOn', 'nickPlate', 'nickCaps', 'showSrc']
    .forEach((k) => { st[k] = !!st[k]; });
}

function parseColor(s) {
  s = String(s).trim().toLowerCase();
  let m = s.match(/^#?([0-9a-f]{6})$/);
  if (m) return m[1];
  m = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) return m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  m = s.match(/^(?:rgb\()?\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)?$/);
  if (m) {
    const v = [m[1], m[2], m[3]].map(Number);
    if (v.every((n) => n <= 255)) return v.map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function makeSwitch(checked, onChange) {
  const wrap = el('label', 'sw');
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = !!checked;
  inp.addEventListener('change', () => onChange(inp.checked, inp));
  wrap.append(inp, el('span', 'sw-slider'));
  return wrap;
}

function visible(f) {
  if (f.when && !f.when(st)) return false;
  if (!f.dep) return true;
  return !!st[f.dep] && visible(FIELDS.find((x) => x.k === f.dep));
}
function updateVisibility() {
  document.querySelectorAll('#ctorFields .ctor-row').forEach((row) => {
    row.classList.toggle('hidden', !visible(FIELDS.find((x) => x.k === row.dataset.k)));
  });
}

function setVal(k, v) {
  st[k] = v;
  sanitize();
  saveState();
  updateVisibility();
  renderPreview();
}

function buildFields() {
  const box = $('ctorFields');
  box.innerHTML = '';

  FIELDS.forEach((f) => {
    if (f.group) { box.appendChild(el('h3', 'ctor-group', f.group)); return; }

    const row = el('div', 'ctor-row');
    row.dataset.k = f.k;
    row.appendChild(el('div', 'ctor-label', f.label));
    const ctl = el('div', 'ctor-ctl');

    if (f.type === 'switch') {
      ctl.appendChild(makeSwitch(st[f.k], (on) => setVal(f.k, on)));
    } else if (f.type === 'range') {
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = f.min; inp.max = f.max; inp.value = st[f.k];
      const out = el('span', 'ctor-val', st[f.k] + f.unit);
      inp.addEventListener('input', () => { out.textContent = inp.value + f.unit; setVal(f.k, parseInt(inp.value, 10)); });
      ctl.append(inp, out);
    } else if (f.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = f.min; inp.max = f.max; inp.value = st[f.k];
      inp.addEventListener('change', () => {
        setVal(f.k, num(inp.value, f.min, f.max, DEFAULTS[f.k]));
        inp.value = st[f.k];
      });
      ctl.appendChild(inp);
    } else if (f.type === 'text') {
      const inp = el('input', 'ctor-text');
      inp.maxLength = 40; inp.placeholder = f.ph || ''; inp.value = st[f.k];
      inp.addEventListener('input', () => setVal(f.k, inp.value));
      ctl.appendChild(inp);
    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      f.opts.forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      });
      sel.value = String(st[f.k]);
      sel.addEventListener('change', () => {
        setVal(f.k, f.num ? Number(sel.value) : sel.value);
        if (f.k === 'anim') replayAnim();
      });
      ctl.appendChild(sel);
    } else if (f.type === 'color') {
      const pickEl = el('input', 'ctor-color');
      pickEl.type = 'color';
      pickEl.value = '#' + st[f.k];
      const hex = el('input', 'ctor-hex');
      hex.value = '#' + st[f.k];
      hex.maxLength = 20;
      hex.spellcheck = false;
      hex.placeholder = '#ffffff или rgb(255,255,255)';
      pickEl.addEventListener('input', () => { hex.value = pickEl.value; setVal(f.k, pickEl.value.slice(1)); });
      hex.addEventListener('change', () => {
        const c = parseColor(hex.value);
        if (c) { pickEl.value = '#' + c; hex.value = '#' + c; setVal(f.k, c); }
        else hex.value = '#' + st[f.k];
      });
      ctl.append(pickEl, hex);
    }

    row.appendChild(ctl);
    box.appendChild(row);
  });

  updateVisibility();
}

function buildPresets() {
  const box = $('ctorPresets');
  box.innerHTML = '';
  PRESETS.forEach((p) => {
    const b = el('button', 'ctor-preset', p.name);
    b.type = 'button';
    b.addEventListener('click', () => {
      st = { ...DEFAULTS, ...p.v };
      sanitize();
      saveState();
      buildFields();
      renderPreview();
      replayAnim();
    });
    box.appendChild(b);
  });
}

function resetChat() {
  st = { ...DEFAULTS };
  saveState();
  buildFields();
  renderPreview();
}

// ---------- предпросмотр ----------

function autoColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
}

function applyStyle(box) {
  const a = st.bgalpha / 100;
  const rgba = (h) => `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
  const set = (k, v) => box.style.setProperty(k, v);
  const unset = (k) => box.style.removeProperty(k);

  set('--pv-fs', st.size + 'px');
  set('--pv-font', st.font ? `"${st.font}", 'Segoe UI', system-ui, sans-serif` : "'Segoe UI', system-ui, sans-serif");
  set('--pv-text', '#' + st.color);
  set('--pv-bg', !st.bgOn ? 'transparent' : st.grad ? `linear-gradient(135deg, ${rgba(st.bg)}, ${rgba(st.bg2)})` : rgba(st.bg));
  set('--pv-owner', '#' + st.owner);
  set('--pv-shadow', st.shadow ? '0 1px 3px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)' : 'none');
  set('--pv-weight', String(st.weight));
  set('--pv-italic', st.italic ? 'italic' : 'normal');
  set('--pv-ls', st.ls + 'px');
  set('--pv-lh', String(st.lh / 100));
  set('--pv-radius', st.radius + 'px');
  set('--pv-pad', `${Math.round(st.pad / 4)}px ${st.pad}px`);
  set('--pv-gap', st.gap + 'px');
  set('--pv-maxw', st.layout === 'list' ? st.maxw + '%' : '100%');
  set('--pv-op', String(st.opacity / 100));
  set('--pv-ncaps', st.nickCaps ? 'uppercase' : 'none');
  set('--pv-sw', st.strokeOn ? st.strokeW + 'px' : '0px');
  set('--pv-sc', '#' + st.strokeC);
  set('--pv-bw', st.borderOn ? st.bw + 'px' : '0px');
  set('--pv-bc', '#' + st.bc);
  set('--pv-blur', st.bgOn ? st.blur + 'px' : '0px');
  set('--pv-glow', st.glowOn ? `0 0 ${st.glowS}px #${st.glowC}` : 'none');
  if (st.stripeOn) {
    set('--pv-stripe-w', st.stripeW + 'px');
    set('--pv-stripe-c', '#' + st.stripeC);
  } else {
    unset('--pv-stripe-w');
    unset('--pv-stripe-c');
  }
  set('--pv-align', { left: 'flex-start', center: 'center', right: 'flex-end' }[st.align]);
  set('--pv-talign', st.align);
  set('--pv-anim', { slide: 'pv-in', pop: 'pv-pop', fade: 'pv-fade', none: 'none' }[st.anim]);

  box.classList.toggle('pv-bar', st.layout === 'bar');
  box.classList.toggle('pv-row', st.layout === 'row');
  box.classList.toggle('pv-top', st.valign === 'top');
  box.classList.toggle('pv-nosrc', !st.showSrc);
}

function replayAnim() {
  const box = $('pvStage');
  box.classList.remove('replay');
  void box.offsetWidth;
  box.classList.add('replay');
  setTimeout(() => box.classList.remove('replay'), 700);
}

function pvLine(box, m) {
  const row = el('div', 'pv-msg');
  if (m.src) row.appendChild(el('span', 'pv-src', m.src));
  const nick = el('span', 'pv-nick' + (m.owner ? ' pv-nick--owner' : ''), m.owner ? myName : m.nick);
  if (!m.owner) {
    const c = m.color || (st.nickMode === 'auto' ? autoColor(m.nick) : null);
    if (st.nickPlate) {
      nick.classList.add('pv-plate');
      nick.style.background = c || 'rgba(255,255,255,.22)';
      if (c) nick.style.color = '#0b0b0f';
    } else if (c) {
      nick.style.color = c;
    }
  }
  row.append(nick, document.createTextNode(': ' + m.text));
  box.appendChild(row);
}

function drawItems(box, items) {
  box.innerHTML = '';
  applyStyle(box);
  // плоская плашка показывает только последнее сообщение
  (st.layout === 'bar' ? items.slice(-1) : items).forEach((m) => pvLine(box, m));
}

const SAMPLE = [
  { owner: true, text: 'Всем привет! Начинаем стрим' },
  { nick: 'Viewer1', text: 'Привет!' },
  { nick: 'viewer123', color: '#4ade80', src: 'twitch', text: 'Привет из твича 👋' },
  { nick: 'Бот', src: 'bot', text: '🎲 Viewer1, выпало 17 (из 30)' },
];

async function renderPreview() {
  const token = ++pvToken;
  const box = $('pvStage');
  const active = commands.filter((c) => c.enabled !== false).slice(0, 3);

  if (mode === 'cmds' && active.length) {
    applyStyle(box);
    const pairs = await Promise.all(active.map(async (c) => {
      const line = ('!' + c.name + ' ' + sampleArgs(c.args || [])).trim();
      let text = '…';
      try {
        text = (await api('/workbench/commands/preview', {
          method: 'POST',
          body: { name: c.name, args: c.args || [], response: c.response, line },
        })).text;
      } catch (_) {}
      return [{ nick: 'Viewer1', text: line }, { nick: 'Бот', src: 'bot', text }];
    }));
    if (token !== pvToken) return;
    drawItems(box, pairs.flat());
    return;
  }
  drawItems(box, SAMPLE);
}

// ---------- ссылка для OBS ----------

function buildParams() {
  const d = DEFAULTS;
  const p = [];
  if (st.layout !== 'list') p.push('layout=' + st.layout);
  if (st.valign === 'top') p.push('valign=top');
  if (st.align !== 'left') p.push('align=' + st.align);
  if (st.layout === 'list' && st.maxw !== 100) p.push('maxw=' + st.maxw);
  if (st.gap !== d.gap) p.push('gap=' + st.gap);
  if (st.opacity !== 100) p.push('opacity=' + st.opacity);

  if (st.size !== d.size) p.push('size=' + st.size);
  if (st.font) p.push('font=' + encodeURIComponent(st.font));
  if (st.weight !== d.weight) p.push('weight=' + st.weight);
  if (st.italic) p.push('italic=1');
  if (st.ls) p.push('ls=' + st.ls);
  if (st.lh !== d.lh) p.push('lh=' + st.lh);
  if (st.color !== d.color) p.push('color=' + st.color);
  if (!st.shadow) p.push('shadow=0');
  if (st.strokeOn) p.push('stroke=' + st.strokeC, 'strokew=' + st.strokeW);

  if (st.bgOn) {
    p.push('bg=' + st.bg, 'bgalpha=' + st.bgalpha);
    if (st.grad) p.push('bg2=' + st.bg2);
    if (st.blur) p.push('blur=' + st.blur);
  }
  if (st.radius !== d.radius) p.push('radius=' + st.radius);
  if (st.pad !== d.pad) p.push('pad=' + st.pad);
  if (st.borderOn) p.push('bc=' + st.bc, 'bw=' + st.bw);
  if (st.stripeOn) p.push('stripe=' + st.stripeC, 'stripew=' + st.stripeW);
  if (st.glowOn) p.push('glow=' + st.glowC, 'glows=' + st.glowS);

  if (st.owner !== d.owner) p.push('owner=' + st.owner);
  if (st.nickMode === 'auto') p.push('nickmode=auto');
  if (st.nickPlate) p.push('nickplate=1');
  if (st.nickCaps) p.push('ncaps=1');
  if (!st.showSrc) p.push('src=0');

  if (st.anim !== d.anim) p.push('anim=' + st.anim);
  if (st.fadeOn) p.push('fade=' + st.fade);
  if (st.max !== d.max) p.push('max=' + st.max);
  return p.join('&');
}

async function copyObsLink() {
  try {
    let key;
    try {
      key = (await api('/workbench/chat-key/reveal', { method: 'POST' })).chatApiKey;
    } catch (err) {
      if (!/не создан/.test(err.message || '')) throw err;
      const ok = await PW.confirm('Ключа чата ещё нет. Создать его сейчас?', { title: 'Нужен ключ чата', okText: 'Создать' });
      if (!ok) return;
      key = (await api('/workbench/chat-key/generate', { method: 'POST' })).chatApiKey;
    }
    const p = buildParams();
    const url = `${location.origin}/overlay/chat.html#key=${encodeURIComponent(key)}${p ? '&' + p : ''}`;
    await navigator.clipboard.writeText(url);
    PW.toast('Ссылка для OBS скопирована', 'success');
  } catch (e) {
    PW.toast(e.message || 'Не удалось скопировать', 'error');
  }
}

// ---------- команды ----------

const usageText = (args) => (args || []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ');

// для предпросмотра: числа для «число/кол-во», остальное — слово
function sampleArgs(args) {
  return (args || []).filter((a) => !a.optional).map((a) => (/чис|кол|num|count|^n$/i.test(a.name) ? '30' : 'тест')).join(' ');
}

async function loadCommands() {
  try { commands = await api('/workbench/commands'); }
  catch (e) { commands = []; PW.toast(e.message || 'Не удалось загрузить команды', 'error'); }
  renderCommands();
}

function iconBtn(svg, title, cls, onClick) {
  const b = el('button', 'cmd-ico ' + cls);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg; // статичная иконка из констант выше
  b.addEventListener('click', onClick);
  return b;
}

function renderCommands() {
  const body = $('cmdList');
  body.innerHTML = '';
  $('cmdEmpty').classList.toggle('hidden', commands.length > 0);
  $('cmdTable').classList.toggle('hidden', commands.length === 0);

  commands.forEach((c) => {
    const tr = el('tr', c.enabled === false ? 'cmd-off' : '');

    const tdEdit = el('td', 'cmd-td-ico');
    tdEdit.appendChild(iconBtn(ICON_EDIT, 'Редактировать', '', () => openCmdModal(c)));

    const tdName = el('td', 'cmd-td-name');
    tdName.appendChild(el('code', 'cmd-name', '!' + c.name));
    const u = usageText(c.args);
    if (u) tdName.appendChild(el('span', 'cmd-args-text', u));

    const tdResp = el('td', 'cmd-td-resp', c.response);
    const tdUses = el('td', 'cmd-td-uses', String(c.uses || 0));

    const tdSw = el('td', 'cmd-td-sw');
    tdSw.appendChild(makeSwitch(c.enabled !== false, (on, inp) => toggleCommand(c, on, inp, tr)));

    const tdDel = el('td', 'cmd-td-ico');
    tdDel.appendChild(iconBtn(ICON_TRASH, 'Удалить', 'cmd-ico--del', () => deleteCommand(c)));

    tr.append(tdEdit, tdName, tdResp, tdUses, tdSw, tdDel);
    body.appendChild(tr);
  });
  renderPreview();
}

async function toggleCommand(c, on, inp, tr) {
  try {
    const upd = await api('/workbench/commands/' + c._id, { method: 'PATCH', body: { enabled: on } });
    c.enabled = upd.enabled;
    tr.classList.toggle('cmd-off', c.enabled === false);
    renderPreview();
  } catch (e) {
    inp.checked = !on;
    PW.toast(e.message || 'Не удалось изменить', 'error');
  }
}

async function deleteCommand(c) {
  const ok = await PW.confirm(`Команда !${c.name} перестанет отвечать.`, { title: 'Удалить команду?', okText: 'Удалить', danger: true });
  if (!ok) return;
  try { await api('/workbench/commands/' + c._id, { method: 'DELETE' }); await loadCommands(); }
  catch (e) { PW.toast(e.message || 'Не удалось удалить', 'error'); }
}

// ----- окно команды -----

const cleanName = (s) => String(s || '').trim().replace(/^!+/, '').toLowerCase();

function showCmdError(text) {
  const err = $('cmdError');
  err.textContent = text;
  err.classList.remove('hidden');
}

function renderArgs() {
  const box = $('cmdArgs');
  box.innerHTML = '';
  modalArgs.forEach((a, i) => {
    const b = el('button', 'cmd-var cmd-var--arg', (a.optional ? `[${a.name}]` : `<${a.name}>`) + ' ×');
    b.type = 'button';
    b.title = 'Убрать аргумент';
    b.addEventListener('click', () => { modalArgs.splice(i, 1); onModalChanged(); });
    box.appendChild(b);
  });
  const name = cleanName($('cmdName').value) || 'команда';
  $('cmdUsage').textContent = 'Зритель напишет: ' + ['!' + name, usageText(modalArgs)].filter(Boolean).join(' ');
}

function renderVars() {
  const box = $('cmdVars');
  box.innerHTML = '';
  modalArgs.forEach((a) => {
    const b = el('button', 'cmd-var cmd-var--arg', `{${a.name}}`);
    b.type = 'button';
    b.title = 'Значение аргумента «' + a.name + '»';
    b.addEventListener('click', () => insertVar(`{${a.name}}`));
    box.appendChild(b);
  });
  VARS.forEach((x) => {
    const b = el('button', 'cmd-var', x.v);
    b.type = 'button';
    b.title = x.d;
    b.addEventListener('click', () => insertVar(x.v));
    box.appendChild(b);
  });
}

function buildExamples() {
  const box = $('cmdExamples');
  box.innerHTML = '';
  EXAMPLES.forEach((ex) => {
    const b = el('button', 'cmd-var cmd-var--ex', ex.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      $('cmdName').value = ex.name;
      $('cmdResp').value = ex.response;
      modalArgs = ex.args.map((a) => ({ ...a }));
      tryTouched = false;
      onModalChanged();
    });
    box.appendChild(b);
  });
}

function onModalChanged() {
  renderArgs();
  renderVars();
  if (!tryTouched) {
    const s = sampleArgs(modalArgs);
    $('cmdTry').value = '!' + (cleanName($('cmdName').value) || 'команда') + (s ? ' ' + s : '');
  }
  scheduleTry();
}

function insertVar(v) {
  const t = $('cmdResp');
  const a = t.selectionStart ?? t.value.length;
  const b = t.selectionEnd ?? a;
  t.value = (t.value.slice(0, a) + v + t.value.slice(b)).slice(0, 400);
  t.focus();
  t.selectionStart = t.selectionEnd = Math.min(a + v.length, t.value.length);
  scheduleTry();
}

function addCmdArg() {
  $('cmdError').classList.add('hidden');
  const inp = $('cmdArgName');
  const name = inp.value.trim().toLowerCase();
  if (!/^[a-z0-9_а-яё]{1,15}$/i.test(name)) return showCmdError('Название аргумента: 1–15 символов, буквы, цифры и _');
  if (modalArgs.length >= 5) return showCmdError('Аргументов может быть не больше 5');
  if (modalArgs.some((a) => a.name === name)) return showCmdError('Такой аргумент уже есть');
  modalArgs.push({ name, optional: $('cmdArgOpt').checked });
  inp.value = '';
  $('cmdArgOpt').checked = false;
  onModalChanged();
}

function scheduleTry() {
  clearTimeout(tryTimer);
  tryTimer = setTimeout(runTry, 250);
}

// проверку считает сервер — ровно так же, как ответит бот
async function runTry() {
  const name = cleanName($('cmdName').value);
  const line = $('cmdTry').value.trim() || '!' + (name || 'команда');
  let text = '…';
  try {
    text = (await api('/workbench/commands/preview', {
      method: 'POST',
      body: { name, args: modalArgs, response: $('cmdResp').value, line },
    })).text;
  } catch (e) {
    text = '⚠ ' + (e.message || 'ошибка');
  }
  drawItems($('cmdPreview'), [{ nick: 'Viewer1', text: line }, { nick: 'Бот', src: 'bot', text }]);
}

// c — объект команды (правка) или строка/undefined (новая: так вызывает data-click)
function openCmdModal(c) {
  editingCmd = c && typeof c === 'object' && c._id ? c : null;
  $('cmdModalTitle').textContent = editingCmd ? 'Редактировать команду' : 'Новая команда';
  $('cmdSubmitBtn').textContent = editingCmd ? 'Сохранить' : 'Создать';
  $('cmdName').value = editingCmd ? editingCmd.name : '';
  $('cmdResp').value = editingCmd ? editingCmd.response : '';
  $('cmdArgName').value = '';
  $('cmdArgOpt').checked = false;
  modalArgs = editingCmd ? (editingCmd.args || []).map((a) => ({ name: a.name, optional: !!a.optional })) : [];
  tryTouched = false;
  $('cmdError').classList.add('hidden');
  onModalChanged();
  $('cmdModal').classList.remove('hidden');
  $('cmdName').focus();
}
function closeCmdModal() {
  editingCmd = null;
  $('cmdModal').classList.add('hidden');
}

async function saveCommand() {
  $('cmdError').classList.add('hidden');
  const body = { name: cleanName($('cmdName').value), response: $('cmdResp').value.trim(), args: modalArgs };
  try {
    const wasEdit = !!editingCmd;
    if (editingCmd) await api('/workbench/commands/' + editingCmd._id, { method: 'PATCH', body });
    else await api('/workbench/commands', { method: 'POST', body });
    closeCmdModal();
    await loadCommands();
    PW.toast(wasEdit ? 'Команда сохранена' : 'Команда создана', 'success');
  } catch (e) {
    showCmdError(e.message || 'Не удалось сохранить');
  }
}

// ---------- выбор конструктора ----------

function pickCtor(m) {
  mode = m === 'cmds' ? 'cmds' : 'chat';
  $('ctorChat').classList.toggle('hidden', mode !== 'chat');
  $('ctorCmds').classList.toggle('hidden', mode !== 'cmds');
  $('ctorCopyBtn').classList.toggle('hidden', mode !== 'chat');
  document.querySelectorAll('.ctor-pick').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  renderPreview();
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

async function init() {
  try {
    const me = await api('/auth/me');
    if (!me.streamerName) { location.href = '/streamers/edit.html'; return; }
    myName = me.streamerName;
  } catch {
    location.href = '/';
    return;
  }

  sanitize();
  buildPresets();
  buildFields();
  buildExamples();

  $('cmdName').addEventListener('input', onModalChanged);
  $('cmdResp').addEventListener('input', scheduleTry);
  $('cmdTry').addEventListener('input', () => { tryTouched = true; scheduleTry(); });
  $('cmdArgName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCmdArg(); } });
  $('cmdModal').addEventListener('click', (e) => { if (e.target.id === 'cmdModal') closeCmdModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCmdModal(); });

  await loadCommands();
  pickCtor('chat');
}

init();