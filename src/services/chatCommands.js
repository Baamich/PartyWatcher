// Шаблоны ответов для команд чата. Без eval: свой разбор переменных и калькулятора.
const RESERVED = new Set([
  'user', 'streamer', 'title', 'viewers', 'uptime', 'count', 'args', 'target',
  'random', 'dice', 'coin', 'choice', 'calc', 'time', 'date',
]);
const ARG_NAME_RE = /^[a-zA-Z0-9_а-яА-ЯёЁ]{1,15}$/;
const MAX_ARGS = 5;

const clean = (s) => String(s ?? '').replace(/[{}\u0001\u0002]/g, '');
const randInt = (a, b) => {
  if (a > b) [a, b] = [b, a];
  return a + Math.floor(Math.random() * (b - a + 1));
};

// из тела запроса → [{ name, optional }] или { error }
function parseArgsInput(raw) {
  if (raw == null) return { args: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ARGS) return { error: `Аргументов может быть не больше ${MAX_ARGS}` };
  const seen = new Set();
  const args = [];
  for (const a of raw) {
    const name = String(a?.name ?? '').trim().toLowerCase();
    if (!ARG_NAME_RE.test(name)) return { error: 'Название аргумента: 1–15 символов, буквы, цифры и _' };
    if (RESERVED.has(name) || /^arg\d+$/.test(name)) return { error: `Название «${name}» занято под переменную` };
    if (seen.has(name)) return { error: `Аргумент «${name}» повторяется` };
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
function evalToken(body, vars) {
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
    case 'coin': return param === null ? (Math.random() < 0.5 ? 'орёл' : 'решка') : null;
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
    default: return null;
  }
}

// самые внутренние {…} считаются первыми, поэтому {random:{число}} работает
function renderTemplate(template, vars) {
  let out = String(template ?? '');
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    out = out.replace(/\{([^{}]*)\}/g, (m, body) => {
      changed = true;
      const r = evalToken(body, vars);
      return r === null ? '\u0001' + body + '\u0002' : String(r);
    });
    if (!changed) break;
  }
  return out.replace(/\u0001/g, '{').replace(/\u0002/g, '}').slice(0, 500);
}

// cmd: { name, args, response }, argv: слова после команды, ctx: { user, streamer, title, viewers, uptime, count }
function buildReply(cmd, argv, ctx) {
  const declared = Array.isArray(cmd.args) ? cmd.args : [];
  let needed = 0;
  declared.forEach((a, i) => { if (!a.optional) needed = i + 1; });
  if (argv.length < needed) return { text: `Использование: ${usageOf(cmd)}`, usage: true };

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
  declared.forEach((a, i) => { vars[a.name] = argv[i] ?? ''; });

  return { text: renderTemplate(cmd.response, vars), usage: false };
}

module.exports = { parseArgsInput, parseCommandLine, buildReply, usageOf, MAX_ARGS };