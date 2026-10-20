// Шаблоны ответов для команд чата. Без eval: свой разбор переменных и калькулятора.
const i18n = require('./i18n');
const RESERVED = new Set([
  'user', 'streamer', 'title', 'viewers', 'uptime', 'count', 'args', 'target',
  'random', 'dice', 'coin', 'choice', 'calc', 'time', 'date',
  // добавлены позже: данные канала и зрителя (считаются, только если есть в ответе — EXTRA_VARS)
  'followers', 'category', 'followage', 'points', 'points_name', 'random_user', 'last_follower', 'channel',
  'weekday', 'countdown', 'upper', 'lower', 'widget', 'account_age', 'messages',
]);
// переменные, которые требуют запроса к базе или памяти сокета: chatSocket считает только встреченные в ответе
const EXTRA_VARS = ['followers', 'category', 'followage', 'points', 'points_name', 'random_user', 'last_follower', 'account_age', 'messages', 'widget'];
// какие из них есть в шаблоне ({widget:…} — тоже)
function neededVars(template) {
  const s = String(template || '');
  return new Set(EXTRA_VARS.filter((k) => new RegExp('\\{' + k + '(?::|\\})').test(s)));
}
// «3 дн 4 ч», «5 ч 12 мин», «7 мин» — на языке ответа
function humanSpan(ms, lang) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 365) return i18n.t(lang, 'server.cmd.spanYD', { y: Math.floor(d / 365), d: d % 365 });
  if (d) return i18n.t(lang, 'server.cmd.spanDH', { d, h });
  if (h) return i18n.t(lang, 'server.cmd.spanHM', { h, m: mm });
  return i18n.t(lang, 'server.cmd.spanM', { m: mm });
}
const ARG_NAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ]{1,15}$/;
const MAX_ARGS = 5;

const clean = (s) => String(s ?? '').replace(/[{}\u0001\u0002]/g, '');
const randInt = (a, b) => {
  if (a > b) [a, b] = [b, a];
  return a + Math.floor(Math.random() * (b - a + 1));
};

// из тела запроса → [{ name, optional }] или { error: ключ словаря, vars }
function parseArgsInput(raw) {
  if (raw == null) return { args: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ARGS) return { error: 'server.cmd.tooManyArgs', vars: { n: MAX_ARGS } };
  const seen = new Set();
  const args = [];
  for (const a of raw) {
    const name = String(a?.name ?? '').trim().toLowerCase();
    if (!ARG_NAME_RE.test(name)) return { error: 'server.cmd.argName' };
    if (RESERVED.has(name) || /^arg\d+$/.test(name)) return { error: 'server.cmd.argReserved', vars: { name } };
    if (seen.has(name)) return { error: 'server.cmd.argDup', vars: { name } };
    seen.add(name);
    args.push({ name, optional: !!a?.optional });
  }
  return { args };
}

function parseCommandLine(text) {
  const t = String(text ?? '').trim();
  if (t[0] !== '!') return null;
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { name: parts[0].toLowerCase(), argv: parts.slice(1, 21).map(clean) };
}

function usageOf(cmd) {
  const list = (cmd.args || []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`));
  return ['!' + cmd.name, ...list].join(' ');
}

// калькулятор без eval: + - * / % и скобки
function calc(expr) {
  const s = String(expr ?? '').replace(/,/g, '.').replace(/\s+/g, '');
  if (!s || s.length > 60 || !/^[0-9+\-*/%().]+$/.test(s)) return '?';
  let i = 0;
  const peek = () => s[i];
  function atom() {
    if (peek() === '(') {
      i++;
      const v = add();
      if (peek() !== ')') throw new Error('bad');
      i++;
      return v;
    }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error('bad');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function unary() {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return atom();
  }
  function mul() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[i++];
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function add() {
    let v = mul();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = add();
    if (i !== s.length || !Number.isFinite(v)) return '?';
    return String(Math.round(v * 1e6) / 1e6);
  } catch (_) {
    return '?';
  }
}

function shifted(param) {
  let off = 3; // по умолчанию Москва
  if (param !== null) {
    const m = String(param).trim().match(/^([+-]?\d{1,2})$/);
    if (!m || Math.abs(Number(m[1])) > 14) return null;
    off = Number(m[1]);
  }
  return new Date(Date.now() + off * 3600 * 1000);
}

// null — неизвестная переменная (останется в тексте как есть)
function evalToken(body, vars, lang) {
  const idx = body.indexOf(':');
  const key = (idx === -1 ? body : body.slice(0, idx)).trim().toLowerCase();
  const param = idx === -1 ? null : body.slice(idx + 1);

  if (param === null && Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];

  switch (key) {
    case 'random': {
      const p = param === null ? '100' : param.trim();
      const range = p.match(/^(-?\d{1,9})\s*-\s*(-?\d{1,9})$/);
      if (range) return randInt(Number(range[1]), Number(range[2]));
      if (/^\d{1,9}$/.test(p) && Number(p) >= 1) return randInt(1, Number(p));
      return '?';
    }
    case 'dice': return param === null ? randInt(1, 6) : null;
    case 'coin': return param === null ? i18n.t(lang, Math.random() < 0.5 ? 'server.cmd.heads' : 'server.cmd.tails') : null;
    case 'choice': {
      if (param === null) return null;
      const opts = param.split('|').map((x) => x.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '?';
    }
    case 'calc': return param === null ? null : calc(param);
    case 'time': {
      const d = shifted(param);
      return d ? d.toISOString().slice(11, 16) : '?';
    }
    case 'date': {
      const d = shifted(param);
      if (!d) return '?';
      const [y, mo, da] = d.toISOString().slice(0, 10).split('-');
      return `${da}.${mo}.${y}`;
    }
    case 'weekday': {
      const d = shifted(param);
      return d ? new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(d) : '?';
    }
    // {countdown:2026-12-31 23:59} — сколько осталось (время — московское, как у {time})
    case 'countdown': {
      const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(param || '');
      if (!m) return '?';
      const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 3, +(m[5] || 0));
      if (!Number.isFinite(target)) return '?';
      const left = target - Date.now();
      return left <= 0 ? i18n.t(lang, 'server.cmd.countdownDone') : humanSpan(left, lang);
    }
    case 'upper': return param === null ? null : String(param).toLocaleUpperCase(lang === 'ru' ? 'ru-RU' : 'en-GB');
    case 'lower': return param === null ? null : String(param).toLocaleLowerCase(lang === 'ru' ? 'ru-RU' : 'en-GB');
    // {widget:имя} — число или текст виджета OBS (chatSocket подкладывает значения в vars.__widgets)
    case 'widget': {
      if (param === null) return null;
      const v = vars.__widgets?.[String(param).trim().toLowerCase()];
      return v === undefined || v === null ? '?' : clean(v);
    }
    default: return null;
  }
}

// самые внутренние {…} считаются первыми, поэтому {random:{число}} работает
function renderTemplate(template, vars, lang) {
  let out = String(template ?? '');
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    out = out.replace(/\{([^{}]*)\}/g, (m, body) => {
      changed = true;
      const r = evalToken(body, vars, lang);
      return r === null ? '\u0001' + body + '\u0002' : String(r);
    });
    if (!changed) break;
  }
  return out.replace(/\u0001/g, '{').replace(/\u0002/g, '}').slice(0, 500);
}

// cmd: { name, args, response }, argv: слова после команды, ctx: { user, streamer, title, viewers, uptime, count, lang }
// lang — язык служебных слов ответа (орёл/решка, «Использование»)
function buildReply(cmd, argv, ctx) {
  const declared = Array.isArray(cmd.args) ? cmd.args : [];
  let needed = 0;
  declared.forEach((a, i) => { if (!a.optional) needed = i + 1; });
  if (argv.length < needed) return { text: i18n.t(ctx.lang, 'server.cmd.usage', { usage: usageOf(cmd) }), usage: true };

  const vars = {
    user: clean(ctx.user),
    streamer: clean(ctx.streamer),
    title: clean(ctx.title),
    viewers: clean(ctx.viewers),
    uptime: clean(ctx.uptime),
    count: clean(ctx.count),
    args: argv.join(' '),
    target: (argv[0] || clean(ctx.user)).replace(/^@/, ''),
  };
  for (let i = 0; i < 9; i++) vars['arg' + (i + 1)] = argv[i] ?? '';
  // данные канала и зрителя, посчитанные заранее (только те, что есть в ответе): { followers, followage, … }
  for (const [k, v] of Object.entries(ctx.extra || {})) {
    if (k === '__widgets') vars.__widgets = v;
    else if (v !== undefined && v !== null) vars[k] = clean(v);
  }
  vars.channel = vars.streamer;
  declared.forEach((a, i) => { vars[a.name] = argv[i] ?? ''; });

  return { text: renderTemplate(cmd.response, vars, ctx.lang), usage: false };
}

// примеры для превью (конструктор, пре-сеты): то, что на эфире считается запросом
function sampleExtras(lang, over = {}) {
  return {
    followers: 128, category: 'Minecraft', followage: humanSpan(41 * 86400000, lang), points: 1250,
    points_name: i18n.t(lang, 'server.rewards.pointsDefault'), random_user: 'Neyrite', last_follower: 'NewFollower',
    account_age: humanSpan(400 * 86400000, lang), messages: 57, __widgets: new Proxy({}, { get: () => '7' }), ...over,
  };
}

module.exports = { sampleExtras, parseArgsInput, parseCommandLine, buildReply, usageOf, renderTemplate, neededVars, humanSpan, clean, MAX_ARGS, EXTRA_VARS };