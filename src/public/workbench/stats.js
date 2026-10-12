// Студия → 📊 Статистика: окна-показатели, как окна студии (двигать за заголовок, тянуть за угол).
// Справа — период и галочки: какие окна показывать. Раскладка и галочки хранятся на сервере (/workbench/stats-layout)
let statsData = null;
let statsDays = 30;
try { statsDays = localStorage.getItem('pw-stats-days') === '7' ? 7 : 30; } catch {}

// окна: id, подпись (stats.<id>), подсказка под числом (stats.sub.<id>). Порядок = порядок галочек и мест по умолчанию
const TILE_W = 200, TILE_H = 116, GAP = 12, X0 = 220;
const STATS = ['hours', 'streams', 'avgViewers', 'peakViewers', 'newFollowers', 'followers', 'watchHours', 'chatMessages', 'avgDuration', 'chatters', 'sessions'].map((id) => ({ id }));
const DEFAULT_SHOWN = ['hours', 'streams', 'avgViewers', 'peakViewers', 'newFollowers', 'followers', 'watchHours', 'chatMessages', 'sessions'];

// место по умолчанию: плитки сеткой от меню до панели галочек (сколько влезет в ширину), таблица — под ними
function defRect(id) {
  const avail = (document.getElementById('stPicker')?.offsetLeft || 1300) - 12 - X0;
  const cols = Math.max(1, Math.floor((avail + GAP) / (TILE_W + GAP)));
  const tiles = STATS.filter((x) => x.id !== 'sessions');
  if (id === 'sessions') {
    const rows = Math.ceil(tiles.length / cols);
    return { x: X0, y: rows * (TILE_H + GAP), w: Math.max(TILE_W, Math.min(avail, 1060)), h: 380 };
  }
  const i = tiles.findIndex((x) => x.id === id);
  return { x: X0 + (i % cols) * (TILE_W + GAP), y: Math.floor(i / cols) * (TILE_H + GAP), w: TILE_W, h: TILE_H };
}

let layout = { shown: [...DEFAULT_SHOWN], panels: {} };

const canvas = () => document.getElementById('stCanvas');
const rectOf = (id) => layout.panels[id] || defRect(id);

function fmtDuration(sec) {
  const m = Math.round((sec || 0) / 60);
  const h = Math.floor(m / 60);
  return h ? t('stats.hm', { h, m: m % 60 }) : t('stats.m', { m });
}
const catName = (c) => (I18N.lang === 'ru' && c?.ru) || c?.name || '';

// ---------- сохранение ----------
let saveTimer = null;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/workbench/stats-layout', { method: 'PUT', body: layout }).catch((e) => console.warn('[stats layout]', e.message));
  }, 500);
}

// ---------- окна ----------
function readRect(el) {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

// окно не залезает под меню слева и под галочки справа
function clampPos(el, left, top) {
  left = Math.max(0, left);
  top = Math.max(0, top);
  const nav = document.getElementById('wbNavFixed');
  if (nav && left < nav.offsetWidth + 8 && top < nav.offsetHeight) left = nav.offsetWidth + 20;
  const picker = document.getElementById('stPicker');
  if (picker) left = Math.min(left, Math.max(0, picker.offsetLeft - el.offsetWidth - 12));
  return { left, top };
}

function fitCanvas() {
  let bottom = 900;
  document.querySelectorAll('.st-window').forEach((w) => { bottom = Math.max(bottom, w.offsetTop + w.offsetHeight + 40); });
  canvas().style.minHeight = bottom + 'px';
}

function makeMovable(el, id) {
  const head = el.querySelector('.wb-window-titlebar');
  const rsz = el.querySelector('.wb-resize-handle');
  let mode = null, sx = 0, sy = 0, a = 0, b = 0;
  const done = () => {
    if (!mode) return;
    mode = null;
    el.classList.remove('dragging');
    layout.panels[id] = readRect(el);
    fitCanvas();
    saveLayout();
  };
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
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
    const picker = document.getElementById('stPicker');
    const maxW = picker ? picker.offsetLeft - el.offsetLeft - 12 : 2000;
    el.style.width = Math.min(maxW, Math.max(160, a + e.clientX - sx)) + 'px';
    el.style.height = Math.max(90, b + e.clientY - sy) + 'px';
  });
  rsz.addEventListener('pointerup', done);
  rsz.addEventListener('pointercancel', done);
}

function buildWindow(id) {
  const el = document.createElement('div');
  el.className = 'wb-window st-window' + (id === 'sessions' ? ' st-window-table' : ' st-window-tile');
  el.id = 'st-' + id;
  el.innerHTML = `
    <div class="wb-window-titlebar"><span class="st-win-title"></span>
      <button type="button" class="st-win-close" aria-label="">×</button></div>
    <div class="wb-window-content"></div>
    <div class="wb-resize-handle"></div>`;
  el.querySelector('.st-win-close').addEventListener('click', () => setShown(id, false));
  const r = rectOf(id);
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  makeMovable(el, id);
  return el;
}

function syncWindows() {
  const c = canvas();
  for (const s of STATS) {
    let el = document.getElementById('st-' + s.id);
    const on = layout.shown.includes(s.id);
    if (on && !el) c.appendChild(buildWindow(s.id));
    if (!on && el) el.remove();
  }
  fitCanvas();
}

function setShown(id, on) {
  layout.shown = on ? [...new Set([...layout.shown, id])] : layout.shown.filter((x) => x !== id);
  syncWindows();
  renderAll();
  saveLayout();
}

// ---------- содержимое ----------
function tileValue(id, d, nf) {
  switch (id) {
    case 'hours': return fmtDuration(d.sec);
    case 'streams': return nf.format(d.streams);
    case 'avgViewers': return nf.format(d.avgViewers);
    case 'peakViewers': return nf.format(d.peakViewers);
    case 'newFollowers': return '+' + nf.format(d.newFollowers);
    case 'followers': return nf.format(d.followers);
    case 'watchHours': return nf.format(d.watchHours);
    case 'avgDuration': return fmtDuration(d.avgDurationSec);
    case 'chatMessages': return nf.format(d.chatMessages);
    case 'chatters': return nf.format(d.avgChatters);
    default: return '';
  }
}

function renderTable(box, d, nf) {
  box.innerHTML = '';
  if (!d.sessions.length) {
    const p = document.createElement('p');
    p.className = 'st-empty';
    p.textContent = t('stats.noStreams');
    box.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  table.className = 'st-table';
  const head = document.createElement('tr');
  for (const k of ['date', 'duration', 'stream', 'peak', 'avg', 'chat', 'newFollowers']) {
    const th = document.createElement('th');
    th.textContent = t('stats.col.' + k);
    head.appendChild(th);
  }
  const thead = document.createElement('thead');
  thead.appendChild(head);
  const tbody = document.createElement('tbody');
  tbody.setAttribute('data-no-i18n', ''); // названия эфиров — текст стримера
  for (const x of d.sessions) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(x.startedAt).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }),
      fmtDuration(x.sec), null,
      nf.format(x.peakViewers), nf.format(x.avgViewers), nf.format(x.chatMessages || 0),
      x.newFollowers ? '+' + nf.format(x.newFollowers) : '0',
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (i === 2) {
        td.className = 'st-stream';
        const title = document.createElement('div');
        title.className = 'st-stream-title';
        title.textContent = x.title || t('stats.noTitle');
        title.title = title.textContent;
        td.appendChild(title);
        if (x.category) {
          const c = document.createElement('div');
          c.className = 'st-stream-cat';
          c.textContent = catName(x.category);
          td.appendChild(c);
        }
      } else td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  box.appendChild(table);
}

function renderAll() {
  document.querySelectorAll('.st-period-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === statsDays));

  // галочки справа
  const checks = document.getElementById('stChecks');
  checks.innerHTML = '';
  for (const s of STATS) {
    const lab = document.createElement('label');
    lab.className = 'st-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = layout.shown.includes(s.id);
    cb.addEventListener('change', () => setShown(s.id, cb.checked));
    const span = document.createElement('span');
    span.textContent = t('stats.' + s.id);
    lab.append(cb, span);
    checks.appendChild(lab);
  }

  const d = statsData;
  const nf = new Intl.NumberFormat(I18N.locale, { maximumFractionDigits: 1 });
  for (const s of STATS) {
    const el = document.getElementById('st-' + s.id);
    if (!el) continue;
    el.querySelector('.st-win-title').textContent = t('stats.' + s.id);
    el.querySelector('.st-win-close').setAttribute('aria-label', t('stats.hide'));
    el.querySelector('.st-win-close').title = t('stats.hide');
    const box = el.querySelector('.wb-window-content');
    if (!d) { box.innerHTML = '<div class="st-tile-value">…</div>'; continue; }
    if (s.id === 'sessions') { renderTable(box, d, nf); continue; }
    box.innerHTML = '';
    const v = document.createElement('div');
    v.className = 'st-tile-value';
    v.textContent = tileValue(s.id, d, nf);
    const sub = document.createElement('div');
    sub.className = 'st-tile-label';
    sub.textContent = t('stats.sub.' + s.id, { n: d.days });
    box.append(v, sub);
  }
}

async function loadStats() {
  try {
    statsData = await api('/workbench/stats?days=' + statsDays);
  } catch (err) {
    PW.toast(err.message || t('stats.loadFailed'), 'error');
  }
  renderAll();
}

async function loadLayout() {
  try {
    const r = await api('/workbench/stats-layout');
    if (r.layout) layout = { shown: r.layout.shown || [], panels: r.layout.panels || {} };
  } catch (_) {}
  syncWindows();
  renderAll();
}

async function resetStatsLayout() {
  const ok = await PW.confirm(t('stats.resetConfirm'));
  if (!ok) return;
  layout = { shown: [...DEFAULT_SHOWN], panels: {} };
  document.querySelectorAll('.st-window').forEach((w) => w.remove());
  syncWindows();
  renderAll();
  api('/workbench/stats-layout', { method: 'DELETE' }).catch(() => {});
}

document.querySelectorAll('.st-period-btn').forEach((b) => b.addEventListener('click', () => {
  statsDays = Number(b.dataset.days) === 7 ? 7 : 30;
  try { localStorage.setItem('pw-stats-days', String(statsDays)); } catch {}
  renderAll();
  loadStats();
}));
window.addEventListener('pw:langchange', renderAll);

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

loadLayout();
loadStats();
