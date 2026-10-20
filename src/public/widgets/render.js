// Рисует виджет (widgets/catalog.js): общий для оверлея OBS (/overlay/widget.html), превью в студии и мини-пульта.
// PWWidgetRender.create(box, { preview, credits }) → { set(widget), ctx({ live, stats, now }), destroy() }.
// Время считается здесь: сервер присылает отметки (end, start, startedAt) и своё now — разницу часов учитываем.
// Весь текст пользователя — только textContent (никакого HTML из настроек)
(function () {
  if (window.PWWidgetRender) return;
  const C = window.PWWidgetCatalog;
  const tr = (k, v) => (window.t ? window.t(k, v) : k);

  let offset = 0; // серверное время − моё
  const serverNow = () => Date.now() + offset;
  function syncClock(now) {
    if (Number.isFinite(now) && now > 0) offset = now - Date.now();
  }

  // один таймер на страницу для всех «тикающих» виджетов
  const ticking = new Set();
  setInterval(() => ticking.forEach((fn) => fn()), 250);

  function injectCss() {
    if (document.getElementById('pww-css')) return;
    const st = document.createElement('style');
    st.id = 'pww-css';
    st.textContent = `
      .pww { box-sizing: border-box; display: inline-flex; flex-direction: column; gap: .25em; max-width: 100%;
        font-family: var(--pww-font); font-size: var(--pww-size); font-weight: var(--pww-weight); color: var(--pww-color);
        background: var(--pww-bg); padding: var(--pww-pad); border-radius: var(--pww-radius); text-align: var(--pww-align);
        text-shadow: var(--pww-shadow); -webkit-text-stroke: var(--pww-stroke); paint-order: stroke fill; text-transform: var(--pww-upper);
        line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .pww[hidden] { display: none; }
      .pww.pww-wide { display: flex; width: 100%; }
      .pww.pww-fill { height: 100%; }
      .pww-dim { opacity: .45; font-style: italic; }
      .pww-text { white-space: pre-line; }
      .pww-sub { font-size: .45em; opacity: .85; }
      .pww-bar { position: relative; width: 100%; height: var(--pww-barh, 26px); border-radius: 999px; overflow: hidden;
        background: rgba(255, 255, 255, .18); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); }
      .pww-bar > i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--pww-accent); border-radius: inherit; transition: width .6s ease; }
      .pww-bar > b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: calc(var(--pww-barh, 26px) * .6);
        font-weight: 700; color: #fff; -webkit-text-stroke: 0; text-shadow: 0 1px 3px rgba(0, 0, 0, .7); }
      .pww-goal-head { display: flex; justify-content: space-between; gap: .6em; align-items: baseline; }
      .pww-goal-head span:last-child { font-size: .8em; opacity: .9; white-space: nowrap; }
      .pww-done .pww-bar > i { background: linear-gradient(90deg, var(--pww-accent), #fde68a, var(--pww-accent)); background-size: 200% 100%; animation: pww-shine 2s linear infinite; }
      @keyframes pww-shine { to { background-position: -200% 0; } }
      .pww-ticker { overflow: hidden; white-space: nowrap; }
      .pww-track { display: inline-flex; will-change: transform; }
      .pww-track > span { padding-right: 2em; }
      .pww-list { display: flex; flex-direction: column; gap: .2em; }
      .pww-new { animation: pww-pop .5s ease; }
      @keyframes pww-pop { from { transform: scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
      .pww-credits { position: relative; overflow: hidden; height: 100%; min-height: 4em; }
      .pww-roll { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
      .pww-roll h3 { margin: 0 0 .6em; font-size: 1.4em; color: var(--pww-accent); }
      .pww-roll h4 { margin: 1.2em 0 .3em; font-size: .8em; color: var(--pww-accent); text-transform: uppercase; letter-spacing: .06em; }
      .pww-roll p { margin: 0 0 .15em; }
      .pww-roll .pww-end { margin-top: 1.4em; font-size: 1.1em; }
      .pww.pww-row { flex-direction: row; align-items: baseline; gap: .6em; flex-wrap: wrap; }
      .pww-line { white-space: pre-line; }
      .pww-line[hidden] { display: none; }
      .pww-a-pulse { animation: pww-pulse .6s ease; }
      .pww-a-fade { animation: pww-fade .6s ease; }
      .pww-a-slide { animation: pww-slide .5s ease; }
      .pww-a-pop { animation: pww-pop .5s cubic-bezier(.2, 1.6, .4, 1); }
      @keyframes pww-pulse { 40% { transform: scale(1.12); } }
      @keyframes pww-fade { from { opacity: 0; } }
      @keyframes pww-slide { from { opacity: 0; transform: translateY(.6em); } }`;
    document.head.appendChild(st);
  }

  const rgba = (hex, alpha) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha / 100})`;
  function applyStyle(el, s) {
    const v = (k, x) => el.style.setProperty(k, x);
    v('--pww-font', C.FONTS[s.font] || C.FONTS.system);
    v('--pww-size', s.size + 'px');
    v('--pww-weight', String(s.weight));
    v('--pww-color', s.color);
    v('--pww-accent', s.accent);
    v('--pww-bg', s.bgAlpha ? rgba(s.bg, s.bgAlpha) : 'transparent');
    v('--pww-pad', s.bgAlpha ? Math.round(s.pad / 2) + 'px ' + s.pad + 'px' : '0');
    v('--pww-radius', s.radius + 'px');
    v('--pww-align', s.align);
    v('--pww-shadow', s.shadow ? '0 2px 6px rgba(0, 0, 0, .65)' : 'none');
    v('--pww-stroke', s.stroke ? s.stroke + 'px ' + s.strokeColor : '0');
    v('--pww-upper', s.upper ? 'uppercase' : 'none');
  }

  const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  // Intl.DateTimeFormat создавать дорого, а свой виджет перерисовывается 4 раза в секунду — держим готовые
  const dtfCache = new Map();
  function dtf(locale, opt, tz) {
    const k = (locale || '') + '|' + (tz || '') + '|' + JSON.stringify(opt);
    let f = dtfCache.get(k);
    if (!f) {
      try { f = new Intl.DateTimeFormat(locale, { ...opt, ...(tz && { timeZone: tz }) }); } catch (_) { f = new Intl.DateTimeFormat(locale, opt); }
      if (dtfCache.size > 50) dtfCache.clear();
      dtfCache.set(k, f);
    }
    return f;
  }
  const fmtNum = (n) => Number(n || 0).toLocaleString(window.I18N?.locale || undefined);
  const withPrefix = (prefix, text) => (prefix ? prefix + ' ' + text : text);

  function create(box, opts = {}) {
    injectCss();
    const preview = !!opts.preview;
    const root = document.createElement('div');
    root.className = 'pww';
    root.setAttribute('data-no-i18n', ''); // текст стримера и переведённые нами подписи — не трогать переводчику разметки
    box.appendChild(root);
    let w = null;
    let ctx = { live: null, stats: null };
    let tick = null;
    let lastText = null;
    let tickerKey = '';
    let creditsRun = 0;
    let creditsAnim = null;
    let lastItemsAt = 0;

    const setText = (el, text, dim = false) => {
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('pww-dim', dim);
    };
    const hide = (yes) => { root.hidden = !!yes && !preview; };

    function single(textFn) {
      root.replaceChildren();
      const el = document.createElement('div');
      el.className = 'pww-text';
      root.appendChild(el);
      return () => {
        const r = textFn();
        if (!r) return;
        const key = r.text + '|' + !!r.dim + '|' + !!r.hide;
        if (key === lastText) return;
        lastText = key;
        hide(r.hide);
        setText(el, r.text, r.dim);
      };
    }

    function stat(source) {
      const s = ctx.stats || {};
      if (source === 'title') return s.title || '';
      if (source === 'category') return s.category ? ((window.I18N?.lang === 'ru' && s.category.ru) || s.category.name) : '';
      return s[source] ?? 0;
    }

    // ---------- типы ----------
    function draw() {
      ticking.delete(tick);
      tick = null;
      lastText = null;
      stopCredits();
      root.classList.remove('pww-wide', 'pww-done', 'pww-fill', 'pww-row', 'pww-dim');
      root.hidden = false;
      const o = w.opts;
      const st = w.state;
      switch (w.type) {
        case 'uptime':
          tick = single(() => {
            const live = ctx.live;
            if (!live?.isLive || !live.startedAt) {
              if (o.offline === 'zero') return { text: withPrefix(o.prefix, C.fmtDuration(0, o.format)) };
              return { text: o.offlineText || tr('widgets.def.offline'), hide: o.offline === 'hide', dim: preview && o.offline === 'hide' };
            }
            return { text: withPrefix(o.prefix, C.fmtDuration(serverNow() - live.startedAt, o.format)) };
          });
          break;
        case 'countdown': {
          const text = document.createElement('div');
          text.className = 'pww-text';
          const bar = document.createElement('div');
          bar.className = 'pww-bar';
          bar.style.setProperty('--pww-barh', Math.max(6, Math.round(w.style.size / 4)) + 'px');
          bar.appendChild(document.createElement('i'));
          root.replaceChildren(text);
          if (o.bar) { root.classList.add('pww-wide'); root.appendChild(bar); }
          // звук в конце — только если отсчёт шёл у нас на глазах (не при открытии давно закончившегося)
          let armed = st.run && st.end > serverNow() ? st.end : 0;
          tick = () => {
            const left = C.countdownLeft(st, serverNow());
            const ended = st.run && left <= 0;
            if (ended && armed && armed === st.end) {
              armed = 0;
              if (o.sound !== 'none' && !preview) window.PWAlertRender?.playSound(o.sound, o.volume);
            }
            const label = ended ? (o.endText || tr('widgets.def.countdownEnd')) : withPrefix(o.prefix, C.fmtDuration(left + 999));
            hide(ended && o.endHide);
            setText(text, label, preview && ended && o.endHide);
            if (o.bar) bar.firstChild.style.width = (st.total ? Math.min(100, (left / st.total) * 100) : 0) + '%';
          };
          break;
        }
        case 'stopwatch':
          tick = single(() => ({ text: withPrefix(o.prefix, C.fmtDuration(C.stopwatchElapsed(st, serverNow()))) }));
          break;
        case 'clock': {
          const time = document.createElement('div');
          const date = document.createElement('div');
          date.className = 'pww-sub';
          root.replaceChildren(time);
          if (o.date) root.appendChild(date);
          const make = (fmt) => { try { return new Intl.DateTimeFormat(window.I18N?.locale || undefined, { ...fmt, ...(o.tz && { timeZone: o.tz }) }); } catch (_) { return new Intl.DateTimeFormat(window.I18N?.locale || undefined, fmt); } };
          const tf = make({ hour: '2-digit', minute: '2-digit', ...(o.seconds && { second: '2-digit' }), hour12: o.h12 });
          const df = make({ weekday: 'long', day: 'numeric', month: 'long' });
          tick = () => {
            const d = new Date(serverNow());
            setText(time, tf.format(d));
            if (o.date) setText(date, df.format(d));
          };
          break;
        }
        case 'text':
          tick = null;
          single(() => null);
          setText(root.firstChild, st.text || tr('widgets.def.textEmpty'), !st.text);
          hide(!st.text);
          break;
        case 'ticker': {
          root.classList.add('pww-wide');
          const wrap = document.createElement('div');
          wrap.className = 'pww-ticker';
          const track = document.createElement('div');
          track.className = 'pww-track';
          wrap.appendChild(track);
          root.replaceChildren(wrap);
          const items = (st.text || '').split('\n').map((x) => x.trim()).filter(Boolean);
          const line = items.length ? items.join('  ' + o.sep + '  ') : tr('widgets.def.tickerEmpty');
          hide(!items.length);
          // две копии подряд — бесшовная прокрутка; длительность — от длины строки и скорости
          for (let i = 0; i < 2; i++) {
            const sp = document.createElement('span');
            sp.textContent = line;
            if (!items.length) sp.className = 'pww-dim';
            track.appendChild(sp);
          }
          const run = () => {
            const width = track.firstChild.offsetWidth;
            const key = width + '|' + o.speed;
            if (!width || key === tickerKey) return;
            tickerKey = key;
            track.getAnimations?.().forEach((a) => a.cancel());
            track.animate?.([{ transform: 'translateX(0)' }, { transform: `translateX(-${width}px)` }], { duration: (width / o.speed) * 1000, iterations: Infinity });
          };
          tickerKey = '';
          requestAnimationFrame(run);
          tick = run; // ширина могла поменяться (шрифт догрузился, окно OBS изменили)
          break;
        }
        case 'custom':
          tick = drawCustom();
          break;
        case 'counter':
          tick = null;
          single(() => null);
          setText(root.firstChild, o.template ? fill(o.template, { n: fmtNum(st.n) }) : fmtNum(st.n));
          break;
        case 'stat':
          tick = null;
          single(() => null);
          drawStat();
          break;
        case 'goal':
          root.classList.add('pww-wide');
          drawGoal();
          break;
        case 'last':
          drawLast();
          break;
        case 'credits':
          root.classList.add('pww-wide', 'pww-fill');
          drawCreditsIdle();
          break;
      }
      if (tick) { tick(); ticking.add(tick); }
    }

    // ---------- свой виджет: строки-шаблоны с переменными канала ----------
    // переменная без значения (нет эфира, ещё не было подписчиков) — строка считается пустой и прячется (hideEmpty)
    function customResolver(lineIdx, missing) {
      const st = w.state;
      const s = ctx.stats || {};
      const last = ctx.last || {};
      const live = ctx.live;
      const now = serverNow();
      const rng = C.seeded(w.id + ':' + (st.rev || 0) + ':' + lineIdx);
      const val = (v) => { if (v === undefined || v === null || v === '') { missing.on = true; return ''; } return String(v); };
      const lastOf = (ev, k) => val(last[ev]?.[k]);
      const locale = window.I18N?.locale || undefined;
      const fmtDate = (d, opt, tz) => dtf(locale, opt, tz).format(d);
      // «+3» — смещение от UTC в часах, «Europe/Berlin» — часовой пояс, пусто — время компьютера с OBS
      const at = (p) => {
        const off = /^([+-]\d{1,2})$/.exec(String(p || '').trim());
        return off ? { d: new Date(now + Number(off[1]) * 3600000), tz: 'UTC' } : { d: new Date(now), tz: p ? String(p).trim() : '' };
      };
      return (key, p) => {
        switch (key) {
          case 'n': return String(st.n || 0);
          case 'text': return val(st.text);
          case 'uptime': return live?.isLive && live.startedAt ? C.fmtDuration(now - live.startedAt) : val('');
          case 'uptime_hm': return live?.isLive && live.startedAt ? C.fmtDuration(now - live.startedAt, 'hm') : val('');
          case 'live': return tr(live?.isLive ? 'widgets.var.liveOn' : 'widgets.var.liveOff');
          case 'viewers': return String(s.viewers || 0);
          case 'followers': return String(s.followers || 0);
          case 'followers_stream': return String(s.followersStream || 0);
          case 'title': return val(s.title);
          case 'category': return val(s.category ? (window.I18N?.lang === 'ru' && s.category.ru) || s.category.name : '');
          case 'streamer': return val(s.name);
          case 'time': { const x = at(p); return fmtDate(x.d, { hour: '2-digit', minute: '2-digit' }, x.tz); }
          case 'date': { const x = at(p); return fmtDate(x.d, { day: 'numeric', month: 'long' }, x.tz); }
          case 'weekday': { const x = at(p); return fmtDate(x.d, { weekday: 'long' }, x.tz); }
          case 'countdown': {
            // «2026-12-31 23:59» или «20:00» (ближайшее) — время компьютера с OBS
            const raw = String(p || '').trim();
            let target = null;
            const full = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
            const hm = /^(\d{1,2}):(\d{2})$/.exec(raw);
            if (full) target = new Date(+full[1], +full[2] - 1, +full[3], +(full[4] || 0), +(full[5] || 0)).getTime();
            else if (hm) {
              const d = new Date(now);
              d.setHours(+hm[1], +hm[2], 0, 0);
              if (d.getTime() <= now) d.setDate(d.getDate() + 1);
              target = d.getTime();
            }
            if (!target || !Number.isFinite(target)) return '?';
            const left = Math.max(0, target - now);
            const days = Math.floor(left / 86400000);
            return (days ? tr('widgets.var.days', { n: days }) + ' ' : '') + C.fmtDuration((left % 86400000) + 999);
          }
          case 'last_follower': return lastOf('follow', 'name');
          case 'last_reward': return lastOf('reward', 'reward');
          case 'last_reward_user': return lastOf('reward', 'name');
          case 'last_reward_cost': return lastOf('reward', 'cost');
          case 'last_reward_message': return lastOf('reward', 'message');
          case 'last_raider': return lastOf('raid', 'streamer');
          case 'last_raid_viewers': return lastOf('raid', 'viewers');
          case 'last_chatter': return lastOf('firstChat', 'name');
          case 'last_clip': return lastOf('clip', 'title');
          case 'last_clip_user': return lastOf('clip', 'name');
          case 'last_command': return lastOf('command', 'command');
          case 'last_command_user': return lastOf('command', 'name');
          case 'last_streak_user': return lastOf('streak', 'name');
          case 'last_streak': return lastOf('streak', 'count');
          case 'random': {
            const r = /^\s*(-?\d{1,9})\s*-\s*(-?\d{1,9})\s*$/.exec(p ?? '1-100') || (/^\s*(\d{1,9})\s*$/.test(p ?? '') ? [0, 1, p] : null);
            if (!r) return '?';
            let a = Number(r[1]), b = Number(r[2]);
            if (a > b) [a, b] = [b, a];
            return String(a + Math.floor(rng() * (b - a + 1)));
          }
          case 'choice': {
            const opts = String(p ?? '').split('|').map((x) => x.trim()).filter(Boolean);
            return opts.length ? opts[Math.floor(rng() * opts.length)] : '?';
          }
          case 'dice': return String(1 + Math.floor(rng() * 6));
          case 'coin': return tr(rng() < 0.5 ? 'widgets.var.heads' : 'widgets.var.tails');
          case 'calc': return p === null ? null : C.calc(p);
          case 'percent': {
            const m = /^(.*):([^:]*)$/.exec(String(p ?? ''));
            const a = Number(m?.[1]), b = Number(m?.[2]);
            return m && b ? String(Math.round((a / b) * 100)) : '?';
          }
          case 'upper': return p === null ? null : String(p).toLocaleUpperCase(locale);
          case 'lower': return p === null ? null : String(p).toLocaleLowerCase(locale);
          default: return null;
        }
      };
    }

    function drawCustom() {
      const o = w.opts;
      root.classList.toggle('pww-row', o.layout === 'row');
      const els = o.lines.map((l) => {
        const d = document.createElement('div');
        d.className = 'pww-line';
        d.style.fontSize = l.size + '%';
        if (l.bold) d.style.fontWeight = '900';
        if (l.color) d.style.color = l.color;
        return d;
      });
      root.replaceChildren(...els);
      let bar = null;
      if (o.bar) {
        root.classList.add('pww-wide');
        bar = document.createElement('div');
        bar.className = 'pww-bar';
        bar.style.setProperty('--pww-barh', o.barH + 'px');
        bar.append(document.createElement('i'), document.createElement('b'));
        root.appendChild(bar);
      }
      const prev = o.lines.map(() => null);
      return () => {
        const live = !!ctx.live?.isLive;
        const show = o.showWhen === 'always' || (o.showWhen === 'live') === live;
        const texts = o.lines.map((l, i) => {
          const missing = { on: false };
          const text = C.renderTpl(l.text, customResolver(i, missing)).trim();
          return { text, empty: !text || (o.hideEmpty && missing.on) };
        });
        // по очереди: показываем одну непустую строку, смена раз в rotateSec (одинаково в OBS и в превью)
        const filled = texts.map((x, i) => (x.empty ? -1 : i)).filter((i) => i >= 0);
        const cur = o.mode === 'rotate' && filled.length ? filled[Math.floor(serverNow() / 1000 / o.rotateSec) % filled.length] : -1;
        texts.forEach((x, i) => {
          const el = els[i];
          // в превью пустая строка видна серым шаблоном (чтобы было видно, что там), в OBS — спрятана
          const hidden = (cur >= 0 && i !== cur) || (x.empty && (!preview || !l(i).text));
          if (el.hidden !== hidden) el.hidden = hidden;
          el.classList.toggle('pww-dim', preview && x.empty);
          const shown = x.text || (preview ? l(i).text : '');
          if (prev[i] !== shown) {
            const changed = prev[i] !== null && o.anim !== 'none' && !hidden;
            prev[i] = shown;
            el.textContent = shown;
            if (changed) { el.classList.remove('pww-a-' + o.anim); void el.offsetWidth; el.classList.add('pww-a-' + o.anim); }
          }
        });
        if (bar) {
          const r = customResolver(99, { on: false });
          const v = Number(C.renderTpl(o.barValue, r)) || 0;
          const max = Number(C.renderTpl(o.barMax, r)) || 100;
          bar.firstChild.style.width = Math.max(0, Math.min(100, (v / max) * 100)) + '%';
          bar.lastChild.textContent = v + ' / ' + max;
        }
        const allEmpty = texts.every((x) => x.empty) && !bar;
        root.hidden = (!show || allEmpty) && !preview;
        root.classList.toggle('pww-dim', preview && !show);
      };
      function l(i) { return o.lines[i]; }
    }

    function drawStat() {
      const o = w.opts;
      const v = stat(o.source);
      const isText = o.source === 'title' || o.source === 'category';
      const shown = isText ? v : fmtNum(v);
      const tpl = o.template || tr('widgets.def.stat.' + o.source);
      const empty = isText && !v;
      setText(root.firstChild, empty ? tr('widgets.def.statEmpty') : fill(tpl, { n: shown }), empty);
      hide(empty);
    }

    function drawGoal() {
      const o = w.opts;
      const n = o.source === 'manual' ? w.state.n : Number(stat(o.source)) || 0;
      const done = n >= o.target;
      root.classList.toggle('pww-done', done);
      const head = document.createElement('div');
      head.className = 'pww-goal-head';
      const title = document.createElement('span');
      title.textContent = done && o.endText ? o.endText : o.title || tr('widgets.def.goal.' + o.source);
      head.appendChild(title);
      const bar = document.createElement('div');
      bar.className = 'pww-bar';
      bar.style.setProperty('--pww-barh', o.barH + 'px');
      const fillEl = document.createElement('i');
      bar.appendChild(fillEl);
      if (o.numbers) {
        const nums = document.createElement('b');
        nums.textContent = fmtNum(n) + ' / ' + fmtNum(o.target);
        bar.appendChild(nums);
      }
      const prev = root.querySelector('.pww-bar > i')?.style.width || '0%';
      root.replaceChildren(head, bar);
      fillEl.style.width = prev; // плавно от прежнего значения
      requestAnimationFrame(() => { fillEl.style.width = Math.min(100, (n / o.target) * 100) + '%'; });
    }

    function drawLast() {
      const o = w.opts;
      const items = (w.state.items || []).slice(0, o.count);
      const list = document.createElement('div');
      list.className = 'pww-list';
      const tpl = o.template || tr('widgets.def.last.' + o.event);
      if (!items.length) {
        const p = document.createElement('div');
        p.textContent = o.empty || tr('widgets.def.lastEmpty');
        if (!o.empty) p.className = 'pww-dim';
        list.appendChild(p);
        hide(!o.empty);
      } else {
        hide(false);
        for (const it of items) {
          const p = document.createElement('div');
          p.textContent = fill(tpl, it.vars || {});
          if (it.at > lastItemsAt && lastItemsAt) p.className = 'pww-new';
          list.appendChild(p);
        }
      }
      lastItemsAt = items[0]?.at || lastItemsAt || 1;
      root.replaceChildren(list);
    }

    // ---------- титры ----------
    function stopCredits() {
      creditsAnim?.cancel();
      creditsAnim = null;
    }
    function drawCreditsIdle() {
      const p = document.createElement('div');
      p.className = 'pww-dim';
      p.textContent = tr('widgets.def.creditsIdle');
      root.replaceChildren(p);
      hide(true);
      const st = w.state;
      const fresh = st.runAt && st.runAt > (st.stopAt || 0) && serverNow() - st.runAt < 15000;
      if ((fresh || (w.opts.auto && !preview && !creditsRun)) && st.runAt !== creditsRun) runCredits(st.runAt || 1);
    }
    async function runCredits(runId) {
      creditsRun = runId;
      const data = typeof opts.credits === 'function' ? await opts.credits().catch(() => null) : null;
      if (!w || w.type !== 'credits' || creditsRun !== runId) return;
      const o = w.opts;
      const outer = document.createElement('div');
      outer.className = 'pww-credits';
      const roll = document.createElement('div');
      roll.className = 'pww-roll';
      const h = document.createElement('h3');
      h.textContent = o.title || tr('widgets.def.creditsTitle');
      roll.appendChild(h);
      for (const sec of C.CREDIT_SECTIONS) {
        const names = o.sections[sec] && Array.isArray(data?.[sec]) ? data[sec] : [];
        if (!names.length) continue;
        const h4 = document.createElement('h4');
        h4.textContent = tr('widgets.credits.' + sec);
        roll.appendChild(h4);
        for (const n of names) {
          const p = document.createElement('p');
          p.textContent = n;
          roll.appendChild(p);
        }
      }
      const end = document.createElement('div');
      end.className = 'pww-end';
      end.textContent = o.endText || tr('widgets.def.creditsEnd');
      roll.appendChild(end);
      outer.appendChild(roll);
      root.replaceChildren(outer);
      root.hidden = false;
      const H = outer.offsetHeight || box.offsetHeight || 400;
      const total = roll.offsetHeight + H;
      creditsAnim = roll.animate?.([{ transform: `translateY(${H}px)` }, { transform: `translateY(-${roll.offsetHeight}px)` }], {
        duration: (total / o.speed) * 1000, iterations: o.loop ? Infinity : 1,
      });
      if (creditsAnim) creditsAnim.onfinish = () => { if (creditsRun === runId) { creditsAnim = null; drawCreditsIdle(); } };
    }

    return {
      root,
      set(widget, now) {
        syncClock(now);
        const prev = w;
        w = widget;
        applyStyle(root, w.style);
        // титры уже идут, а поменялось не «запуск/стоп» — не перезапускаем
        if (prev && prev.type === 'credits' && w.type === 'credits' && creditsAnim) {
          if (w.state.stopAt > (prev.state.stopAt || 0)) { creditsRun = 0; stopCredits(); drawCreditsIdle(); }
          else if (w.state.runAt !== prev.state.runAt) runCredits(w.state.runAt);
          return;
        }
        draw();
      },
      ctx(next, now) {
        syncClock(now);
        ctx = { ...ctx, ...next };
        if (!w) return;
        if (w.type === 'stat') drawStat();
        else if (w.type === 'goal' && w.opts.source !== 'manual') drawGoal();
        else if (tick) tick();
      },
      // запустить титры здесь же (превью в студии)
      runCredits() { if (w?.type === 'credits') runCredits(Date.now()); },
      destroy() {
        ticking.delete(tick);
        stopCredits();
        root.remove();
        w = null;
      },
    };
  }

  window.PWWidgetRender = { create, syncClock, serverNow };
})();
