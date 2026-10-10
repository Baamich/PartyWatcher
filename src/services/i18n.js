// Локализация: словари лежат в src/locales/<язык>/<раздел>.json, общие для сервера и браузера.
// Сервер: req.t('server.roomNotFound', { n: 3 }); браузер получает словари через GET /locales/<язык>.js?ns=common,index
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const LANGS = ['ru', 'en'];
const DEFAULT_LANG = 'ru';   // запасной словарь (если ключа нет в нужном языке) и язык логов
const DETECT_FALLBACK = 'en'; // язык гостя, если ни cookie, ни языки браузера/системы не подошли
const COOKIE = 'pw_lang';
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

// { ru: { common: { 'common.logout': 'Выйти', ... }, server: {...} }, en: {...} }
const dicts = {};
const flat = {}; // { ru: { 'server.x': ... } } — все разделы одним объектом (для req.t)

function isPluralLeaf(v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length > 0 && Object.keys(v).every((k) => PLURAL_FORMS.includes(k));
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + '.' + k;
    if (typeof v === 'string' || isPluralLeaf(v)) out[key] = v;
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

function load() {
  for (const lang of LANGS) {
    dicts[lang] = {};
    flat[lang] = {};
    const dir = path.join(LOCALES_DIR, lang);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) {}
    for (const file of files) {
      const ns = file.slice(0, -5);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        dicts[lang][ns] = flatten(data, ns, {});
        Object.assign(flat[lang], dicts[lang][ns]);
      } catch (e) {
        console.error(`[i18n] не читается ${lang}/${file}:`, e.message);
      }
    }
  }
}
load();

function normLang(v) {
  const s = String(v || '').toLowerCase().slice(0, 2);
  return LANGS.includes(s) ? s : null;
}

// язык системы/браузера → наш: русский для ru и соседних (их носители обычно читают по-русски), en для en
const RU_FAMILY = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'ka', 'tt', 'ba', 'cv', 'mn'];
function mapLang(tag) {
  const base = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
  if (RU_FAMILY.includes(base)) return 'ru';
  if (base === 'en') return 'en';
  return null;
}

// Accept-Language: "de-DE,de;q=0.9,ru;q=0.8" → по убыванию веса первый язык, который мы знаем
function langFromAccept(accept) {
  const items = String(accept || '').split(',').slice(0, 20).map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    const w = q ? Number(q.slice(2)) : 1;
    return { tag, w: Number.isFinite(w) ? w : 0, i };
  }).filter((x) => x.tag && x.w > 0);
  items.sort((a, b) => b.w - a.w || a.i - b.i);
  for (const it of items) {
    const l = mapLang(it.tag);
    if (l) return l;
  }
  return null;
}

// cookie pw_lang (ставит переключатель) → Accept-Language → английский
function langFromHeaders(headers) {
  const cookie = String(headers?.cookie || '');
  const m = cookie.match(/(?:^|;\s*)pw_lang=([a-z]{2})(?:;|$)/i);
  const fromCookie = m && normLang(m[1]);
  if (fromCookie) return fromCookie;
  return langFromAccept(headers?.['accept-language']) || DETECT_FALLBACK;
}

const pluralRules = {};
function pick(lang, value, vars) {
  if (typeof value === 'string') return value;
  const n = Number(vars?.n ?? vars?.count ?? 0);
  const pr = pluralRules[lang] || (pluralRules[lang] = new Intl.PluralRules(lang));
  return value[pr.select(n)] ?? value.other ?? value.many ?? '';
}

function t(lang, key, vars) {
  const l = normLang(lang) || DEFAULT_LANG;
  let value = flat[l][key];
  if (value === undefined) value = flat[DEFAULT_LANG][key];
  if (value === undefined) return key;
  const s = pick(l, value, vars);
  return vars ? s.replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined ? String(vars[name]) : all)) : s;
}

// Error с ключом словаря: message — по-русски (для логов), клиенту отдаём перевод через errText
function err(key, vars) {
  const e = new Error(t(DEFAULT_LANG, key, vars));
  e.i18nKey = key;
  e.vars = vars;
  return e;
}

// текст ошибки для ответа: ключ словаря → перевод, иначе e.message, иначе fallbackKey
function errText(req, e, fallbackKey) {
  if (e && e.i18nKey) return t(req.lang, e.i18nKey, e.vars);
  if (e && e.message) return e.message;
  return fallbackKey ? t(req.lang, fallbackKey) : '';
}

function middleware(req, res, next) {
  req.lang = langFromHeaders(req.headers);
  req.t = (key, vars) => t(req.lang, key, vars);
  next();
}

// GET /locales/:lang.js?ns=common,index — словари для браузера одним скриптом.
// no-store: Cloudflare заменяет no-cache у .js на max-age=14400 (4 ч) — и словарь, и даже 404 застревали
// в браузере на 4 часа (ключи вместо текста после деплоя). no-store он не трогает; словарь — несколько КБ.
// В памяти держим только существующие разделы (server браузеру не нужен), сочетаний — не больше 200
const bundleCache = new Map();
function bundle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const lang = normLang(req.params.lang);
  if (!lang) return res.status(404).end();
  const asked = String(req.query.ns || '').split(',').map((s) => s.trim());
  const names = ['common', ...[...new Set(asked)].filter((s) => s !== 'common' && s !== 'server' && dicts[lang][s]).sort()];

  const cacheKey = lang + ':' + names.join(',');
  let body = bundleCache.get(cacheKey);
  if (!body) {
    const data = {};
    for (const ns of names) Object.assign(data, dicts[lang][ns] || {});
    body = `window.PW_I18N_DATA=${JSON.stringify(data)};`;
    if (bundleCache.size >= 200) bundleCache.clear();
    bundleCache.set(cacheKey, body);
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(body);
}

module.exports = { LANGS, DEFAULT_LANG, COOKIE, t, err, errText, langFromHeaders, langFromAccept, middleware, bundle, LOCALES_DIR };
