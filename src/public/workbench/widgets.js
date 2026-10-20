// Студия → ⏱️ Виджеты: виджеты для OBS (время эфира, таймеры, счётчики, цели, бегущая строка, титры…).
// Справа — «Добавить», на холсте — карточка на каждый виджет: живое превью, кнопки управления, ⚙ настройки,
// 📋 ссылка для OBS. Изменения приходят сокетом /alerts (их же видят OBS и мини-пульт) — команды чата тоже
const C = window.PWWidgetCatalog;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let st = { widgets: [], layout: null, live: null, stats: null, last: {}, max: C.MAX_WIDGETS, key: null };
let win = null;
let socket = null;
const cards = new Map(); // id → { view, controls, w }

const typeName = (type) => t('widgets.type.' + type + '.name');
const titleOf = (w) => (C.typeById(w.type)?.icon || '') + ' ' + (w.name || typeName(w.type));

// ---------- ключ (тот же, что у алертов) ----------
async function fullKey() {
  if (st.key) return st.key;
  try {
    st.key = (await api('/alerts/key')).key;
  } catch (err) {
    if (err.status !== 404) throw err;
    st.key = (await api('/alerts/key', { method: 'POST' })).key;
  }
  document.getElementById('wgKey').textContent = '••••••••' + st.key.slice(-4);
  return st.key;
}
const overlayUrl = (w, key) => location.origin + '/overlay/widget.html?key=' + encodeURIComponent(key) + '&w=' + encodeURIComponent(w.id) + '&lang=' + (window.I18N?.lang || 'ru');

async function copy(text, okKey) {
  try {
    await navigator.clipboard.writeText(text);
    PW.toast(t(okKey), 'success');
  } catch (_) {
    await PW.prompt(t('widgets.copyManual'), { defaultValue: text });
  }
}

// ---------- сохранение ----------
const act = (w, action, arg) => api('/widgets/' + w.id + '/action', { method: 'POST', body: { action, arg } }).then((r) => onWidget(r.widget));
const saveTimers = {};
function saveWidget(w, now = false) {
  clearTimeout(saveTimers[w.id]);
  const run = async () => {
    try {
      const r = await api('/widgets/' + w.id, { method: 'PUT', body: { name: w.name, slug: w.slug, style: w.style, opts: w.opts } });
      onWidget(r.widget, true);
    } catch (err) {
      PW.toast(err.message, 'error');
    }
  };
  if (now) return run();
  saveTimers[w.id] = setTimeout(run, 400);
}
let layoutTimer = null;
function saveLayout(panels) {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => api('/widgets/layout', { method: 'PUT', body: { panels } }).catch(() => {}), 500);
}

// пришёл виджет (ответ сервера или сокет). fromEdit — свои правки из окна настроек: окно не перерисовываем
function onWidget(w, fromEdit = false) {
  if (!w) return;
  const i = st.widgets.findIndex((x) => x.id === w.id);
  if (i < 0) st.widgets.push(w);
  else if (!fromEdit || !editing || editing.id !== w.id) st.widgets[i] = w;
  else st.widgets[i] = { ...editing, state: w.state };
  renderCard(i < 0 ? w : st.widgets[i]);
  renderPicker();
}

// ---------- карточки ----------
function fitPreview(box, view) {
  requestAnimationFrame(() => {
    const el = view.root;
    el.style.transform = '';
    const sw = el.scrollWidth || 1;
    const sh = el.scrollHeight || 1;
    const k = Math.min(1, (box.clientWidth - 12) / sw, (box.clientHeight - 12) / sh);
    el.style.transform = k > 0 && k < 1 ? `scale(${k})` : '';
  });
}

function renderCard(w) {
  const p = win.open(w.id, 'wg-card');
  p.title.textContent = titleOf(w);
  p.close.title = t('widgets.card.delete');
  let c = cards.get(w.id);
  if (!c || c.type !== w.type || c.content !== p.content) {
    c?.view.destroy();
    p.content.innerHTML = `
      <div class="wg-preview"></div>
      <div class="wg-controls"></div>
      <div class="wg-cmd"></div>
      <div class="wg-bottom">
        <button type="button" class="icon-btn wg-edit">${esc(t('widgets.card.settings'))}</button>
        <button type="button" class="icon-btn wg-copy">${esc(t('widgets.card.copy'))}</button>
        <button type="button" class="icon-btn wg-pub" title="${esc(t('widgets.card.publish'))}">📤</button>
      </div>`;
    const prev = p.content.querySelector('.wg-preview');
    const view = PWWidgetRender.create(prev, { preview: true, credits: creditsData });
    view.ctx(previewCtx());
    p.content.querySelector('.wg-edit').addEventListener('click', () => openSettings(w.id));
    p.content.querySelector('.wg-pub').addEventListener('click', () => PWPresets.openPublish({ type: 'widget', widgetId: w.id }));
    p.content.querySelector('.wg-copy').addEventListener('click', async () => {
      const cur = st.widgets.find((x) => x.id === w.id);
      try {
        await copy(overlayUrl(cur, await fullKey()), 'widgets.card.copied');
      } catch (err) {
        PW.toast(err.message, 'error');
      }
    });
    c = { type: w.type, content: p.content, view, controls: null, prev, ctlBox: p.content.querySelector('.wg-controls') };
    cards.set(w.id, c);
    // и окно карточки, и сам виджет (строки «по очереди» разной длины): transform на размер блока не влияет — петли нет
    if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(() => fitPreview(prev, view)); ro.observe(prev); ro.observe(view.root); }
  }
  c.view.set(w);
  fitPreview(c.prev, c.view);
  // кнопки управления зависят от настроек (шаг счётчика, источник цели) — их пересобираем только при смене настроек
  const optsKey = JSON.stringify(w.opts);
  if (!c.controls || c.optsKey !== optsKey) {
    c.controls = PWWidgetControls.build(c.ctlBox, w, { act: (a, arg) => act(st.widgets.find((x) => x.id === w.id) || w, a, arg) });
    c.optsKey = optsKey;
  } else c.controls.refresh(w);
  const cmd = PWWidgetControls.commandOf(w, st.widgets);
  const cmdBox = p.content.querySelector('.wg-cmd');
  cmdBox.textContent = cmd ? t('widgets.card.cmd', { cmd }) : '';
  cmdBox.hidden = !cmd;
}

function removeCard(id) {
  cards.get(id)?.view.destroy();
  cards.delete(id);
  win.close(id);
}

async function deleteWidget(id) {
  const w = st.widgets.find((x) => x.id === id);
  if (!w) return;
  const ok = await PW.confirm(t('widgets.card.deleteConfirm', { name: w.name || typeName(w.type) }), { danger: true, okText: t('common.delete') });
  if (!ok) return;
  try {
    await api('/widgets/' + id, { method: 'DELETE' });
    st.widgets = st.widgets.filter((x) => x.id !== id);
    removeCard(id);
    renderPicker();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// превью: настоящие данные канала; событий ещё не было — примеры, чтобы было видно, как выглядит {last_…}
function previewCtx() {
  const sample = C.sampleCtx();
  const last = { ...sample.last, ...st.last };
  return { live: st.live, stats: st.stats, last };
}

// титры в превью — те же данные, что у OBS
function creditsData() {
  return new Promise((resolve) => {
    if (!socket) return resolve(null);
    socket.timeout(8000).emit('widget:credits', {}, (e, r) => resolve(e ? null : r?.credits || null));
  });
}

// ---------- справа: добавить ----------
function renderPicker() {
  const box = document.getElementById('wgTypes');
  box.replaceChildren();
  const full = st.widgets.length >= st.max;
  // свой виджет — отдельной большой кнопкой сверху
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'wg-create';
  create.disabled = full;
  create.innerHTML = `<b>${esc(t('widgets.create.btn'))}</b><small>${esc(t('widgets.create.desc'))}</small>`;
  create.addEventListener('click', () => addWidget('custom'));
  box.appendChild(create);
  for (const type of C.TYPES) {
    if (type.id === 'custom') continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wg-type';
    b.disabled = full;
    b.innerHTML = `<span class="wg-type-icon">${type.icon}</span><span><b>${esc(typeName(type.id))}</b><small>${esc(t('widgets.type.' + type.id + '.desc'))}</small></span>`;
    b.addEventListener('click', () => addWidget(type.id));
    box.appendChild(b);
  }
  document.getElementById('wgCount').textContent = t('widgets.picker.count', { n: st.widgets.length, max: st.max });
}

async function addWidget(type) {
  try {
    const r = await api('/widgets', { method: 'POST', body: { type } });
    onWidget(r.widget);
    win.get(r.widget.id)?.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    openSettings(r.widget.id);
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// ---------- окно настроек ----------
let editing = null; // копия виджета, которую правит окно настроек

function modal(title, build, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'cw-modal';
  wrap.innerHTML = `<div class="cw-modal-box wg-modal"><button type="button" class="cw-modal-x" aria-label="${esc(t('common.close'))}">×</button>
    <h3>${esc(title)}</h3><div class="cw-modal-body"></div></div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.querySelector('.cw-modal-x').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  build(wrap.querySelector('.cw-modal-body'), close);
}

// поля настроек по типам: [ключ, вид, параметры]
const OPT_FIELDS = {
  uptime: [['prefix', 'text'], ['format', 'select', ['hms', 'hm']], ['offline', 'select', ['text', 'hide', 'zero']], ['offlineText', 'text']],
  countdown: [['sec', 'duration'], ['prefix', 'text'], ['endText', 'text'], ['endHide', 'check'], ['bar', 'check'], ['sound', 'sound'], ['volume', 'range', 0, 100]],
  stopwatch: [['prefix', 'text']],
  clock: [['h12', 'check'], ['seconds', 'check'], ['date', 'check'], ['tz', 'tz']],
  text: [],
  ticker: [['speed', 'range', 20, 400], ['sep', 'text']],
  counter: [['template', 'text'], ['step', 'number', 1, 1000], ['negative', 'check']],
  goal: [['source', 'select', C.GOAL_SOURCES], ['title', 'text'], ['target', 'number', 1, 1e9], ['numbers', 'check'], ['barH', 'range', 4, 80], ['endText', 'text']],
  stat: [['source', 'select', C.STAT_SOURCES], ['template', 'text']],
  last: [['event', 'select', C.LAST_EVENTS], ['count', 'number', 1, 10], ['template', 'text'], ['empty', 'text']],
  credits: [['title', 'text'], ['endText', 'text'], ['speed', 'range', 20, 300], ['auto', 'check'], ['loop', 'check'], ['sections', 'sections']],
  custom: [['examples', 'examples'], ['lines', 'lines'], ['mode', 'select', ['all', 'rotate']], ['rotateSec', 'number', 2, 120], ['layout', 'select', ['column', 'row']],
    ['showWhen', 'select', C.SHOW_WHEN], ['hideEmpty', 'check'], ['anim', 'select', C.LINE_ANIMS], ['bar', 'check'], ['barValue', 'text'], ['barMax', 'text'], ['barH', 'range', 4, 80]],
};

// готовые заготовки «своего виджета»: строки — из словаря (widgets.ex.<id>.lines, через \n)
const nextNewYear = () => (new Date().getFullYear() + 1) + '-01-01 00:00';
const CUSTOM_EXAMPLES = [
  { id: 'info', opts: { mode: 'rotate', rotateSec: 6 } },
  { id: 'lastAll', opts: { mode: 'all' } },
  { id: 'wheel', opts: { mode: 'all', anim: 'pop' } },
  { id: 'newYear', opts: { mode: 'all' }, vars: () => ({ date: nextNewYear() }) },
  { id: 'subGoal', opts: { mode: 'all', bar: true, barValue: '{followers_stream}', barMax: '10' } },
  { id: 'nowPlaying', opts: { mode: 'all' } },
  { id: 'worldClock', opts: { mode: 'all', layout: 'row' } },
];
function applyExample(w, ex) {
  const lines = t('widgets.ex.' + ex.id + '.lines', ex.vars ? ex.vars() : undefined).split('\n').map((text, i) => ({ text, size: i === 0 ? 100 : 80, bold: i === 0, color: '' }));
  w.opts = C.cleanOpts('custom', { ...C.cleanOpts('custom', {}), ...ex.opts, lines });
  // название — от заготовки, если своего ещё не придумали (пусто, «Свой виджет» или имя другой заготовки)
  const auto = !w.name || w.name === typeName('custom') || CUSTOM_EXAMPLES.some((x) => t('widgets.ex.' + x.id + '.name') === w.name);
  if (auto) w.name = t('widgets.ex.' + ex.id + '.name');
}

// редактор строк своего виджета: текст, размер, жирный, цвет; подсказки переменных вставляются в строку под курсором
function linesEditor(w, changed, redraw) {
  const box = document.createElement('div');
  box.className = 'wg-lines';
  let focused = null;
  w.opts.lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'wg-line-row';
    const text = input('text', l.text, { maxLength: C.LIMITS.line, placeholder: t('widgets.create.linePh') });
    text.className = 'wg-line-text';
    text.addEventListener('focus', () => { focused = text; });
    text.addEventListener('input', () => { l.text = text.value; changed(); });
    const opts = document.createElement('div');
    opts.className = 'wg-line-opts';
    const size = input('range', l.size, { min: 30, max: 300, title: t('widgets.create.lineSize') });
    const sizeV = document.createElement('b');
    sizeV.textContent = l.size + '%';
    size.addEventListener('input', () => { l.size = Number(size.value); sizeV.textContent = l.size + '%'; changed(); });
    const bold = document.createElement('label');
    const boldCb = input('checkbox', l.bold);
    boldCb.addEventListener('change', () => { l.bold = boldCb.checked; changed(); });
    const boldS = document.createElement('span');
    boldS.textContent = t('widgets.create.lineBold');
    bold.append(boldCb, boldS);
    const color = input('color', l.color || w.style.color, { title: t('widgets.create.lineColor') });
    color.addEventListener('input', () => { l.color = color.value; changed(); });
    const resetColor = document.createElement('button');
    resetColor.type = 'button';
    resetColor.className = 'icon-btn';
    resetColor.textContent = '⟲';
    resetColor.title = t('widgets.create.lineColorReset');
    resetColor.addEventListener('click', () => { l.color = ''; color.value = w.style.color; changed(); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '🗑';
    del.title = t('widgets.create.lineDelete');
    del.disabled = w.opts.lines.length <= 1;
    del.addEventListener('click', () => { w.opts.lines.splice(i, 1); changed(); redraw(); });
    opts.append(size, sizeV, bold, color, resetColor, del);
    row.append(text, opts);
    box.appendChild(row);
    if (!focused) focused = text;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'icon-btn';
  add.textContent = t('widgets.create.lineAdd');
  add.disabled = w.opts.lines.length >= C.LIMITS.lines;
  add.addEventListener('click', () => { w.opts.lines.push({ text: '', size: 100, bold: false, color: '' }); changed(); redraw(); });
  box.appendChild(add);

  // подсказки: переменные и функции (клик — вставить в строку под курсором)
  const insert = (v) => {
    const el = focused || box.querySelector('.wg-line-text');
    if (!el) return;
    const p = el.selectionStart ?? el.value.length;
    el.value = (el.value.slice(0, p) + v + el.value.slice(p)).slice(0, C.LIMITS.line);
    el.dispatchEvent(new Event('input'));
    el.focus();
  };
  const chips = (title, list) => {
    const h = document.createElement('div');
    h.className = 'am-sec';
    h.textContent = t(title);
    const wrap = document.createElement('div');
    wrap.className = 'wg-chips';
    for (const [v, k] of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tm-chip';
      b.textContent = v;
      b.title = t('widgets.var.' + k);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); insert(v); });
      wrap.appendChild(b);
    }
    box.append(h, wrap);
  };
  chips('widgets.create.vars', C.CUSTOM_VARS.map((k) => ['{' + k + '}', k]));
  chips('widgets.create.funcs', C.CUSTOM_FUNCS);
  return box;
}

// подсказка в пустом поле — что будет показано по умолчанию
function placeholderOf(w, key) {
  const o = w.opts;
  const map = {
    offlineText: 'widgets.def.offline', endText: w.type === 'countdown' ? 'widgets.def.countdownEnd' : w.type === 'credits' ? 'widgets.def.creditsEnd' : 'widgets.opt.endTextPh',
    title: w.type === 'goal' ? 'widgets.def.goal.' + o.source : 'widgets.def.creditsTitle',
    template: w.type === 'stat' ? 'widgets.def.stat.' + o.source : w.type === 'last' ? 'widgets.def.last.' + o.event : 'widgets.opt.templatePh',
    empty: 'widgets.def.lastEmpty', prefix: 'widgets.opt.prefixPh', barValue: 'widgets.opt.barValuePh', barMax: 'widgets.opt.barMaxPh',
  };
  return map[key] ? t(map[key]) : '';
}
// переменные шаблона — чипы под полем
function varsOf(w, key) {
  if (key !== 'template') return [];
  if (w.type === 'last') return (window.PWAlertCatalog?.eventById(w.opts.event)?.vars || []).map((v) => '{' + v + '}');
  return ['{n}'];
}

const TZ_FALLBACK = ['UTC', 'Europe/Berlin', 'Europe/London', 'Europe/Kyiv', 'Europe/Moscow', 'Europe/Minsk', 'Asia/Almaty', 'Asia/Yekaterinburg',
  'Asia/Novosibirsk', 'Asia/Vladivostok', 'Asia/Tashkent', 'Asia/Tbilisi', 'Asia/Kolkata', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
const zones = () => { try { return Intl.supportedValuesOf('timeZone'); } catch (_) { return TZ_FALLBACK; } };

function field(labelKey, control, hint) {
  const lab = document.createElement('label');
  lab.className = 'wg-field';
  const s = document.createElement('span');
  s.textContent = t(labelKey);
  lab.append(s, control);
  if (hint) {
    const h = document.createElement('small');
    h.textContent = hint;
    lab.appendChild(h);
  }
  return lab;
}
function input(type, value, attrs = {}) {
  const el = document.createElement('input');
  el.type = type;
  Object.assign(el, attrs);
  if (type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
  return el;
}
function select(values, value, label) {
  const el = document.createElement('select');
  for (const v of values) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = label(v);
    o.selected = String(v) === String(value);
    el.appendChild(o);
  }
  return el;
}

function openSettings(id) {
  const orig = st.widgets.find((x) => x.id === id);
  if (!orig) return;
  editing = JSON.parse(JSON.stringify(orig));
  const w = editing;
  modal(titleOf(w), (body) => {
    body.innerHTML = '<div class="wg-modal-preview"></div><div class="wg-form"></div>';
    const pbox = body.querySelector('.wg-modal-preview');
    const view = PWWidgetRender.create(pbox, { preview: true, credits: creditsData });
    view.ctx(previewCtx());
    const preview = () => { view.set(w); fitPreview(pbox, view); };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitPreview(pbox, view)).observe(view.root);
    const changed = (redraw) => { preview(); saveWidget(w); if (redraw) drawForm(); };
    const form = body.querySelector('.wg-form');

    function drawForm() {
      form.replaceChildren();
      const sec = (k) => { const d = document.createElement('div'); d.className = 'am-sec'; d.textContent = t(k); form.appendChild(d); };

      // имя и команда
      const name = input('text', w.name, { maxLength: C.LIMITS.name, placeholder: typeName(w.type) });
      name.addEventListener('input', () => { w.name = name.value; changed(); });
      form.appendChild(field('widgets.opt.name', name));
      if (C.typeById(w.type).cmd) {
        const slug = input('text', w.slug, { maxLength: C.LIMITS.slug });
        slug.addEventListener('change', () => {
          const v = slug.value.trim().toLowerCase();
          if (!C.SLUG_RE.test(v)) { slug.value = w.slug; return PW.toast(t('widgets.opt.slugBad'), 'error'); }
          w.slug = v;
          saveWidget(w, true);
        });
        form.appendChild(field('widgets.opt.slug', slug, t('widgets.opt.slugHint', { cmd: '/' + C.typeById(w.type).cmd + ' ' + w.slug })));
      }

      // настройки типа
      const fields = OPT_FIELDS[w.type] || [];
      if (fields.length) sec('widgets.opt.section');
      for (const [key, kind, a, b] of fields) {
        const label = 'widgets.opt.' + key;
        const o = w.opts;
        let el;
        if (kind === 'lines') {
          form.appendChild(linesEditor(w, changed, drawForm));
          continue;
        }
        if (kind === 'examples') {
          const wrap = document.createElement('div');
          wrap.className = 'wg-chips';
          for (const ex of CUSTOM_EXAMPLES) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tm-chip wg-ex';
            b.textContent = t('widgets.ex.' + ex.id + '.name');
            b.addEventListener('click', () => { applyExample(w, ex); changed(true); });
            wrap.appendChild(b);
          }
          form.appendChild(field('widgets.create.examples', wrap));
          continue;
        }
        if ((key === 'rotateSec' && o.mode !== 'rotate') || ((key === 'barValue' || key === 'barMax' || key === 'barH') && !o.bar)) continue;
        if (kind === 'text') {
          el = input('text', o[key], { maxLength: C.LIMITS.template, placeholder: placeholderOf(w, key) });
          el.addEventListener('input', () => { o[key] = el.value; changed(); });
          const vars = varsOf(w, key);
          form.appendChild(field(label, el, vars.length ? t('widgets.opt.vars', { vars: vars.join(' ') }) : ''));
          continue;
        }
        if (kind === 'check') {
          el = input('checkbox', o[key]);
          el.addEventListener('change', () => { o[key] = el.checked; changed(key === 'bar'); });
          const lab = field(label, el);
          lab.classList.add('wg-check');
          form.appendChild(lab);
          continue;
        }
        if (kind === 'select') {
          el = select(a, o[key], (v) => t('widgets.opt.' + key + 'Opt.' + v));
          el.addEventListener('change', () => { o[key] = el.value; changed(true); });
        } else if (kind === 'number') {
          el = input('number', o[key], { min: a, max: b });
          el.addEventListener('change', () => { o[key] = Math.min(b, Math.max(a, Math.round(Number(el.value)) || a)); el.value = o[key]; changed(); });
        } else if (kind === 'range') {
          el = document.createElement('div');
          el.className = 'wg-range';
          const r = input('range', o[key], { min: a, max: b });
          const v = document.createElement('b');
          v.textContent = o[key];
          r.addEventListener('input', () => { o[key] = Number(r.value); v.textContent = r.value; changed(); });
          el.append(r, v);
        } else if (kind === 'duration') {
          el = input('text', C.fmtDuration(o.sec * 1000), { maxLength: 10 });
          el.addEventListener('change', () => {
            const s = /^\d{1,4}$/.test(el.value.trim()) ? Number(el.value.trim()) * 60 : C.parseSpan(el.value);
            if (!s || s > 86400) { el.value = C.fmtDuration(o.sec * 1000); return PW.toast(t('widgets.ctl.badTime'), 'error'); }
            o.sec = s;
            el.value = C.fmtDuration(s * 1000);
            changed();
          });
          form.appendChild(field(label, el, t('widgets.opt.secHint')));
          continue;
        } else if (kind === 'sound') {
          el = document.createElement('div');
          el.className = 'wg-range';
          const s = select(C.SOUNDS, o.sound, (v) => t(v === 'none' ? 'widgets.opt.soundNone' : 'alerts.sound.' + v));
          const play = document.createElement('button');
          play.type = 'button';
          play.className = 'icon-btn';
          play.textContent = '▶';
          play.title = t('widgets.opt.listen');
          play.addEventListener('click', () => { if (o.sound !== 'none') PWAlertRender.playSound(o.sound, o.volume); });
          s.addEventListener('change', () => { o.sound = s.value; changed(); if (o.sound !== 'none') PWAlertRender.playSound(o.sound, o.volume); });
          el.append(s, play);
        } else if (kind === 'tz') {
          const list = zones();
          el = select(['', ...list], o.tz, (v) => (v ? v.replace(/_/g, ' ') : t('widgets.opt.tzLocal')));
          el.addEventListener('change', () => { o.tz = el.value; changed(); });
        } else if (kind === 'sections') {
          el = document.createElement('div');
          el.className = 'wg-checks';
          for (const s of C.CREDIT_SECTIONS) {
            const cb = input('checkbox', o.sections[s]);
            cb.addEventListener('change', () => { o.sections[s] = cb.checked; changed(); });
            const lab = document.createElement('label');
            const sp = document.createElement('span');
            sp.textContent = t('widgets.credits.' + s);
            lab.append(cb, sp);
            el.appendChild(lab);
          }
        }
        form.appendChild(field(label, el));
      }

      // внешний вид
      sec('widgets.style.section');
      const s = w.style;
      const row = document.createElement('div');
      row.className = 'wg-style-grid';
      const font = select(Object.keys(C.FONTS), s.font, (v) => (v === 'system' ? t('widgets.style.fontSystem') : C.FONTS[v].split(',')[0].replace(/'/g, '')));
      font.addEventListener('change', () => { s.font = font.value; changed(); });
      row.appendChild(field('widgets.style.font', font));
      const range = (key, min, max) => {
        const box = document.createElement('div');
        box.className = 'wg-range';
        const r = input('range', s[key], { min, max });
        const v = document.createElement('b');
        v.textContent = s[key];
        r.addEventListener('input', () => { s[key] = Number(r.value); v.textContent = r.value; changed(); });
        box.append(r, v);
        row.appendChild(field('widgets.style.' + key, box));
      };
      range('size', 10, 200);
      const weight = select(C.WEIGHTS, s.weight, (v) => t('widgets.style.weightOpt.' + v));
      weight.addEventListener('change', () => { s.weight = Number(weight.value); changed(); });
      row.appendChild(field('widgets.style.weight', weight));
      const align = select(C.ALIGNS, s.align, (v) => t('widgets.style.alignOpt.' + v));
      align.addEventListener('change', () => { s.align = align.value; changed(); });
      row.appendChild(field('widgets.style.align', align));
      const colorEl = (key) => {
        const c = input('color', s[key]);
        c.addEventListener('input', () => { s[key] = c.value; changed(); });
        row.appendChild(field('widgets.style.' + key, c));
      };
      colorEl('color');
      colorEl('accent');
      colorEl('bg');
      range('bgAlpha', 0, 100);
      range('pad', 0, 60);
      range('radius', 0, 60);
      range('stroke', 0, 8);
      colorEl('strokeColor');
      form.appendChild(row);
      const checks = document.createElement('div');
      checks.className = 'wg-checks';
      for (const key of ['shadow', 'upper']) {
        const cb = input('checkbox', s[key]);
        cb.addEventListener('change', () => { s[key] = cb.checked; changed(); });
        const lab = document.createElement('label');
        const sp = document.createElement('span');
        sp.textContent = t('widgets.style.' + key);
        lab.append(cb, sp);
        checks.appendChild(lab);
      }
      form.appendChild(checks);

      if (w.type === 'credits') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.textContent = t('widgets.opt.creditsPreview');
        b.addEventListener('click', () => view.runCredits());
        form.appendChild(b);
      }
    }
    drawForm();
    preview();
  }, () => {
    const w2 = editing;
    editing = null;
    if (w2) saveWidget(w2, true);
  });
}

async function resetCardsLayout() {
  const ok = await PW.confirm(t('widgets.layoutReset'));
  if (!ok) return;
  win.resetPanels();
  api('/widgets/layout', { method: 'DELETE' }).catch(() => {});
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

// ---------- сокет: то же, что видит OBS (команды чата, мини-пульт, другие вкладки) ----------
function connect(key) {
  socket = io('/alerts', { transports: ['websocket', 'polling'], tryAllTransports: true, reconnection: true });
  socket.on('connect', () => socket.emit('widget:join', { key }));
  socket.on('widget:init', (d) => {
    PWWidgetRender.syncClock(d.now);
    st.live = d.live;
    st.stats = d.stats;
    st.last = d.last || {};
    cards.forEach((c) => c.view.ctx(previewCtx(), d.now));
    for (const w of d.widgets || []) if (!editing || editing.id !== w.id) onWidget(w);
  });
  socket.on('widget:update', (d) => {
    PWWidgetRender.syncClock(d.now);
    if (editing && editing.id === d.widget?.id) {
      editing.state = d.widget.state; // окно настроек открыто: настройки — свои, состояние — с сервера
      return onWidget({ ...editing }, true);
    }
    onWidget(d.widget);
  });
  socket.on('widget:remove', (d) => {
    st.widgets = st.widgets.filter((x) => x.id !== d.id);
    removeCard(d.id);
    renderPicker();
  });
  socket.on('widget:last', (d) => {
    st.last = d.last || {};
    cards.forEach((c) => c.view.ctx(previewCtx(), d.now));
  });
  socket.on('widget:stats', (d) => {
    if (d.live) st.live = d.live;
    if (d.stats) st.stats = d.stats;
    cards.forEach((c) => c.view.ctx({ ...(d.live && { live: d.live }), ...(d.stats && { stats: d.stats }) }, d.now));
  });
}

(async function init() {
  const canvas = document.getElementById('cwCanvas');
  const picker = document.getElementById('cwPicker');
  const topBar = document.getElementById('cwTopBar');
  win = PWCanvasWindows.create({
    canvas, picker, topBar, minW: 260, minH: 220,
    defRect: (id) => PWCanvasWindows.gridRect({ index: Math.max(0, st.widgets.findIndex((w) => w.id === id)), picker, topBar, w: 320, h: 340 }),
    onLayout: saveLayout,
    onClose: (id) => deleteWidget(id),
  });
  document.getElementById('wgFloat').addEventListener('click', () => PWFloat.open());
  document.getElementById('wgDock').addEventListener('click', () => copy(location.origin + '/workbench/float.html', 'widgets.float.dockCopied'));
  try {
    const d = await api('/widgets');
    PWWidgetRender.syncClock(d.now);
    st = { ...st, widgets: d.widgets, layout: d.layout, live: d.live, stats: d.stats, last: d.last || {}, max: d.max };
  } catch (err) {
    PW.toast(err.message, 'error');
    return;
  }
  win.setPanels(st.layout?.panels);
  renderPicker();
  for (const w of st.widgets) renderCard(w);
  try {
    connect(await fullKey());
  } catch (err) {
    PW.toast(err.message, 'error');
  }
  window.addEventListener('pw:langchange', () => {
    renderPicker();
    for (const w of st.widgets) { cards.get(w.id)?.view.destroy(); cards.delete(w.id); win.close(w.id); renderCard(w); }
  });
})();
