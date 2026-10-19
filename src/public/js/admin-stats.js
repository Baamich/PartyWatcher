// Админка → 📊 Статистика: окна-показатели на холсте (общий модуль workbench/canvas-windows.js, как в студии).
// Справа — галочки: какие окна показывать; сверху — период (24 ч / 7 / 30 дней). Раскладка и галочки — в
// localStorage этого браузера. Данные — GET /api/admin/stats (сервер держит ответ 30 с), обновление раз в минуту
(function () {
  const LS_KEY = 'pw-admin-stats';
  const PERIOD_KEY = 'pw-admin-stats-days';

  // окна: id, группа, вид. Порядок = порядок галочек и мест по умолчанию
  const WINDOWS = [
    { id: 'visitors', g: 'visits', k: 'tile' },
    { id: 'newVisitors', g: 'visits', k: 'tile' },
    { id: 'pageViews', g: 'visits', k: 'tile' },
    { id: 'bots', g: 'visits', k: 'tile' },
    { id: 'online', g: 'server', k: 'tile' },
    { id: 'requests', g: 'server', k: 'tile' },
    { id: 'avgMs', g: 'server', k: 'tile' },
    { id: 'errors', g: 'server', k: 'tile' },
    { id: 'cpuNow', g: 'server', k: 'tile' },
    { id: 'memNow', g: 'server', k: 'tile' },
    { id: 'loopLag', g: 'server', k: 'tile' },
    { id: 'uptime', g: 'server', k: 'tile' },
    { id: 'accounts', g: 'accounts', k: 'tile' },
    { id: 'newAccounts', g: 'accounts', k: 'tile' },
    { id: 'activeAccounts', g: 'accounts', k: 'tile' },
    { id: 'bannedAccounts', g: 'accounts', k: 'tile' },
    { id: 'liveNow', g: 'content', k: 'tile' },
    { id: 'streams', g: 'content', k: 'tile' },
    { id: 'rooms', g: 'content', k: 'tile' },
    { id: 'chatMessages', g: 'content', k: 'tile' },
    { id: 'follows', g: 'content', k: 'tile' },
    { id: 'clips', g: 'content', k: 'tile' },
    { id: 'support', g: 'content', k: 'tile' },
    { id: 'bans', g: 'content', k: 'tile' },
    { id: 'visitorsChart', g: 'visits', k: 'chart' },
    { id: 'requestsChart', g: 'server', k: 'chart' },
    { id: 'cpuChart', g: 'server', k: 'chart' },
    { id: 'cpuLive', g: 'server', k: 'chart' },
    { id: 'memChart', g: 'server', k: 'chart' },
    { id: 'regChart', g: 'accounts', k: 'chart' },
    { id: 'apiGroups', g: 'server', k: 'list' },
    { id: 'topPages', g: 'visits', k: 'list' },
    { id: 'devices', g: 'visits', k: 'list' },
    { id: 'os', g: 'visits', k: 'list' },
    { id: 'browsers', g: 'visits', k: 'list' },
    { id: 'countries', g: 'visits', k: 'list' },
    { id: 'recent', g: 'visits', k: 'table' },
    { id: 'botNames', g: 'visits', k: 'list' },
    { id: 'recentBots', g: 'visits', k: 'table' },
  ];
  const BY_ID = new Map(WINDOWS.map((w) => [w.id, w]));
  const GROUPS = ['visits', 'server', 'accounts', 'content'];
  const DEFAULT_SHOWN = WINDOWS.filter((w) => !['bots', 'follows', 'clips', 'memChart', 'browsers', 'loopLag', 'uptime', 'bans'].includes(w.id)).map((w) => w.id);
  const SIZE = { tile: [200, 132], chart: [440, 250], list: [300, 300], table: [900, 380] };

  let data = null;
  let days = 7;
  try { days = [1, 7, 30].includes(Number(localStorage.getItem(PERIOD_KEY))) ? Number(localStorage.getItem(PERIOD_KEY)) : 7; } catch (_) {}
  // окна, добавленные после того, как у человека уже сохранилась раскладка: показываются один раз сами
  // (дальше — как он решит галочкой). Новое окно — дописать сюда
  const ADDED = ['botNames', 'recentBots'];
  let layout = { shown: [...DEFAULT_SHOWN], panels: {}, added: [...ADDED] };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && Array.isArray(saved.shown)) {
      const seen = Array.isArray(saved.added) ? saved.added : [];
      const fresh = ADDED.filter((id) => !seen.includes(id) && !saved.shown.includes(id));
      layout = { shown: [...saved.shown.filter((id) => BY_ID.has(id)), ...fresh], panels: saved.panels || {}, added: [...ADDED] };
    }
  } catch (_) {}
  function saveLayout() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch (_) {}
  }

  const canvas = document.getElementById('pwaCanvas');
  const picker = document.getElementById('pwaPicker');
  const topBar = document.getElementById('pwaTop');
  if (!canvas) return;

  // места по умолчанию: включённые окна по порядку строками от меню до галочек
  let flowCache = null;
  function flow() {
    const key = layout.shown.join(',') + '|' + (picker.offsetLeft || 0);
    if (flowCache && flowCache.key === key) return flowCache.map;
    const x0 = 220, gap = 12;
    const y0 = topBar.offsetTop + topBar.offsetHeight + 14;
    const right = (picker.offsetLeft || 1300) - 12;
    const map = {};
    let x = x0, y = y0, rowH = 0;
    for (const w of WINDOWS) {
      if (!layout.shown.includes(w.id)) continue;
      let [ww, hh] = SIZE[w.k];
      ww = Math.min(ww, right - x0);
      if (x + ww > right && x > x0) { x = x0; y += rowH + gap; rowH = 0; }
      map[w.id] = { x, y, w: ww, h: hh };
      x += ww + gap;
      rowH = Math.max(rowH, hh);
    }
    flowCache = { key, map };
    return map;
  }
  const defRect = (id) => flow()[id] || { x: 220, y: 80, w: SIZE[BY_ID.get(id).k][0], h: SIZE[BY_ID.get(id).k][1] };

  const win = PWCanvasWindows.create({
    canvas, picker, topBar, defRect, minW: 170, minH: 100,
    onLayout: (panels) => { layout.panels = panels; saveLayout(); },
    onClose: (id) => setShown(id, false),
  });
  win.setPanels(layout.panels);

  // ---------- форматирование ----------
  const nf = () => new Intl.NumberFormat(I18N.locale, { maximumFractionDigits: 1 });
  const num = (n) => nf().format(n || 0);
  function dur(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return t('admin.stats.dur.d', { n: d }) + ' ' + t('admin.stats.dur.h', { n: h });
    if (h) return t('admin.stats.dur.h', { n: h }) + ' ' + t('admin.stats.dur.m', { n: m });
    return t('admin.stats.dur.m', { n: m });
  }
  const fmtTime = (d) => new Date(d).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' });
  // корзина графика: 'YYYY-MM-DDTHH' (по часам) или 'YYYY-MM-DD' (по дням) — подпись в часовом поясе админа
  function bucketLabel(b, long) {
    if (b.length > 13) { // по минутам: 'YYYY-MM-DDTHH:MM'
      const d = new Date(b + ':00Z');
      return d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
    }
    if (b.length > 10) {
      const d = new Date(b + ':00:00Z');
      return long ? d.toLocaleString(I18N.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : String(d.getHours()).padStart(2, '0') + ':00';
    }
    const d = new Date(b + 'T00:00:00Z');
    return d.toLocaleDateString(I18N.locale, long ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  }
  const regionNames = () => { try { return new Intl.DisplayNames([I18N.locale], { type: 'region' }); } catch (_) { return null; } };

  // ---------- плитки ----------
  function tile(id, d) {
    const L = d.live || {};
    switch (id) {
      case 'visitors': return [num(d.visitors), t('admin.stats.sub.visitors', { n: d.days })];
      case 'newVisitors': return [num(d.newVisitors), t('admin.stats.sub.newVisitors')];
      case 'pageViews': return [num(d.pageViews), t('admin.stats.sub.pageViews')];
      case 'bots': return [num(d.bots), t('admin.stats.sub.bots')];
      case 'online': return [num(L.sockets), t('admin.stats.sub.online', { n: num(d.peakSockets) })];
      case 'requests': return [num(d.requests), t('admin.stats.sub.requests', { api: num(d.apiRequests), pages: num(d.pageRequests) })];
      case 'avgMs': return [t('admin.stats.ms', { n: num(d.avgMs) }), t('admin.stats.sub.avgMs')];
      case 'errors': return [num(d.errors5), t('admin.stats.sub.errors', { n: num(d.errors4) })];
      case 'cpuNow': return [t('admin.stats.pct', { n: num(L.cpuSys) }), t('admin.stats.sub.cpuNow', { p: num(L.cpuProc), cores: L.cores || '?', load: num(L.load1) })];
      case 'memNow': return [t('admin.stats.mb', { n: num(L.rss) }), t('admin.stats.sub.memNow', { free: num(L.memFree), total: num(L.memTotal) })];
      case 'loopLag': return [t('admin.stats.ms', { n: num(L.loopP99) }), t('admin.stats.sub.loopLag', { n: num(d.peakLoop) })];
      case 'uptime': return [L.startedAt ? dur((Date.now() - new Date(L.startedAt).getTime()) / 1000) : '—', t('admin.stats.sub.uptime', { node: L.node || '' })];
      case 'accounts': return [num(d.accounts), t('admin.stats.sub.accounts', { n: num(d.admins) })];
      case 'newAccounts': return [num(d.newAccounts), t('admin.stats.sub.newAccounts')];
      case 'activeAccounts': return [num(d.activeAccounts), t('admin.stats.sub.activeAccounts')];
      case 'bannedAccounts': return [num(d.bannedAccounts), t('admin.stats.sub.bannedAccounts')];
      case 'liveNow': return [num(d.liveNow), t('admin.stats.sub.liveNow', { n: num(d.activeStreamers) })];
      case 'streams': return [num(d.streams), t('admin.stats.sub.streams', { h: num(d.streamHours) })];
      case 'rooms': return [num(d.rooms), t('admin.stats.sub.rooms', { n: num(d.roomsActive) })];
      case 'chatMessages': return [num(d.chatMessages), t('admin.stats.sub.chatMessages', { r: num(d.roomMessages), s: num(d.streamMessages) })];
      case 'follows': return [num(d.follows), t('admin.stats.sub.follows')];
      case 'clips': return [num(d.clips), t('admin.stats.sub.clips')];
      case 'support': return [num(d.supportUnread), t('admin.stats.sub.support', { n: num(d.supportNew) })];
      case 'bans': return [num((d.bans?.ip || 0) + (d.bans?.did || 0) + (d.bans?.hw || 0)), t('admin.stats.sub.bans', { ip: num(d.bans?.ip), dev: num((d.bans?.did || 0) + (d.bans?.hw || 0)) })];
      default: return ['', ''];
    }
  }

  // ---------- графики (SVG по размеру окна; подсказка при наведении) ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // series: [{ key, label, cls }], points: [{ t, <key>: число }]; kind: 'bar' (одна серия) | 'line'
  function drawChart(box, { points, series, kind, fmtV, max: fixedMax }) {
    box.innerHTML = '';
    if (!points || !points.length) {
      box.appendChild(Object.assign(document.createElement('p'), { className: 'pwa-empty', textContent: t('admin.stats.empty') }));
      return;
    }
    if (series.length > 1) {
      const leg = document.createElement('div');
      leg.className = 'pwa-legend';
      for (const s of series) {
        const it = document.createElement('span');
        const sw = document.createElement('i');
        sw.className = 'pwa-swatch ' + s.cls;
        it.append(sw, document.createTextNode(s.label));
        leg.appendChild(it);
      }
      box.appendChild(leg);
    }
    const wrap = document.createElement('div');
    wrap.className = 'pwa-chart';
    box.appendChild(wrap);
    const W = Math.max(120, wrap.clientWidth), H = Math.max(80, wrap.clientHeight);
    const pad = { l: 40, r: 8, t: 8, b: 20 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    let maxV = 0;
    for (const p of points) for (const s of series) maxV = Math.max(maxV, p[s.key] || 0);
    const top = fixedMax || niceMax(maxV);
    const y = (v) => pad.t + ih - (Math.min(v, top) / top) * ih;
    const svg = svgEl('svg', { width: W, height: H, class: 'pwa-svg', role: 'img' });

    for (const f of [0, 0.5, 1]) {
      const yy = Math.round(y(top * f)) + 0.5;
      svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'pwa-grid' }));
      const lab = svgEl('text', { x: pad.l - 6, y: yy + 4, class: 'pwa-axis', 'text-anchor': 'end' });
      lab.textContent = fmtV(top * f, true);
      svg.appendChild(lab);
    }
    const n = points.length;
    const step = iw / n;
    const xc = (i) => pad.l + step * i + step / 2;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 56))));
    points.forEach((p, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const lab = svgEl('text', { x: xc(i), y: H - 5, class: 'pwa-axis', 'text-anchor': 'middle' });
      lab.textContent = bucketLabel(p.t, false);
      svg.appendChild(lab);
    });

    if (kind === 'bar') {
      const s = series[0];
      const bw = Math.max(2, Math.min(28, step - 2)); // зазор 2px между столбиками
      points.forEach((p, i) => {
        const v = p[s.key] || 0;
        if (!v) return;
        const h = Math.max(2, pad.t + ih - y(v));
        svg.appendChild(svgEl('rect', { x: xc(i) - bw / 2, y: pad.t + ih - h, width: bw, height: h, rx: Math.min(4, bw / 2), class: 'pwa-bar ' + s.cls }));
      });
    } else {
      for (const s of series) {
        const d = points.map((p, i) => (i ? 'L' : 'M') + xc(i).toFixed(1) + ' ' + y(p[s.key] || 0).toFixed(1)).join(' ');
        svg.appendChild(svgEl('path', { d, class: 'pwa-line ' + s.cls }));
      }
    }

    // подсказка: столбик/точка под курсором
    const tip = document.createElement('div');
    tip.className = 'pwa-tip hidden';
    const cross = svgEl('line', { y1: pad.t, y2: pad.t + ih, class: 'pwa-cross hidden' });
    svg.appendChild(cross);
    const dots = series.map((s) => { const c = svgEl('circle', { r: 4, class: 'pwa-dot hidden ' + s.cls }); svg.appendChild(c); return c; });
    const hit = svgEl('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
    svg.appendChild(hit);
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left - pad.l) / step)));
      const p = points[i];
      tip.textContent = '';
      const head = document.createElement('b');
      head.textContent = bucketLabel(p.t, true);
      tip.appendChild(head);
      for (const s of series) {
        const row = document.createElement('div');
        row.textContent = (series.length > 1 ? s.label + ': ' : '') + fmtV(p[s.key] || 0, false);
        tip.appendChild(row);
      }
      tip.classList.remove('hidden');
      const x = xc(i);
      if (kind !== 'bar') {
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);
        cross.classList.remove('hidden');
        dots.forEach((c, k) => { c.setAttribute('cx', x); c.setAttribute('cy', y(p[series[k].key] || 0)); c.classList.remove('hidden'); });
      }
      const left = Math.min(W - tip.offsetWidth - 4, Math.max(4, x + 10));
      tip.style.left = left + 'px';
      tip.style.top = pad.t + 'px';
    });
    hit.addEventListener('pointerleave', () => {
      tip.classList.add('hidden');
      cross.classList.add('hidden');
      dots.forEach((c) => c.classList.add('hidden'));
    });
    wrap.append(svg, tip);
  }

  function chart(id, box, d) {
    const cnt = (v, axis) => (axis && v >= 1000 ? nf().format(Math.round(v / 100) / 10) + 'k' : num(Math.round(v)));
    const pct = (v) => num(Math.round(v)) + '%';
    switch (id) {
      case 'visitorsChart': return drawChart(box, { points: d.visitorsSeries, kind: 'bar', series: [{ key: 'v', label: '', cls: 'viz1' }], fmtV: cnt });
      case 'requestsChart': return drawChart(box, { points: d.requestsSeries, kind: 'bar', series: [{ key: 'v', label: '', cls: 'viz1' }], fmtV: cnt });
      case 'regChart': return drawChart(box, { points: d.regSeries, kind: 'bar', series: [{ key: 'v', label: '', cls: 'viz1' }], fmtV: cnt });
      case 'memChart': return drawChart(box, { points: d.memSeries, kind: 'bar', series: [{ key: 'v', label: '', cls: 'viz1' }], fmtV: (v) => num(Math.round(v)) + ' MB' });
      case 'cpuChart':
        return drawChart(box, {
          points: d.cpuSeries, kind: 'line', max: 100, fmtV: pct,
          series: [{ key: 's', label: t('admin.stats.legend.sys'), cls: 'viz1' }, { key: 'p', label: t('admin.stats.legend.proc'), cls: 'viz2' }],
        });
      case 'cpuLive': {
        // последние 6 часов по минутам: подпись — время минуты
        const pts = (d.live?.minutes || []).map((m) => ({ t: new Date(m.t).toISOString().slice(0, 16), s: m.s, p: m.p }));
        return drawChart(box, {
          points: pts, kind: 'line', max: 100, fmtV: pct,
          series: [{ key: 's', label: t('admin.stats.legend.sys'), cls: 'viz1' }, { key: 'p', label: t('admin.stats.legend.proc'), cls: 'viz2' }],
        });
      }
      default: return null;
    }
  }

  // ---------- списки (горизонтальные полосы) ----------
  function listRows(id, d) {
    const rn = regionNames();
    switch (id) {
      case 'apiGroups': return (d.apiGroups || []).map((x) => ({ label: '/api/' + x.k, n: x.n }));
      case 'topPages': return (d.topPages || []).map((x) => ({ label: x.k, n: x.n }));
      case 'devices': return (d.devices || []).map((x) => ({ label: I18N.has('admin.stats.dev.' + x.k) ? t('admin.stats.dev.' + x.k) : x.k || t('admin.stats.unknown'), n: x.n }));
      case 'os': return (d.os || []).map((x) => ({ label: x.k || t('admin.stats.unknown'), n: x.n }));
      case 'browsers': return (d.browsers || []).map((x) => ({ label: x.k || t('admin.stats.unknown'), n: x.n }));
      case 'countries': return (d.countries || []).map((x) => {
        let name = x.k;
        try { if (x.k && /^[A-Z]{2}$/.test(x.k) && rn) name = rn.of(x.k) + ' (' + x.k + ')'; } catch (_) {}
        return { label: name || t('admin.stats.unknown'), n: x.n };
      });
      // по числу запросов за период; посетителей (адресов) — в подсказке строки
      case 'botNames': return (d.botNames || []).map((x) => ({ label: botKindIcon(x.kind) + ' ' + x.name + ' · ' + t('admin.stats.botKind.' + x.kind), n: x.hits }));
      default: return [];
    }
  }
  function drawList(box, rows) {
    box.innerHTML = '';
    if (!rows.length) {
      box.appendChild(Object.assign(document.createElement('p'), { className: 'pwa-empty', textContent: t('admin.stats.empty') }));
      return;
    }
    const total = rows.reduce((a, r) => a + r.n, 0) || 1;
    const max = Math.max(...rows.map((r) => r.n)) || 1;
    const list = document.createElement('div');
    list.className = 'pwa-list';
    list.setAttribute('data-no-i18n', '');
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'pwa-list-row';
      row.title = r.label + ' — ' + num(r.n);
      const lab = document.createElement('span');
      lab.className = 'pwa-list-label';
      lab.textContent = r.label;
      const val = document.createElement('span');
      val.className = 'pwa-list-val';
      val.textContent = num(r.n) + ' · ' + Math.round((r.n / total) * 100) + '%';
      const bar = document.createElement('span');
      bar.className = 'pwa-list-bar';
      const fill = document.createElement('i');
      fill.className = 'viz1';
      fill.style.width = Math.max(2, (r.n / max) * 100) + '%';
      bar.appendChild(fill);
      row.append(lab, val, bar);
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  // ---------- таблица последних посетителей ----------
  function drawRecent(box, d) {
    box.innerHTML = '';
    const rows = d.recent || [];
    if (!rows.length) {
      box.appendChild(Object.assign(document.createElement('p'), { className: 'pwa-empty', textContent: t('admin.stats.empty') }));
      return;
    }
    const table = document.createElement('table');
    table.className = 'pwa-table';
    const head = document.createElement('tr');
    for (const k of ['time', 'device', 'ip', 'country', 'user', 'pages']) {
      const th = document.createElement('th');
      th.textContent = t('admin.stats.col.' + k);
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    const tbody = document.createElement('tbody');
    tbody.setAttribute('data-no-i18n', '');
    for (const r of rows) {
      const tr = document.createElement('tr');
      const dev = (r.type === 'bot' ? '🤖 ' : r.type === 'mobile' ? '📱 ' : r.type === 'tablet' ? '📲 ' : '💻 ') + (r.name || '');
      [fmtTime(r.at), dev, r.ip, r.country, r.user || '—', num(r.pages) + ' / ' + num(r.hits)].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v || '';
        if (i === 1) td.className = 'pwa-td-wide';
        if (i === 4 && r.user) {
          td.className = 'pwa-link';
          td.addEventListener('click', () => window.openUsers && window.openUsers({ q: r.user }));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    box.appendChild(table);
  }

  // ---------- боты: последние заходы ----------
  const BOT_ICONS = { search: '🔎', ai: '🧠', preview: '🔗', seo: '📈', monitor: '📡', script: '⚙️', other: '🤖' };
  const botKindIcon = (kind) => BOT_ICONS[kind] || BOT_ICONS.other;
  function drawBots(box, d) {
    box.innerHTML = '';
    const rows = d.recentBots || [];
    if (!rows.length) {
      box.appendChild(Object.assign(document.createElement('p'), { className: 'pwa-empty', textContent: t('admin.stats.empty') }));
      return;
    }
    const table = document.createElement('table');
    table.className = 'pwa-table';
    const head = document.createElement('tr');
    for (const k of ['time', 'bot', 'kind', 'ip', 'country', 'pages']) {
      const th = document.createElement('th');
      th.textContent = t('admin.stats.col.' + k);
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    const tbody = document.createElement('tbody');
    tbody.setAttribute('data-no-i18n', '');
    for (const r of rows) {
      const tr = document.createElement('tr');
      [fmtTime(r.at), r.name, botKindIcon(r.kind) + ' ' + t('admin.stats.botKind.' + r.kind), r.ip, r.country, num(r.pages) + ' / ' + num(r.hits)].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v || '';
        if (i === 1) td.className = 'pwa-td-wide';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    box.appendChild(table);
  }

  // ---------- окна и галочки ----------
  const observers = new Map();
  function renderWindow(id) {
    const w = BY_ID.get(id);
    const parts = win.open(id, 'pwa-win pwa-win-' + w.k);
    parts.title.textContent = t('admin.stats.w.' + id);
    parts.close.title = t('admin.stats.hide');
    parts.close.setAttribute('aria-label', t('admin.stats.hide'));
    const box = parts.content;
    if (!data) {
      box.innerHTML = '<div class="pwa-tile-value">…</div>';
      return;
    }
    if (w.k === 'tile') {
      const [v, sub] = tile(id, data);
      box.innerHTML = '';
      const vv = document.createElement('div');
      vv.className = 'pwa-tile-value';
      vv.textContent = v;
      const ss = document.createElement('div');
      ss.className = 'pwa-tile-label';
      ss.textContent = sub;
      box.append(vv, ss);
      if (id === 'newAccounts') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn pwa-tile-btn';
        b.textContent = t('admin.stats.view');
        b.addEventListener('click', () => window.openUsers && window.openUsers({ sort: 'new' }));
        box.appendChild(b);
      }
      if (id === 'bannedAccounts' && data.bannedAccounts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn pwa-tile-btn';
        b.textContent = t('admin.stats.view');
        b.addEventListener('click', () => window.openUsers && window.openUsers({ filter: 'banned' }));
        box.appendChild(b);
      }
      return;
    }
    if (w.k === 'chart') {
      chart(id, box, data);
      // перерисовать при изменении размера окна (SVG рисуется в пикселях окна)
      if (!observers.has(id)) {
        let raf = 0;
        const ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => { if (data && win.has(id)) chart(id, win.get(id).content, data); });
        });
        ro.observe(parts.el);
        observers.set(id, ro);
      }
      return;
    }
    if (w.k === 'list') return drawList(box, listRows(id, data));
    if (w.k === 'table') return id === 'recentBots' ? drawBots(box, data) : drawRecent(box, data);
  }

  function setShown(id, on) {
    layout.shown = on ? [...new Set([...layout.shown, id])] : layout.shown.filter((x) => x !== id);
    if (!on) {
      observers.get(id)?.disconnect();
      observers.delete(id);
      win.close(id);
    }
    flowCache = null;
    saveLayout();
    renderAll();
  }

  function renderChecks() {
    const box = document.getElementById('pwaChecks');
    box.innerHTML = '';
    for (const g of GROUPS) {
      const h = document.createElement('div');
      h.className = 'pwa-check-group';
      h.textContent = t('admin.stats.group.' + g);
      box.appendChild(h);
      for (const w of WINDOWS.filter((x) => x.g === g)) {
        const lab = document.createElement('label');
        lab.className = 'cw-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = layout.shown.includes(w.id);
        cb.addEventListener('change', () => setShown(w.id, cb.checked));
        const span = document.createElement('span');
        span.textContent = t('admin.stats.w.' + w.id);
        lab.append(cb, span);
        box.appendChild(lab);
      }
    }
  }

  function renderTop() {
    document.querySelectorAll('.pwa-period-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === days));
    const up = document.getElementById('pwaUpdated');
    if (!up) return;
    if (!data) { up.textContent = ''; return; }
    let text = t('admin.stats.updatedAt', { time: new Date(data.at).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
    const liveAge = data.live?.at ? (Date.now() - new Date(data.live.at).getTime()) / 60000 : Infinity;
    up.classList.toggle('pwa-stale', liveAge > 3);
    if (liveAge > 3) text += ' · ' + t('admin.stats.stale', { n: Number.isFinite(liveAge) ? Math.round(liveAge) : '∞' });
    up.textContent = text;
  }

  function renderAll() {
    renderTop();
    renderChecks();
    for (const w of WINDOWS) if (layout.shown.includes(w.id)) renderWindow(w.id);
    win.fit();
  }

  let loading = false;
  async function load(fresh) {
    if (loading) return;
    loading = true;
    try {
      data = await api('/admin/stats?days=' + days + (fresh ? '&fresh=1' : ''));
    } catch (e) {
      PW.toast(e.message || t('admin.stats.loadFailed'), 'error');
    } finally {
      loading = false;
    }
    renderAll();
    win.unstick(); // окна, заехавшие под панель периода или галочки, — вниз под панель
  }

  document.querySelectorAll('.pwa-period-btn').forEach((b) => b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    try { localStorage.setItem(PERIOD_KEY, String(days)); } catch (_) {}
    renderTop();
    load();
  }));
  document.getElementById('pwaRefresh')?.addEventListener('click', () => load(true));
  setInterval(() => { if (!document.hidden) load(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data && Date.now() - new Date(data.at).getTime() > 60000) load(); });
  window.addEventListener('pw:langchange', renderAll);

  window.adShowAll = (on) => {
    layout.shown = on === '1' ? WINDOWS.map((w) => w.id) : [];
    if (on !== '1') {
      observers.forEach((ro) => ro.disconnect());
      observers.clear();
      win.ids().forEach((id) => win.close(id));
    }
    flowCache = null;
    saveLayout();
    renderAll();
  };
  window.adResetLayout = async () => {
    if (!(await PW.confirm(t('admin.stats.resetConfirm')))) return;
    layout = { shown: [...DEFAULT_SHOWN], panels: {}, added: [...ADDED] };
    observers.forEach((ro) => ro.disconnect());
    observers.clear();
    win.ids().forEach((id) => win.close(id));
    win.setPanels({});
    flowCache = null;
    saveLayout();
    renderAll();
  };
  window.adScrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  renderAll();
  load();
})();
