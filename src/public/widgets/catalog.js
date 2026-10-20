// Каталог виджетов (студия → ⏱️ Виджеты, оверлей OBS /overlay/widget.html, мини-пульт): типы, стиль, настройки
// и состояние. Общий для сервера (проверка того, что прислали) и браузера. Состояние меняет только сервер (actions)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PWWidgetCatalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // icon — в студии и мини-пульте; cmd — команда чата, которой управляют виджетом этого типа
  const TYPES = [
    { id: 'uptime', icon: '📡' },
    { id: 'countdown', icon: '⏳', cmd: 'timer' },
    { id: 'stopwatch', icon: '⏱', cmd: 'sw' },
    { id: 'clock', icon: '🕒' },
    { id: 'text', icon: '💬', cmd: 'text' },
    { id: 'ticker', icon: '📜', cmd: 'ticker' },
    { id: 'counter', icon: '🔢', cmd: 'count' },
    { id: 'goal', icon: '🎯', cmd: 'goal' },
    { id: 'stat', icon: '📊' },
    { id: 'last', icon: '🔔' },
    { id: 'credits', icon: '🎬', cmd: 'credits' },
    // свой виджет из строк с переменными (кнопка «Создать свой виджет»); /w имя +1 | =5 | roll | text …
    { id: 'custom', icon: '✨', cmd: 'w' },
  ];
  const typeById = (id) => TYPES.find((x) => x.id === id) || null;

  const MAX_WIDGETS = 20;
  const FONTS = {
    system: "'Segoe UI', system-ui, -apple-system, sans-serif",
    arial: 'Arial, Helvetica, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    trebuchet: "'Trebuchet MS', Tahoma, sans-serif",
    georgia: 'Georgia, serif',
    times: "'Times New Roman', Times, serif",
    impact: "Impact, 'Arial Black', sans-serif",
    comic: "'Comic Sans MS', 'Comic Neue', cursive",
    courier: "'Courier New', Courier, monospace",
    mono: "Consolas, 'Cascadia Mono', Menlo, monospace",
  };
  const ALIGNS = ['left', 'center', 'right'];
  const WEIGHTS = [400, 600, 700, 900];
  // источники чисел: зрители сейчас, подписчики всего, подписки за эфир; у «Числа» ещё название и категория эфира
  const GOAL_SOURCES = ['manual', 'followers', 'followersStream', 'viewers'];
  const STAT_SOURCES = ['viewers', 'followers', 'followersStream', 'title', 'category'];
  // события, которые умеет «Последнее событие» (из каталога алертов)
  const LAST_EVENTS = ['follow', 'reward', 'raid', 'firstChat', 'clip', 'command'];
  const CREDIT_SECTIONS = ['followers', 'raiders', 'rewards', 'chatters', 'mods'];
  const SOUNDS = ['none', 'chime', 'fanfare', 'coin', 'pop', 'levelup', 'magic', 'bell', 'victory', 'siren', 'success', 'harp'];

  const DAY = 86400;
  const LIMITS = { name: 40, slug: 20, prefix: 60, template: 80, text: 300, ticker: 1000, items: 10, credits: 200, line: 200, lines: 6 };
  const SHOW_WHEN = ['always', 'live', 'offline'];
  const LINE_ANIMS = ['none', 'pulse', 'fade', 'slide', 'pop'];
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const SLUG_RE = /^[a-z0-9_-]{1,20}$/;
  const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

  const num = (v, min, max, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, max);
  const line = (v, max) => str(v, max).replace(/\s*\n\s*/g, ' ').trim();
  const color = (v, d) => (COLOR_RE.test(v || '') ? String(v).toLowerCase() : d);
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);

  // ---------- стиль (общий для всех типов) ----------
  const STYLE_DEFAULTS = {
    font: 'system', size: 48, weight: 700, color: '#ffffff', accent: '#a78bfa',
    bg: '#000000', bgAlpha: 0, pad: 12, radius: 12, align: 'center',
    shadow: true, stroke: 0, strokeColor: '#000000', upper: false,
  };
  // у некоторых типов размер по умолчанию другой
  const SIZE_DEFAULT = { ticker: 32, last: 32, credits: 32, goal: 28, text: 40, custom: 34 };

  function cleanStyle(raw, type) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = STYLE_DEFAULTS;
    return {
      font: Object.hasOwn(FONTS, r.font) ? r.font : d.font,
      size: num(r.size, 10, 200, SIZE_DEFAULT[type] || d.size),
      weight: WEIGHTS.includes(Number(r.weight)) ? Number(r.weight) : d.weight,
      color: color(r.color, d.color),
      accent: color(r.accent, d.accent),
      bg: color(r.bg, d.bg),
      bgAlpha: num(r.bgAlpha, 0, 100, d.bgAlpha),
      pad: num(r.pad, 0, 60, d.pad),
      radius: num(r.radius, 0, 60, d.radius),
      align: pick(r.align, ALIGNS, d.align),
      shadow: bool(r.shadow, d.shadow),
      stroke: num(r.stroke, 0, 8, d.stroke),
      strokeColor: color(r.strokeColor, d.strokeColor),
      upper: bool(r.upper, d.upper),
    };
  }

  // ---------- настройки по типам (пустой текст = подпись по умолчанию на языке оверлея) ----------
  function cleanOpts(type, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    switch (type) {
      case 'uptime':
        return { prefix: line(r.prefix, LIMITS.prefix), format: pick(r.format, ['hms', 'hm'], 'hms'), offline: pick(r.offline, ['hide', 'text', 'zero'], 'text'), offlineText: line(r.offlineText, LIMITS.prefix) };
      case 'countdown':
        return {
          sec: num(r.sec, 1, DAY, 300), prefix: line(r.prefix, LIMITS.prefix), endText: line(r.endText, LIMITS.template),
          endHide: bool(r.endHide, false), sound: pick(r.sound, SOUNDS, 'chime'), volume: num(r.volume, 0, 100, 70), bar: bool(r.bar, false),
        };
      case 'stopwatch':
        return { prefix: line(r.prefix, LIMITS.prefix) };
      case 'clock': {
        const tz = TZ_RE.test(r.tz || '') ? String(r.tz) : '';
        return { h12: bool(r.h12, false), seconds: bool(r.seconds, true), date: bool(r.date, false), tz };
      }
      case 'text':
        return {};
      case 'ticker':
        return { speed: num(r.speed, 20, 400, 90), sep: line(r.sep, 10) || '•' };
      case 'counter':
        return { template: line(r.template, LIMITS.template), step: num(r.step, 1, 1000, 1), negative: bool(r.negative, false) };
      case 'goal':
        return {
          title: line(r.title, LIMITS.template), source: pick(r.source, GOAL_SOURCES, 'manual'),
          target: num(r.target, 1, 1e9, 100), numbers: bool(r.numbers, true), barH: num(r.barH, 4, 80, 26), endText: line(r.endText, LIMITS.template),
        };
      case 'stat':
        return { source: pick(r.source, STAT_SOURCES, 'viewers'), template: line(r.template, LIMITS.template) };
      case 'last':
        return { event: pick(r.event, LAST_EVENTS, 'follow'), count: num(r.count, 1, LIMITS.items, 1), template: line(r.template, LIMITS.template), empty: line(r.empty, LIMITS.template) };
      case 'custom': {
        const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, LIMITS.lines).map((x) => {
          const l = x && typeof x === 'object' ? x : { text: x };
          return { text: line(l.text, LIMITS.line), size: num(l.size, 30, 300, 100), bold: bool(l.bold, false), color: COLOR_RE.test(l.color || '') ? String(l.color).toLowerCase() : '' };
        });
        return {
          lines: lines.length ? lines : [{ text: '', size: 100, bold: false, color: '' }],
          mode: pick(r.mode, ['all', 'rotate'], 'all'), rotateSec: num(r.rotateSec, 2, 120, 6),
          showWhen: pick(r.showWhen, SHOW_WHEN, 'always'), hideEmpty: bool(r.hideEmpty, true),
          anim: pick(r.anim, LINE_ANIMS, 'pulse'), layout: pick(r.layout, ['column', 'row'], 'column'),
          bar: bool(r.bar, false), barValue: line(r.barValue, LIMITS.template), barMax: line(r.barMax, LIMITS.template), barH: num(r.barH, 4, 80, 18),
        };
      }
      case 'credits': {
        const s = r.sections && typeof r.sections === 'object' ? r.sections : {};
        const sections = {};
        for (const k of CREDIT_SECTIONS) sections[k] = bool(s[k], k !== 'mods');
        return { title: line(r.title, LIMITS.template), endText: line(r.endText, LIMITS.template), speed: num(r.speed, 20, 300, 60), auto: bool(r.auto, false), loop: bool(r.loop, false), sections };
      }
      default:
        return {};
    }
  }

  // ---------- состояние (меняет только сервер; клиент присылает действие) ----------
  // время — отметки сервера в мс: оверлей считает сам с поправкой на разницу часов (now в ответе)
  function cleanState(type, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const ms = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
    switch (type) {
      case 'countdown':
        return { run: !!r.run, end: ms(r.end), left: Math.min(DAY * 1000, ms(r.left)), total: Math.min(DAY * 1000, ms(r.total)) };
      case 'stopwatch':
        return { run: !!r.run, start: ms(r.start), acc: Math.min(100 * DAY * 1000, ms(r.acc)) };
      case 'text':
        return { text: str(r.text, LIMITS.text).trim() };
      case 'ticker':
        return { text: str(r.text, LIMITS.ticker).trim() };
      case 'counter':
      case 'goal':
        return { n: num(r.n, -1e9, 1e9, 0) };
      case 'last':
        return {
          items: (Array.isArray(r.items) ? r.items : []).slice(0, LIMITS.items).filter((x) => x && typeof x === 'object').map((x) => ({
            vars: cleanVars(x.vars), at: ms(x.at),
          })),
        };
      case 'credits':
        return { runAt: ms(r.runAt), stopAt: ms(r.stopAt) };
      case 'custom':
        return { n: num(r.n, -1e9, 1e9, 0), text: str(r.text, LIMITS.text).trim(), rev: num(r.rev, 0, 1e9, 0) };
      default:
        return {};
    }
  }
  // переменные события: только короткие строки и числа
  function cleanVars(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const k of Object.keys(v).slice(0, 8)) {
      if (!/^[a-z]{1,12}$/i.test(k)) continue;
      const x = v[k];
      if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
      else if (typeof x === 'string') out[k] = x.slice(0, 100);
    }
    return out;
  }

  // целый виджет: id и тип сохраняются, имя и slug — проверяются
  function cleanWidget(raw, fallback = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const type = typeById(r.type) ? r.type : fallback.type;
    if (!typeById(type)) return null;
    const slug = String(r.slug || '').toLowerCase();
    return {
      id: /^[a-f0-9]{8,16}$/.test(r.id || '') ? r.id : fallback.id,
      type,
      name: line(r.name, LIMITS.name),
      slug: SLUG_RE.test(slug) ? slug : fallback.slug || type,
      style: cleanStyle(r.style, type),
      opts: cleanOpts(type, r.opts),
      state: cleanState(type, r.state),
    };
  }

  // ---------- время: «90», «5m», «1h30m», «2:30», «1:00:00» → секунды (null — не понял) ----------
  function parseSpan(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    let m = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
    if (m) return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    m = /^(?:(\d{1,3})(?:h|ч))?(?:(\d{1,4})(?:m|м|min|мин))?(?:(\d{1,5})(?:s|с|sec|сек)?)?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
    return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  }

  // мс → «1:02:03» / «02:03» (hm — без секунд: «1:02»)
  function fmtDuration(msLeft, format = 'hms') {
    const total = Math.max(0, Math.floor(msLeft / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const p = (n) => String(n).padStart(2, '0');
    if (format === 'hm') return h + ':' + p(m);
    return h ? h + ':' + p(m) + ':' + p(sec) : p(m) + ':' + p(sec);
  }

  // сколько осталось / прошло на момент now (мс сервера)
  function countdownLeft(st, now) {
    if (st.run) return Math.max(0, st.end - now);
    return st.left || 0;
  }
  function stopwatchElapsed(st, now) {
    return st.run ? Math.max(0, now - st.start) : st.acc || 0;
  }

  // ---------- шаблоны «своего виджета»: {переменная}, {функция:параметр}, вложенные {calc:{followers}+1} ----------
  // resolve(key, param) → строка или null (не знаю — оставить как есть). Самые внутренние {…} — первыми
  function renderTpl(tpl, resolve) {
    let out = String(tpl ?? '');
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      out = out.replace(/\{([^{}]*)\}/g, (m, body) => {
        changed = true;
        const i = body.indexOf(':');
        const key = (i < 0 ? body : body.slice(0, i)).trim().toLowerCase();
        const r = resolve(key, i < 0 ? null : body.slice(i + 1));
        return r === null || r === undefined ? '\u0001' + body + '\u0002' : String(r).replace(/[{}]/g, '');
      });
      if (!changed) break;
    }
    return out.replace(/\u0001/g, '{').replace(/\u0002/g, '}');
  }

  // калькулятор без eval: + - * / % и скобки (как в командах чата)
  function calc(expr) {
    const s = String(expr ?? '').replace(/,/g, '.').replace(/\s+/g, '');
    if (!s || s.length > 80 || !/^[0-9+\-*/%().]+$/.test(s)) return '?';
    let i = 0;
    const atom = () => {
      if (s[i] === '(') { i++; const v = add(); if (s[i] !== ')') throw new Error('bad'); i++; return v; }
      const m = /^\d+(\.\d+)?/.exec(s.slice(i));
      if (!m) throw new Error('bad');
      i += m[0].length;
      return parseFloat(m[0]);
    };
    const unary = () => (s[i] === '-' ? (i++, -unary()) : s[i] === '+' ? (i++, unary()) : atom());
    const mul = () => { let v = unary(); while (s[i] === '*' || s[i] === '/' || s[i] === '%') { const op = s[i++]; const r = unary(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; };
    const add = () => { let v = mul(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = mul(); v = op === '+' ? v + r : v - r; } return v; };
    try {
      const v = add();
      if (i !== s.length || !Number.isFinite(v)) return '?';
      return String(Math.round(v * 100) / 100);
    } catch (_) { return '?'; }
  }

  // случайность «своего виджета» постоянна, пока не нажали «Перебросить» (state.rev): иначе мигала бы каждый кадр
  function seeded(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let x = h;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // переменные «своего виджета» — для подсказок в студии (описания — widgets.var.<имя>)
  const CUSTOM_VARS = [
    'n', 'text', 'uptime', 'uptime_hm', 'live', 'viewers', 'followers', 'followers_stream', 'title', 'category', 'streamer',
    'time', 'date', 'weekday', 'last_follower', 'last_reward', 'last_reward_user', 'last_reward_cost', 'last_reward_message',
    'last_raider', 'last_raid_viewers', 'last_chatter', 'last_clip', 'last_clip_user', 'last_command', 'last_command_user',
  ];
  // функции: пример вставки → ключ описания
  const CUSTOM_FUNCS = [
    ['{random:1-100}', 'random'], ['{choice:A|B|C}', 'choice'], ['{dice}', 'dice'], ['{coin}', 'coin'],
    ['{calc:{followers}+10}', 'calc'], ['{percent:{followers_stream}:10}', 'percent'], ['{countdown:2026-12-31 23:59}', 'countdown'],
    ['{time:Europe/Moscow}', 'timeTz'], ['{upper:{title}}', 'upper'], ['{lower:{title}}', 'lower'],
  ];

  // пример данных канала для превью (студия, пре-сеты)
  function sampleCtx(now = Date.now()) {
    return {
      live: { isLive: true, startedAt: now - 3725000 },
      stats: { viewers: 42, followers: 1337, followersStream: 7, title: 'Speedrun', category: { name: 'Minecraft', ru: '' }, name: 'Streamer' },
      last: {
        follow: { name: 'Viewer123' }, reward: { name: 'Neyrite', reward: 'Hydrate!', cost: 300, message: 'GG' },
        raid: { streamer: 'FriendStreamer', viewers: 25 }, firstChat: { name: 'NewViewer', message: 'hi' },
        clip: { name: 'ClipMaster', title: 'Epic moment' }, command: { name: 'Viewer123', command: '!dice' },
      },
    };
  }

  return {
    renderTpl, calc, seeded, CUSTOM_VARS, CUSTOM_FUNCS, sampleCtx, SHOW_WHEN, LINE_ANIMS,
    TYPES, MAX_WIDGETS, FONTS, ALIGNS, WEIGHTS, GOAL_SOURCES, STAT_SOURCES, LAST_EVENTS, CREDIT_SECTIONS, SOUNDS, LIMITS,
    STYLE_DEFAULTS, SLUG_RE, typeById, cleanStyle, cleanOpts, cleanState, cleanVars, cleanWidget, parseSpan, fmtDuration,
    countdownLeft, stopwatchElapsed,
  };
});
