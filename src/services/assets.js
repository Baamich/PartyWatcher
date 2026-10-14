// Свои .js/.css: один раз минифицируем (esbuild) и сжимаем (brotli + gzip), держим в памяти и отдаём готовыми.
// Сервер далеко (Мумбаи, через туннель), поэтому важен каждый килобайт: room.js 140 КБ → ~20 КБ brotli
// (Cloudflare сжимал исходник gzip — ~39 КБ). Минифицируется только отдаваемая копия: файлы в репозитории
// те же, хэш для ?v= считается по исходнику (pages.js), кэш пересобирается при правке файла (size + mtime).
// Без esbuild (не установился) — отдаём исходник, но тоже сжатый. Ошибка минификации файла — исходник и лог.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const crypto = require('crypto');

let esbuild = null;
try { esbuild = require('esbuild'); } catch (e) { console.warn('[assets] esbuild не установлен — js/css отдаются без минификации:', e.message); }

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BYTES = 60 * 1024 * 1024; // все варианты всех файлов (сейчас ~2 МБ)
const cache = new Map(); // abs → { key, promise | entry }
let cacheBytes = 0;

async function build(abs, ext) {
  const src = await fs.promises.readFile(abs);
  let out = src;
  if (esbuild && !/\.min\.(js|css)$/.test(abs)) {
    try {
      const r = await esbuild.transform(src.toString('utf8'), {
        loader: ext === '.css' ? 'css' : 'js',
        minify: true, // верхние имена обычных скриптов esbuild не переименовывает: data-click="fn" и window.fn живы
        legalComments: 'none',
        charset: 'utf8', // кириллица в строках как есть, без \u-экранирования
      });
      out = Buffer.from(r.code, 'utf8');
    } catch (e) {
      console.warn('[assets] не минифицирован', path.basename(abs) + ':', String(e.message).split('\n')[0]);
    }
  }
  const [br, gz] = await Promise.all([
    brotli(out, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: out.length } }),
    gzip(out, { level: 9 }),
  ]);
  const etag = '"' + crypto.createHash('sha1').update(out).digest('base64').slice(0, 22) + '"';
  return { raw: out, br, gz, etag, bytes: out.length + br.length + gz.length };
}

function entryOf(abs, st, ext) {
  const key = st.size + ':' + st.mtimeMs;
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit.promise;
  if (hit && hit.entry) cacheBytes -= hit.entry.bytes;
  const slot = { key, entry: null, promise: null };
  slot.promise = build(abs, ext).then((entry) => {
    slot.entry = entry;
    cacheBytes += entry.bytes;
    if (cacheBytes > MAX_BYTES) { // переполнение — начинаем заново (случиться не должно: файлов мало)
      cache.clear();
      cacheBytes = 0;
    }
    return entry;
  });
  slot.promise.catch(() => cache.delete(abs));
  cache.set(abs, slot);
  return slot.promise;
}

// resolve(urlPath) → абсолютный путь файла или null; headers(res, abs, st) — Cache-Control (как у express.static)
function middleware(resolve, headers) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = path.extname(req.path).toLowerCase();
    if (!TYPES[ext]) return next();
    const abs = resolve(req.path);
    if (!abs) return next();
    let st;
    try { st = fs.statSync(abs); } catch { return next(); }
    if (!st.isFile()) return next();

    entryOf(abs, st, ext).then((e) => {
      res.setHeader('Content-Type', TYPES[ext]);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('ETag', e.etag);
      headers(res, abs, st);
      if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
      const ae = String(req.headers['accept-encoding'] || '');
      const [body, enc] = /\bbr\b/.test(ae) ? [e.br, 'br'] : /\bgzip\b/.test(ae) ? [e.gz, 'gzip'] : [e.raw, null];
      if (enc) res.setHeader('Content-Encoding', enc);
      res.setHeader('Content-Length', body.length);
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    }).catch(next);
  };
}

// прогрев после запуска: все свои js/css собираются по очереди в фоне, первый посетитель не ждёт ~150 мс на файл
function warm(dirs) {
  const files = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const f of list) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (TYPES[path.extname(f.name).toLowerCase()]) files.push(p);
    }
  };
  for (const d of dirs) {
    try { if (fs.statSync(d).isFile()) files.push(d); else walk(d); } catch (_) {}
  }
  setTimeout(async () => {
    const t = Date.now();
    for (const f of files) {
      try { await entryOf(f, fs.statSync(f), path.extname(f).toLowerCase()); } catch (_) {}
    }
    console.log(`[assets] готово ${files.length} файлов за ${Date.now() - t} мс, в памяти ${Math.round(cacheBytes / 1024)} КБ`);
  }, 3000).unref();
}

module.exports = { middleware, warm };
