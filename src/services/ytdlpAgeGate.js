// ytdlpAgeGate.js
// Скачивает видео YouTube (в том числе с возрастным ограничением) на сервер через yt-dlp
// и отдаёт ссылку на копию. Качает в фоне, по одному видео за раз.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/home/ubuntu/PartyWatcher/yt-cookies.txt';
const CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';
const MAX_HEIGHT = parseInt(process.env.YT_MAX_HEIGHT, 10) || 720; // 720p качается заметно быстрее 1080p
// 'default' = без player_client, пусть yt-dlp сам выберет клиент (у него свежие настройки)
const CLIENTS = (process.env.YT_CLIENTS || 'tv,web_safari,mweb,default')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const JS_RUNTIMES = process.env.YT_JS_RUNTIMES || ''; // например deno:/home/ubuntu/.deno/bin/deno
const PROXY = process.env.YT_PROXY || '';             // например http://user:pass@host:port
const ATTEMPT_TIMEOUT_MS = 6 * 60 * 1000;             // на одну попытку одним клиентом
const MAX_QUEUE = 3;                                  // сколько загрузок максимум в очереди и в работе
const JOB_KEEP_MS = 10 * 60 * 1000;                   // сколько помнить результат задачи

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// id видео -> { id, status: queued|running|done|error, progress, url, error, promise, hooks }
const jobs = new Map();
let queueTail = Promise.resolve();
let queued = 0;

// ---------- адреса ----------

// Достаём настоящий id (11 символов). В yt-dlp уходит только адрес, который собрали мы,
// а не строка пользователя: иначе её можно было бы подменить опцией вроде --exec.
function extractYoutubeId(url) {
  const s = String(url || '').trim();
  if (!/youtube\.com|youtu\.be/i.test(s)) return null;
  const m = s.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function cachePath(id) {
  return path.join(CACHE_DIR, `${id}.mp4`);
}

function publicUrlFor(id) {
  return `/media/yt-cache/${id}.mp4`;
}

// ---------- кэш ----------

function touchFile(filePath) {
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch (e) {
    console.warn('[ytdlpAgeGate] не удалось обновить mtime кэша:', e.message);
  }
}

// ссылка на готовую копию (и продление ей жизни), либо null
function getCachedUrl(videoUrl) {
  const id = extractYoutubeId(videoUrl);
  if (!id) return null;
  const file = cachePath(id);
  if (!fs.existsSync(file)) return null;
  touchFile(file);
  return publicUrlFor(id);
}

// удаляем недокачанное: id.mp4 — готовый файл, всё остальное с этим id (.part, .f137.mp4 ...) — мусор
function cleanupPartials(id) {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith(id + '.') && f !== `${id}.mp4`) fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch (_) {}
}

// ---------- ошибки простым языком (в логи пишется полный текст) ----------

function friendlyError(raw) {
  const s = String(raw || '');
  if (/не запустился|ENOENT/i.test(s)) return 'На сервере не найден yt-dlp';
  if (/confirm your age|age-restricted|age verification|inappropriate for some users/i.test(s)) {
    return 'YouTube требует вход в аккаунт 18+: обнови файл cookies на сервере (yt-cookies.txt)';
  }
  if (/not a bot|Sign in to confirm/i.test(s)) {
    return 'YouTube блокирует сервер: нужны свежие cookies или другой IP';
  }
  if (/Video unavailable|private video|has been removed|not available in your country/i.test(s)) {
    return 'Видео недоступно (приватное, удалено или закрыто для региона сервера)';
  }
  if (/Requested format is not available|n challenge|nsig|JS runtime/i.test(s)) {
    return 'yt-dlp не смог расшифровать ссылки: обнови yt-dlp и проверь JS-runtime (deno)';
  }
  if (/403/i.test(s)) return 'YouTube отклонил загрузку (403): обнови yt-dlp и cookies';
  if (/таймаут/i.test(s)) return 'Загрузка зависла и была остановлена';
  return 'Не удалось скачать видео (подробности в логах сервера)';
}

// ---------- запуск yt-dlp ----------

function buildArgs(videoUrl, outFile, client) {
  const args = [
    '-f', `bestvideo[height<=${MAX_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${MAX_HEIGHT}][ext=mp4]/best[height<=${MAX_HEIGHT}]/best`,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline', // прогресс построчно, чтобы его можно было читать
    '--remote-components', 'ejs:github',
    '-o', outFile,
  ];
  if (client && client !== 'default') args.push('--extractor-args', `youtube:player_client=${client}`);
  if (JS_RUNTIMES) args.push('--js-runtimes', JS_RUNTIMES);
  if (PROXY) args.push('--proxy', PROXY);
  if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  args.push('--', videoUrl); // всё после «--» yt-dlp считает адресом, а не опциями
  return args;
}

function runYtDlp(videoUrl, outFile, client, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', buildArgs(videoUrl, outFile, client), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ATTEMPT_TIMEOUT_MS);

    child.stdout.on('data', (buf) => {
      const matches = String(buf).match(/(\d+(?:\.\d+)?)%/g);
      if (matches) onProgress(parseFloat(matches[matches.length - 1]));
    });
    child.stderr.on('data', (buf) => {
      errText = (errText + String(buf)).slice(-4000);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('yt-dlp не запустился: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (timedOut) return reject(new Error('yt-dlp завис, остановлен по таймауту'));
      const lines = errText.split('\n').map((l) => l.trim()).filter(Boolean);
      const errLine = [...lines].reverse().find((l) => /ERROR/i.test(l)) || lines.slice(-3).join(' ');
      reject(new Error(errLine || `yt-dlp завершился с кодом ${code}`));
    });
  });
}

// ---------- задачи ----------

function scheduleForget(id, job) {
  setTimeout(() => {
    if (jobs.get(id) === job) jobs.delete(id);
  }, JOB_KEEP_MS).unref();
}

async function runJob(job, id) {
  const outFile = cachePath(id);
  const videoUrl = `https://www.youtube.com/watch?v=${id}`; // собираем сами
  job.status = 'running';

  let lastErr = null;
  for (const client of CLIENTS) {
    try {
      job.progress = null;
      await runYtDlp(videoUrl, outFile, client, (p) => { job.progress = p; });
      if (fs.existsSync(outFile)) {
        console.log(`[ytdlpAgeGate] ${id}: успех через client=${client}`);
        cleanupPartials(id);
        job.status = 'done';
        job.url = publicUrlFor(id);
        scheduleForget(id, job);
        return job.url;
      }
      lastErr = new Error('yt-dlp завершился без файла');
    } catch (e) {
      lastErr = e;
      console.warn(`[ytdlpAgeGate] ${id}: client=${client} не сработал: ${String(e.message).slice(0, 300)}`);
    }
    cleanupPartials(id);
    try { fs.unlinkSync(outFile); } catch (_) {}
  }

  job.status = 'error';
  job.error = friendlyError(lastErr && lastErr.message);
  scheduleForget(id, job);
  throw lastErr || new Error(job.error);
}

// Запускает скачивание (или возвращает уже идущее). Ошибки с кодами: BAD_URL, QUEUE_FULL.
function ensureExtraction(videoUrl) {
  const id = extractYoutubeId(videoUrl);
  if (!id) {
    const e = new Error('Не удалось распознать ссылку YouTube');
    e.code = 'BAD_URL';
    throw e;
  }

  const existing = jobs.get(id);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return existing;
  if (existing && existing.status === 'done' && fs.existsSync(cachePath(id))) return existing;

  if (queued >= MAX_QUEUE) {
    const e = new Error('Сервер сейчас занят, попробуй через пару минут');
    e.code = 'QUEUE_FULL';
    throw e;
  }

  const job = { id, status: 'queued', progress: null, url: null, error: null, hooks: new Set() };
  jobs.set(id, job);
  queued++;
  job.promise = queueTail.then(() => runJob(job, id)).finally(() => { queued--; });
  queueTail = job.promise.catch(() => {}); // следующая задача ждёт эту, даже если она упала
  job.promise.catch(() => {});             // ошибка без обработчика не должна ронять процесс
  return job;
}

function publicJob(job) {
  return { status: job.status, progress: job.progress, url: job.url, error: job.error };
}

function getJobInfo(videoUrl) {
  const id = extractYoutubeId(videoUrl);
  const job = id ? jobs.get(id) : null;
  return job ? publicJob(job) : null;
}

module.exports = { extractYoutubeId, getCachedUrl, ensureExtraction, getJobInfo, publicJob };