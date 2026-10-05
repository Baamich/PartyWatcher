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
  size: 22, font: '', weight: 400, color: 'ffffff', shadow: true,
  strokeOn: false, strokeC: '000000', strokeW: 2,
  bgOn: false, bg: '000000', bgalpha: 60, grad: false, bg2: '7c3aed',
  blur: 0, radius: 8, pad: 8,
  borderOn: false, bc: 'ffffff', bw: 1,
  owner: 'e5484d', align: 'left', gap: 6,
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
];

// dep — строка показывается, только когда включён родитель
const FIELDS = [
  { group: 'Текст' },
  { k: 'size', type: 'range', label: 'Размер текста', min: 10, max: 80, unit: 'px' },
  { k: 'font', type: 'text', label: 'Шрифт (установленный на ПК)', ph: 'Segoe UI' },
  { k: 'weight', type: 'select', num: true, label: 'Толщина', opts: [[400, 'Обычная'], [500, 'Средняя'], [700, 'Жирная'], [800, 'Очень жирная']] },
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

  { group: 'Ник и расположение' },
  { k: 'owner', type: 'color', label: 'Плашка на твоём нике' },
  { k: 'align', type: 'select', label: 'Прижать сообщения', opts: [['left', 'Влево'], ['right', 'Вправо']] },
  { k: 'gap', type: 'range', label: 'Расстояние между сообщениями', min: 0, max: 30, unit: 'px' },

  { group: 'Анимация и очистка' },
  { k: 'anim', type: 'select', label: 'Анимация появления', opts: [['slide', 'Выезд'], ['pop', 'Всплытие'], ['fade', 'Появление'], ['none', 'Без анимации']] },
  { k: 'fadeOn', type: 'switch', label: 'Сообщения исчезают' },
  { k: 'fade', type: 'number', label: 'Через сколько секунд', min: 1, max: 3600, dep: 'fadeOn' },
  { k: 'max', type: 'number', label: 'Сколько сообщений на экране', min: 5, max: 100 },
];

const VARS = [
  { v: '{user}', d: 'ник того, кто написал команду', sample: 'Viewer1' },
  { v: '{streamer}', d: 'имя канала', sample: null },
  { v: '{title}', d: 'название стрима', sample: 'Играем с друзьями' },
  { v: '{viewers}', d: 'сколько людей в чате', sample: '12' },
  { v: '{uptime}', d: 'сколько идёт эфир', sample: '1ч 05м' },
  { v: '{random}', d: 'случайное число 1–100', sample: '42' },
  { v: '{args}', d: 'текст после команды', sample: 'привет' },
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
  st.weight = [400, 500, 700, 800].includes(Number(st.weight)) ? Number(st.weight) : 400;
  st.align = st.align === 'right' ? 'right' : 'left';
  st.anim = ['slide', 'pop', 'fade', 'none'].includes(st.anim) ? st.anim : 'slide';
  ['color', 'bg', 'bg2', 'owner', 'strokeC', 'bc'].forEach((k) => { if (!HEX6.test(st[k])) st[k] = DEFAULTS[k]; });
  st.font = String(st.font || '').replace(/[^\p{L}\p{N} _-}]/gu, '').slice(0, 40);
  ['bgOn', 'grad', 'shadow', 'strokeOn', 'borderOn', 'fadeOn'].forEach((k) => { st[k] = !!st[k]; });
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
      const pick = el('input', 'ctor-color');
      pick.type = 'color';
      pick.value = '#' + st[f.k];
      const hex = el('input', 'ctor-hex');
      hex.value = '#' + st[f.k];
      hex.maxLength = 20;
      hex.spellcheck = false;
      hex.placeholder = '#ffffff или rgb(255,255,255)';
      pick.addEventListener('input', () => { hex.value = pick.value; setVal(f.k, pick.value.slice(1)); });
      hex.addEventListener('change', () => {
        const c = parseColor(hex.value);
        if (c) { pick.value = '#' + c; hex.value = '#' + c; setVal(f.k, c); }
        else hex.value = '#' + st[f.k];
      });
      ctl.append(pick, hex);
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

function applyStyle(box) {
  const a = st.bgalpha / 100;
  const rgba = (h) => `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
  const set = (k, v) => box.style.setProperty(k, v);
  set('--pv-fs', st.size + 'px');
  set('--pv-font', st.font ? `"${st.font}", 'Segoe UI', system-ui, sans-serif` : "'Segoe UI', system-ui, sans-serif");
  set('--pv-text', '#' + st.color);
  set('--pv-bg', !st.bgOn ? 'transparent' : st.grad ? `linear-gradient(135deg, ${rgba(st.bg)}, ${rgba(st.bg2)})` : rgba(st.bg));
  set('--pv-owner', '#' + st.owner);
  set('--pv-shadow', st.shadow ? '0 1px 3px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)' : 'none');
  set('--pv-weight', String(st.weight));
  set('--pv-radius', st.radius + 'px');
  set('--pv-pad', `${Math.round(st.pad / 4)}px ${st.pad}px`);
  set('--pv-gap', st.gap + 'px');
  set('--pv-sw', st.strokeOn ? st.strokeW + 'px' : '0px');
  set('--pv-sc', '#' + st.strokeC);
  set('--pv-bw', st.borderOn ? st.bw + 'px' : '0px');
  set('--pv-bc', '#' + st.bc);
  set('--pv-blur', st.bgOn ? st.blur + 'px' : '0px');
  set('--pv-align', st.align === 'right' ? 'flex-end' : 'flex-start');
  set('--pv-talign', st.align === 'right' ? 'right' : 'left');
  set('--pv-anim', { slide: 'pv-in', pop: 'pv-pop', fade: 'pv-fade', none: 'none' }[st.anim]);
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
  if (!m.owner && m.color) nick.style.color = m.color;
  row.append(nick, document.createTextNode(': ' + m.text));
  box.appendChild(row);
}

function fillVars(text) {
  const map = {};
  VARS.forEach((x) => { map[x.v.slice(1, -1)] = x.sample == null ? myName : x.sample; });
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));
}

const SAMPLE = [
  { owner: true, text: 'Всем привет! Начинаем стрим' },
  { nick: 'Viewer1', color: '#9146ff', text: 'Привет!' },
  { nick: 'viewer123', color: '#4ade80', src: 'twitch', text: 'Привет из твича 👋' },
  { nick: 'Бот', src: 'bot', text: '🎲 Viewer1, выпало 17 (из 30)' },
];

function renderPreview() {
  const box = $('pvStage');
  box.innerHTML = '';
  applyStyle(box);
  const active = commands.filter((c) => c.enabled !== false);
  if (mode === 'cmds' && active.length) {
    active.slice(0, 4).forEach((c) => {
      pvLine(box, { nick: 'Viewer1', color: '#9146ff', text: '!' + c.name });
      pvLine(box, { nick: 'Бот', src: 'bot', text: fillVars(c.response) });
    });
  } else {
    SAMPLE.forEach((m) => pvLine(box, m));
  }
}

// ---------- ссылка для OBS ----------

function buildParams() {
  const d = DEFAULTS;
  const p = [];
  if (st.size !== d.size) p.push('size=' + st.size);
  if (st.font) p.push('font=' + encodeURIComponent(st.font));
  if (st.weight !== d.weight) p.push('weight=' + st.weight);
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
  if (st.owner !== d.owner) p.push('owner=' + st.owner);
  if (st.align !== d.align) p.push('align=' + st.align);
  if (st.gap !== d.gap) p.push('gap=' + st.gap);
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

    const tdResp = el('td', 'cmd-td-resp', c.response);

    const tdSw = el('td', 'cmd-td-sw');
    tdSw.appendChild(makeSwitch(c.enabled !== false, (on, inp) => toggleCommand(c, on, inp, tr)));

    const tdDel = el('td', 'cmd-td-ico');
    tdDel.appendChild(iconBtn(ICON_TRASH, 'Удалить', 'cmd-ico--del', () => deleteCommand(c)));

    tr.append(tdEdit, tdName, tdResp, tdSw, tdDel);
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

function buildVars() {
  const box = $('cmdVars');
  VARS.forEach((x) => {
    const b = el('button', 'cmd-var', x.v);
    b.type = 'button';
    b.title = x.d;
    b.addEventListener('click', () => insertVar(x.v));
    box.appendChild(b);
  });
}

function insertVar(v) {
  const t = $('cmdResp');
  const a = t.selectionStart ?? t.value.length;
  const b = t.selectionEnd ?? a;
  t.value = (t.value.slice(0, a) + v + t.value.slice(b)).slice(0, 400);
  t.focus();
  t.selectionStart = t.selectionEnd = Math.min(a + v.length, t.value.length);
  updateCmdPreview();
}

function updateCmdPreview() {
  const box = $('cmdPreview');
  box.innerHTML = '';
  applyStyle(box);
  const name = $('cmdName').value.trim().replace(/^!+/, '') || 'команда';
  pvLine(box, { nick: 'Viewer1', color: '#9146ff', text: '!' + name });
  pvLine(box, { nick: 'Бот', src: 'bot', text: fillVars($('cmdResp').value || '…') });
}

// c — объект команды (правка) или строка/undefined (новая; так вызывает data-click)
function openCmdModal(c) {
  editingCmd = c && typeof c === 'object' && c._id ? c : null;
  $('cmdModalTitle').textContent = editingCmd ? 'Редактировать команду' : 'Новая команда';
  $('cmdSubmitBtn').textContent = editingCmd ? 'Сохранить' : 'Создать';
  $('cmdName').value = editingCmd ? editingCmd.name : '';
  $('cmdResp').value = editingCmd ? editingCmd.response : '';
  $('cmdError').classList.add('hidden');
  updateCmdPreview();
  $('cmdModal').classList.remove('hidden');
  $('cmdName').focus();
}
function closeCmdModal() {
  editingCmd = null;
  $('cmdModal').classList.add('hidden');
}

async function saveCommand() {
  const name = $('cmdName').value.trim().replace(/^!+/, '');
  const response = $('cmdResp').value.trim();
  const err = $('cmdError');
  err.classList.add('hidden');
  try {
    if (editingCmd) {
      await api('/workbench/commands/' + editingCmd._id, { method: 'PATCH', body: { name, response } });
    } else {
      await api('/workbench/commands', { method: 'POST', body: { name, response } });
    }
    const wasEdit = !!editingCmd;
    closeCmdModal();
    await loadCommands();
    PW.toast(wasEdit ? 'Команда сохранена' : 'Команда создана', 'success');
  } catch (e) {
    err.textContent = e.message || 'Не удалось сохранить';
    err.classList.remove('hidden');
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
  buildVars();
  $('cmdName').addEventListener('input', updateCmdPreview);
  $('cmdResp').addEventListener('input', updateCmdPreview);
  $('cmdModal').addEventListener('click', (e) => { if (e.target.id === 'cmdModal') closeCmdModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCmdModal(); });

  await loadCommands();
  pickCtor('chat');
}

init();