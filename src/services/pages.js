// HTML-страницы сайта и кэширование статики.
// Сервер стоит далеко от зрителей (Мумбаи, через туннель Cloudflare): каждый запрос к нему — 0.5–1 с.
// Поэтому страница должна приходить готовой, а всё остальное — из кэша браузера/Cloudflare без похода к нам:
//  1) у <script>/<link> на свои .js/.css ?v= заменяется на хэш содержимого файла. Файл с совпавшим хэшем
//     отдаётся с кэшем на год (immutable): Cloudflare и браузер больше не спрашивают сервер. Ручные ?v=N
//     в HTML бампать не нужно (в JS — для import/динамической загрузки — по-прежнему нужно);
//  2) словарь страницы подключается прямо в HTML (раньше i18n.js дописывал его document.write — второй
//     последовательный запрос), data-i18n* переводятся здесь, язык — как у req.lang;
//  3) ответ /api/auth/me лежит в <script type="application/json" id="pw-boot"> — api.js берёт его вместо
//     запроса (не для упреждающей загрузки: к моменту перехода вход мог смениться).
// Шаблон страницы (всё, кроме pw-boot) собирается один раз на файл+язык и держится в памяти.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const i18n = require('./i18n');
const auth = require('../middleware/auth');
const { meOf } = require('./me');

const PUBLIC = path.join(__dirname, '..', 'public');
const DEV = config.env !== 'production';

// ---------- хэши файлов ----------
const hashes = new Map(); // абсолютный путь → { key, hash }
function hashFile(abs, stat) {
  let st = stat;
  if (!st) {
    try { st = fs.statSync(abs); } catch { return null; }
  }
  if (!st.isFile()) return null;
  const key = st.size + ':' + st.mtimeMs;
  const hit = hashes.get(abs);
  if (hit && hit.key === key) return hit.hash;
  let hash;
  try { hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 10); } catch { return null; }
  if (hashes.size > 2000) hashes.clear();
  hashes.set(abs, { key, hash });
  return hash;
}

// файлы не из public: /vendor/socket.io.min.js (клиент Socket.IO из npm)
const VENDOR = {};
try {
  const f = path.join(path.dirname(require.resolve('socket.io')), '..', 'client-dist', 'socket.io.min.js');
  if (fs.existsSync(f)) VENDOR['/vendor/socket.io.min.js'] = f;
} catch (_) {}

function absOf(urlPath) {
  if (VENDOR[urlPath]) return VENDOR[urlPath];
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  const abs = path.join(PUBLIC, p);
  return abs.startsWith(PUBLIC + path.sep) ? abs : null;
}

const YEAR = 'public, max-age=31536000, immutable';

// заголовки express.static: ?v= совпал с хэшем — на год; иначе js/css Cloudflare держит 5 мин (раньше
// max-age=0 — и он ходил к нам за каждым файлом), картинки и шрифты — сутки
const LONG_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp3|wav|ogg)$/i;
function staticHeaders(res, abs, stat) {
  if (/no-store/.test(String(res.getHeader('Cache-Control') || ''))) return; // админка: только у админа, без кэша
  const v = res.req && res.req.query && res.req.query.v;
  if (v && v === hashFile(abs, stat)) return res.setHeader('Cache-Control', YEAR);
  if (/\.html?$/i.test(abs)) return res.setHeader('Cache-Control', 'no-cache');
  if (LONG_EXT.test(abs)) return res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
}

function sendVendor(urlPath) {
  return (req, res) => {
    const abs = VENDOR[urlPath];
    const fresh = req.query.v && req.query.v === hashFile(abs);
    res.sendFile(abs, { maxAge: 0, headers: { 'Cache-Control': fresh ? YEAR : 'public, max-age=86400' } });
  };
}

// ---------- сборка шаблона ----------
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function versionAssets(html) {
  return html.replace(
    /(<(?:script|link)\b[^>]*?\s(?:src|href)=")(\/[^"?#]+\.(?:js|css))(?:\?v=[\w.-]*)?(")/g,
    (all, pre, url, post) => {
      if (url === '/socket.io/socket.io.js' && VENDOR['/vendor/socket.io.min.js']) url = '/vendor/socket.io.min.js';
      const abs = absOf(url);
      const h = abs && hashFile(abs);
      return h ? `${pre}${url}?v=${h}${post}` : all;
    },
  );
}

// перевод разметки — как translateEl в public/js/i18n.js (там же остаётся запасной перевод в браузере)
const ATTRS = [
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-alt', 'alt'],
  ['data-i18n-content', 'content'],
];
function translate(html, lang) {
  const tr = (key) => (i18n.has(lang, key) ? i18n.t(lang, key) : null);
  // текст: только «листья» без вложенных тегов
  html = html.replace(/<([a-zA-Z][\w-]*)(\s(?:[^>]*?\s)?data-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1\s*>/g, (all, tag, attrs, key) => {
    const v = tr(key);
    return v == null ? all : `<${tag}${attrs}>${escText(v)}</${tag}>`;
  });
  // разметка: если внутри нет такого же тега (иначе не найти правильный закрывающий)
  html = html.replace(/<([a-zA-Z][\w-]*)(\s(?:[^>]*?\s)?data-i18n-html="([^"]+)"[^>]*)>([\s\S]*?)<\/\1\s*>/g, (all, tag, attrs, key, inner) => {
    if (new RegExp('<' + tag + '[\\s>]', 'i').test(inner)) return all;
    const v = tr(key);
    return v == null ? all : `<${tag}${attrs}>${v}</${tag}>`;
  });
  // атрибуты
  html = html.replace(/<[a-zA-Z][\w-]*\s[^>]*\sdata-i18n-(?:placeholder|title|aria-label|alt|content)="[^"]*"[^>]*>/g, (tagStr) => {
    let out = tagStr;
    for (const [dattr, target] of ATTRS) {
      const m = out.match(new RegExp('\\s' + dattr + '="([^"]+)"'));
      const v = m && tr(m[1]);
      if (v == null) continue;
      const re = new RegExp('(\\s' + target + '=")[^"]*(")');
      if (re.test(out)) out = out.replace(re, (a, p1, p2) => p1 + escAttr(v) + p2);
      else out = out.replace(/\s*(\/?)>$/, (a, slash) => ` ${target}="${escAttr(v)}"${slash ? ' /' : ''}>`);
    }
    return out;
  });
  return html;
}

const BOOT = '<!--pw-boot-->';
function build(raw, lang) {
  let html = versionAssets(raw);
  html = html.replace(/<html\b([^>]*)>/i, (all, attrs) => `<html${attrs.replace(/\slang="[^"]*"/i, '')} lang="${lang}">`);
  // i18n.js: перед ним — данные входа и словарь (параллельно с остальными файлами, без document.write)
  html = html.replace(/<script\s+src="(\/js\/i18n\.js[^"]*)"([^>]*)><\/script>/, (all, src, attrs) => {
    const ns = (attrs.match(/\sdata-ns="([^"]*)"/) || [])[1] || '';
    return `${BOOT}<script src="${i18n.bundleUrl(lang, ns)}"></script>` +
      `<script src="${src}"${attrs} data-lang="${lang}" data-h="${i18n.VERSION}"></script>`;
  });
  return translate(html, lang);
}

// Link: preload для CSS и словаря. Cloudflare с включёнными Early Hints запоминает его и шлёт браузеру 103
// прямо с ближайшего узла, пока HTML ещё едет от нас, — стили и словарь начинают грузиться раньше
function preloadLinks(html) {
  const links = [];
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(\/[^"]+\?v=[0-9a-f]+)"/g)) links.push(`<${m[1]}>; rel=preload; as=style`);
  const dict = html.match(/<script src="(\/locales\/[^"]+)"><\/script>/);
  if (dict) links.push(`<${dict[1]}>; rel=preload; as=script`);
  return links.join(', ');
}

// хэши всех файлов, на которые ссылается страница: поменялся любой (правка без перезапуска) — шаблон пересобирается
function depsKey(deps) {
  return deps.map((d) => hashFile(d) || '').join(',');
}
const DEPS_CHECK_MS = 5000;

const templates = new Map(); // `${abs}|${lang}` → { key, html, link, deps, depsKey, checkedAt }
function template(abs, st, lang) {
  const id = abs + '|' + lang;
  const key = st.size + ':' + st.mtimeMs;
  const hit = templates.get(id);
  if (hit && hit.key === key && !DEV) {
    if (Date.now() - hit.checkedAt < DEPS_CHECK_MS) return hit;
    hit.checkedAt = Date.now();
    if (depsKey(hit.deps) === hit.depsKey) return hit;
  }
  const html = build(fs.readFileSync(abs, 'utf8'), lang);
  const deps = [...html.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css))\?v=/g)].map((m) => absOf(m[1])).filter(Boolean);
  const entry = { key, html, link: preloadLinks(html), deps, depsKey: depsKey(deps), checkedAt: Date.now() };
  templates.set(id, entry);
  return entry;
}

// ---------- данные входа ----------
const isPrefetch = (req) => /prefetch|prerender/i.test(String(req.headers['sec-purpose'] || req.headers.purpose || req.headers['x-moz'] || ''));

async function bootJson(req) {
  if (isPrefetch(req)) return null;
  const token = req.cookies && req.cookies.token;
  let me = null;
  let err = 'server.notAuthorized';
  if (token) {
    try {
      const payload = await auth.verifyToken(token);
      req.user = payload; // для статистики (analytics.js): чья это страница
      me = await meOf(payload.id);
      if (!me) err = 'server.userNotFound';
    } catch (_) {
      err = 'server.badToken';
    }
  }
  const data = me ? { me } : { me: null, error: req.t(err) };
  // </script> внутри JSON не должен закрыть тег
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ---------- отдача ----------
// opts.vars — подстановки {{ключ}} в готовую страницу (экранируются), opts.raw — уже готовый HTML (без экранирования)
async function send(req, res, rel, opts = {}) {
  const abs = typeof rel === 'string' && path.isAbsolute(rel) ? rel : path.join(PUBLIC, rel);
  let st;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isFile()) return res.status(404).end();

  const lang = req.lang || i18n.langFromHeaders(req.headers);
  const boot = await bootJson(req);
  const tpl = template(abs, st, lang);
  let html = tpl.html.replace(BOOT, boot ? `<script type="application/json" id="pw-boot">${boot}</script>` : '');
  if (opts.vars || opts.raw) {
    html = html.replace(/\{\{([\w.]+)\}\}/g, (all, k) => {
      if (opts.raw && Object.prototype.hasOwnProperty.call(opts.raw, k)) return String(opts.raw[k]);
      if (opts.vars && Object.prototype.hasOwnProperty.call(opts.vars, k)) return escText(opts.vars[k]);
      return all;
    });
  }

  const etag = 'W/"' + crypto.createHash('sha1').update(html).digest('base64').slice(0, 22) + '"';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!/no-store/.test(String(res.getHeader('Cache-Control') || ''))) res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Cookie, Accept-Language');
  res.setHeader('ETag', etag);
  if (tpl.link) res.setHeader('Link', tpl.link);
  // модель телефона и версия Windows (10/11) — браузер пришлёт со следующими запросами (статистика админки)
  res.setHeader('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.send(html);
}

// / и *.html из public; остальное — дальше (express.static)
function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path === '/' ? '/index.html' : req.path;
  if (!/\.html$/i.test(p)) return next();
  const abs = absOf(p);
  if (!abs) return next();
  let st;
  try { st = fs.statSync(abs); } catch { return next(); }
  if (!st.isFile()) return next();
  send(req, res, abs).catch(next);
}

module.exports = { middleware, send, staticHeaders, sendVendor, hashFile, PUBLIC };
