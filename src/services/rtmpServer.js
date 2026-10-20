// rtmpServer.js

const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const StreamSession = require('../models/StreamSession');
const Follow = require('../models/Follow');
const chatBus = require('./chatBus');
const alerts = require('./alerts');
const StreamVod = require('../models/StreamVod');
const streamKeyCache = require('./streamKeyCache');
const searchIndex = require('./searchIndex');
const { isAdultStream } = require('./adultContent');
const os = require('os');

const MEDIA_ROOT = path.join(process.cwd(), 'media');
// ключ стрима — ровно 40 символов 0-9a-f (crypto.randomBytes(20).toString('hex') в workbench.routes.js)
const STREAM_KEY_RE = /^[a-f0-9]{40}$/;
const VOD_ROOT = path.join(MEDIA_ROOT, 'vod');
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const FFPROBE_PATH = '/usr/bin/ffprobe';
const GRACE_AT_MS = [5_000, 7_000, 12_000, 20_000];
const VOD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MERGE_WINDOW_MS = 60_000; // вернулся за минуту → та же запись

// качества эфира: «источник» без перекодирования + 720p и 360p — только те, что ниже источника
// (перекодировать 720 из 720 или растягивать 480 до 720 — зря жечь процессор).
// 720p — superfast: самое тяжёлое кодирование, ~на четверть дешевле veryfast при чуть худшей картинке
const SOURCE = { name: 'source', copy: true };
const LADDER = [
  { name: '720', height: 720, preset: 'superfast', vBitrate: '2500k', vMaxrate: '2800k', vBufsize: '5000k' },
  { name: '360', height: 360, preset: 'veryfast', vBitrate: '800k', vMaxrate: '900k', vBufsize: '1600k' },
];
// сервер уже загружен (другой эфир с полной лесенкой, захват) → вместо двух кодирований одно: 480p.
// HD остаётся в «источнике». Решается один раз на старте ffmpeg: посреди эфира качества не меняются (это обрыв у зрителей)
const LITE = { name: '480', height: 480, preset: 'veryfast', vBitrate: '1200k', vMaxrate: '1400k', vBufsize: '2400k' };
// «Источник» не выше 1080p: до 1080 — копия без нагрузки, эфир 1440p/4K перекодируется в 1080p (тяжело, но редко;
// к нему тогда только 480p — три кодирования с 4K сервер не потянет)
const SOURCE_MAX_H = 1080;
const SOURCE_1080 = { name: 'source', height: 1080, preset: 'superfast', vBitrate: '6000k', vMaxrate: '6500k', vBufsize: '12000k' };
const LITE_CPU_PCT = Math.min(100, Math.max(0, parseInt(process.env.LIVE_LITE_CPU, 10) || 70));
// каждый эфир с лесенкой — это два кодирования x264. Больше стольких эфиров одновременно — дальше только «источник»,
// чтобы несколько стримеров разом не положили сервер
const MAX_LADDER_STREAMS = Math.max(0, parseInt(process.env.LIVE_MAX_TRANSCODES, 10) || 2);

fs.mkdirSync(path.join(MEDIA_ROOT, 'live'), { recursive: true });
fs.mkdirSync(VOD_ROOT, { recursive: true });

const nmsConfig = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  // http у node-media-server не нужен (HLS раздаёт сайт): он открывал порт 8888 с веб-админкой /admin
  // и раздачей эфира FLV по ключу в обход сайта
};

const nms = new NodeMediaServer(nmsConfig);

/** @type {Map<string, { proc: import('child_process').ChildProcess, gen: number, vodId: string|null }>} */
const activeTranscodes = new Map();
const sessionMeta = new Map(); // key -> { vodId, abs }
const keyGen = new Map();
const pendingStopTimers = new Map();
const pendingVods = new Map(); // key -> { vodId, abs, parts, timer }

function nextGen(key) {
  const g = (keyGen.get(key) || 0) + 1;
  keyGen.set(key, g);
  return g;
}
function currentGen(key) {
  return keyGen.get(key) || 0;
}
function keyFromStreamPath(streamPath) {
  if (!streamPath || typeof streamPath !== 'string') return null;
  const parts = streamPath.replace(/^\//, '').split('/');
  if (parts.length !== 2 || parts[0] !== 'live') return null;
  // только настоящий формат ключа: иначе имя вроде «..» позволяло бы стереть папку media
  return STREAM_KEY_RE.test(parts[1]) ? parts[1] : null;
}
function mediaDir(key) {
  if (!STREAM_KEY_RE.test(String(key))) throw new Error('bad stream key'); // страховка от выхода из media/live
  return path.join(MEDIA_ROOT, 'live', key);
}
function wipeLiveMedia(key) {
  try {
    fs.rmSync(mediaDir(key), { recursive: true, force: true });
  } catch (_) {}
}

async function setLiveState(key, { isLive, touchStartedAt }) {
  let entry = streamKeyCache.get(key);
  if (!entry) {
    console.warn('[rtmp] ключ не в кэше:', key.slice(0, 8));
    if (!isLive) {
      return null;
    }
    return null;
  }
  try {
    if (!isLive) {
      // прежнее состояние нужно, чтобы записать эфир: «Активные стримеры» (часы за 30 дней) и статистика студии
      const prev = await User.findOneAndUpdate(
        { _id: entry.userId },
        { $set: { isLive: false, liveStartedAt: null } },
        { new: false }
      ).select('liveStartedAt streamCategoryId streamTitle streamAdult').lean();
      console.log(`[rtmp] isLive=false, startedAt=clear, key=${key.slice(0, 8)}…`);
      const startedAt = prev?.liveStartedAt ? new Date(prev.liveStartedAt) : null;
      const sec = startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : 0;
      const vs = viewerStats.get(key);
      viewerStats.delete(key);
      const chat = chatBus.chatStatsTake(entry.streamerNameLower);
      alerts.resetStream(entry.streamerNameLower); // эфир закончился — рубежи зрителей в следующем эфире заново
      require('./widgets').liveChanged(entry.streamerNameLower).catch(() => {}); // виджеты OBS: время эфира
      const adult = isAdultStream(prev);
      if (startedAt) { // повторная остановка (эфира уже нет) — не считаем
        // счётчик эфиров для поисковиков (services/searchIndex), потом — «эфир закончился» им же
        searchIndex.onStreamEnd(entry.userId, sec, adult)
          .then(() => searchIndex.notifyLater(entry.userId, 'end'))
          .catch((e) => console.warn('[rtmp] searchIndex', e.message));
      }
      if (sec >= 30) {
        Follow.countDocuments({ streamerId: entry.userId, createdAt: { $gte: startedAt } })
          .catch(() => 0)
          .then((newFollowers) => StreamSession.create({
            streamerId: entry.userId, startedAt, endedAt: new Date(), sec,
            categoryId: prev.streamCategoryId || null,
            title: prev.streamTitle || '',
            adult,
            peakViewers: vs?.peak || 0,
            avgViewers: vs?.n ? Math.round((vs.sum / vs.n) * 10) / 10 : 0,
            newFollowers,
            chatMessages: chat.chatMessages,
            chatters: chat.chatters,
          }))
          .catch((e) => console.warn('[rtmp] StreamSession', e.message));
      }
      return entry;
    }

    if (touchStartedAt) {
      if (entry.streamerNameLower) chatBus.chatStatsStart(entry.streamerNameLower); // переподключение счётчик не сбрасывает
      const r = await User.updateOne(
        { _id: entry.userId },
        [
          {
            $set: {
              isLive: true,
              liveStartedAt: { $ifNull: ['$liveStartedAt', new Date()] },
            },
          },
        ]
      );
      console.log(`[rtmp] isLive=true, startedAt=keep-or-set, key=${key.slice(0, 8)}… mod=${r.modifiedCount}`);
      if (r.modifiedCount) searchIndex.notifyLater(entry.userId, 'start'); // новый эфир — поисковикам (если канал в поиске)
      if (entry.streamerNameLower) require('./widgets').liveChanged(entry.streamerNameLower).catch(() => {});
    } else {
      const r = await User.updateOne(
        { _id: entry.userId },
        { $set: { isLive: true } }
      );
      console.log(`[rtmp] isLive=true, startedAt=keep, key=${key.slice(0, 8)}… mod=${r.modifiedCount}`);
    }
    return entry;
  } catch (err) {
    console.error('[rtmp] setLiveState', err.message);
    return entry;
  }
}

function killProc(proc, signal = 'SIGTERM') {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill(signal);
  } catch (_) {}
}

function clearPendingStop(key) {
  const t = pendingStopTimers.get(key);
  if (t) {
    clearTimeout(t);
    pendingStopTimers.delete(key);
  }
}

async function finalizeVod(vodId, status = 'ready', extra = {}) {
  if (!vodId) return;
  try {
    await StreamVod.updateOne(
      { _id: vodId, status: { $in: ['recording', 'processing'] } },
      { $set: { status, ...extra } }
    );
  } catch (e) {
    console.warn('[rtmp] finalizeVod', e.message);
  }
}

function probeDurationSec(absPath) {
  return new Promise((resolve) => {
    const proc = spawn(
      FFPROBE_PATH,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        absPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('exit', () => {
      const n = parseFloat(out);
      resolve(Number.isFinite(n) ? Math.round(n) : 0);
    });
  });
}

// высота и частота кадров входящего эфира — чтобы не кодировать качества выше источника и не гнать 60 к/с в 720/360.
// null — не узнали (тогда полная лесенка, масштаб всё равно не выше источника)
function probeSource(key) {
  return new Promise((resolve) => {
    const proc = spawn(
      FFPROBE_PATH,
      [
        '-v', 'error',
        '-probesize', '2000000', '-analyzeduration', '2000000',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=height,avg_frame_rate,r_frame_rate',
        '-of', 'json',
        `rtmp://127.0.0.1:1935/live/${key}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    const timer = setTimeout(() => killProc(proc, 'SIGKILL'), 6000);
    proc.stdout.on('data', (c) => { if (out.length < 20000) out += c; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        const st = JSON.parse(out).streams?.[0];
        const rate = (v) => { const [a, b] = String(v || '').split('/').map(Number); return a > 0 && b > 0 ? a / b : 0; };
        resolve(st && st.height ? { height: Number(st.height), fps: rate(st.avg_frame_rate) || rate(st.r_frame_rate) } : null);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

// ---------- загрузка сервера для выбора качеств ----------
// Считаем всё, кроме процессов с nice: сжатие записей и кадры (nice 19) уступают любому делу и могут часами
// держать «100%» — новый эфир из-за них зря ушёл бы в 480p. Живые ffmpeg тоже с nice (ниже сайта), но это
// настоящая нагрузка — их время добавляем по /proc/<pid>/stat
const LOAD_SAMPLE_MS = 10 * 1000;
const loadSamples = []; // последние 3 замера (~30 с), %
let prevLoad = null;

// процессорное время процесса, мс (utime + stime; такт ядра — 10 мс). Не Linux или процесса уже нет — null
function procCpuMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(f[11]) + Number(f[12])) * 10;
  } catch (_) {
    return null;
  }
}

function sampleLoad() {
  let busy = 0;
  let total = 0;
  for (const { times: t } of os.cpus()) {
    busy += t.user + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const procs = new Map();
  for (const t of activeTranscodes.values()) {
    const ms = t.proc.pid && procCpuMs(t.proc.pid);
    if (ms != null) procs.set(t.proc.pid, ms);
  }
  if (prevLoad && total > prevLoad.total) {
    let live = 0;
    for (const [pid, ms] of procs) if (prevLoad.procs.has(pid)) live += Math.max(0, ms - prevLoad.procs.get(pid));
    loadSamples.push(Math.min(100, ((busy - prevLoad.busy + live) / (total - prevLoad.total)) * 100));
    if (loadSamples.length > 3) loadSamples.shift();
  }
  prevLoad = { busy, total, procs };
}
setInterval(sampleLoad, LOAD_SAMPLE_MS).unref();

function recentLoad() {
  return loadSamples.length ? loadSamples.reduce((a, b) => a + b, 0) / loadSamples.length : null;
}

function renditionsFor(key, src) {
  const h = src?.height || 0;
  const fps = src && src.fps > 31 ? 30 : null; // 60 к/с — только в «источнике»
  const big = h > SOURCE_MAX_H + 20;
  if (big) console.log(`[rtmp] ${key.slice(0, 8)}…: источник ${h}p выше ${SOURCE_MAX_H}p → «источник» перекодируется в ${SOURCE_MAX_H}p`);
  // 1440p/4K → 1080p; 60 к/с сохраняем, только если сервер не занят (иначе 30)
  const source = (calm) => (big ? { ...SOURCE_1080, fps: calm ? (src.fps > 61 ? 60 : null) : fps } : SOURCE);

  const busy = [...activeTranscodes.values()].filter((t) => t.ladder).length;
  if (busy >= MAX_LADDER_STREAMS) {
    console.log(`[rtmp] уже перекодируется ${busy} эфир(а) (лимит LIVE_MAX_TRANSCODES=${MAX_LADDER_STREAMS}) → только «источник»`);
    return [source(false)];
  }

  // один эфир с полной лесенкой — это уже ~60–70% процессора: второму полная не влезет, сколько бы ни показал замер
  const fullBusy = [...activeTranscodes.values()].some((t) => t.full);
  const load = recentLoad();
  const lite = fullBusy || (load != null && load >= LITE_CPU_PCT);
  if (lite) {
    console.log(`[rtmp] ${key.slice(0, 8)}…: ${fullBusy ? 'уже идёт эфир с полной лесенкой' : `сервер загружен на ${Math.round(load)}% (порог LIVE_LITE_CPU=${LITE_CPU_PCT})`} → «источник» + 480p`);
  }

  const levels = lite || big ? [LITE] : LADDER;
  return [source(!lite), ...levels.filter((r) => !h || r.height < h - 20).map((r) => ({ ...r, fps }))];
}

// ---------- раз в 30 с для каждого эфира: кадр для карточки и замер зрителей ----------
// Кадр берём из последнего готового сегмента самого лёгкого качества (декодируется один кадр — почти без нагрузки)
// и кладём рядом с плейлистами: /media/live/<playbackId>/thumb.jpg. После эфира папка удаляется вместе с ним
const LIVE_TICK_MS = 30 * 1000;
const viewerStats = new Map(); // key -> { peak, sum, n }
const thumbBusy = new Set();

async function grabThumb(key) {
  if (thumbBusy.has(key)) return;
  thumbBusy.add(key);
  try {
    const dir = mediaDir(key);
    const sub = ['360', '480', '720', 'source'].find((n) => fs.existsSync(path.join(dir, n, 'index.m3u8')));
    if (!sub) return;
    const list = fs.readFileSync(path.join(dir, sub, 'index.m3u8'), 'utf8').split(/\r?\n/).filter((l) => /^seg_\d+\.ts$/.test(l.trim()));
    if (!list.length) return;
    // предпоследний сегмент: последний может ещё дописываться
    const seg = path.join(dir, sub, list[Math.max(0, list.length - 2)].trim());
    const tmp = path.join(dir, 'thumb.tmp.jpg');
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', seg, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '7', tmp]);
    fs.renameSync(tmp, path.join(dir, 'thumb.jpg'));
  } catch (e) {
    if (!/ENOENT/.test(e.message)) console.warn('[rtmp] thumb', key.slice(0, 8) + '…', e.message.slice(0, 200));
  } finally {
    thumbBusy.delete(key);
  }
}

function liveTick() {
  for (const key of activeTranscodes.keys()) {
    grabThumb(key);
    const entry = streamKeyCache.get(key);
    if (!entry?.streamerNameLower) continue;
    const v = chatBus.viewerCount(entry.streamerNameLower, entry.userId);
    const s = viewerStats.get(key) || { peak: 0, sum: 0, n: 0 };
    s.peak = Math.max(s.peak, v);
    alerts.viewers(entry.streamerNameLower, v); // рубеж зрителей → алерт (один раз за эфир)
    s.sum += v;
    s.n += 1;
    viewerStats.set(key, s);
  }
}
setInterval(liveTick, LIVE_TICK_MS).unref();

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('nice', ['-n', '19', FFMPEG_PATH, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    proc.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-4000); });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(errBuf.trim() || `ffmpeg exit ${code}`))));
  });
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch (_) {} };
const mb = (n) => (n / 1024 / 1024).toFixed(1);

// файл годится, только если он не пустой и у него видна длительность
async function isGoodMp4(p) {
  return fileSize(p) > 10 * 1024 && (await probeDurationSec(p)) > 0;
}

// сжатие (max 720p, 30 к/с, CRF 28) из любого входа; пустой результат считается ошибкой.
// Раньше medium на всех ядрах: час эфира 1080p60 держал сервер под 100% полчаса. veryfast ~в 3 раза быстрее
// (файл чуть больше — записи живут 3 дня), 30 к/с — вдвое меньше работы, половина ядер — остальным процессам запас.
// По одной записи за раз (очередь): два эфира, кончившиеся вместе, не сжимаются параллельно
const VOD_THREADS = Math.max(1, Math.floor(os.cpus().length / 2));
let vodChain = Promise.resolve();
function encodeVod(inputArgs, outPath) {
  const run = async () => {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-fflags', '+genpts',
      ...inputArgs,
      '-vf', "scale=-2:'min(720,ih)'",
      '-fpsmax', '30', // не выше 30 к/с, 25 остаются 25 (есть с ffmpeg 4.3)
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-threads', String(VOD_THREADS),
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      outPath,
    ]);
    if (!(await isGoodMp4(outPath))) {
      rmQuiet(outPath);
      throw new Error('ffmpeg вернул пустой файл');
    }
  };
  const p = vodChain.then(run, run);
  vodChain = p.catch(() => {});
  return p;
}

async function concatCopy(listPath, outPath) {
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  if (fileSize(outPath) === 0) {
    rmQuiet(outPath);
    throw new Error('склейка вернула пустой файл');
  }
}

async function processVodAfterStop(vodId, absPath, parts) {
  if (!vodId || !absPath) return;

  await finalizeVod(vodId, 'processing');

  const tmp = absPath + '.compressing.mp4';
  const listPath = absPath + '.list.txt';

  try {
    await new Promise((r) => setTimeout(r, 1500)); // ffmpeg-запись закрывает файл после SIGTERM
    const list = [...new Set(parts && parts.length ? parts : [absPath])].filter((p) => fileSize(p) > 0);
    if (!list.length) throw new Error('нет данных записи');

    const before = list.reduce((s, p) => s + fileSize(p), 0);
    let result = null; // путь готового файла

    // 1) склейка и сжатие за один проход
    try {
      if (list.length === 1) {
        await encodeVod(['-i', list[0]], tmp);
      } else {
        fs.writeFileSync(listPath, list.map((p) => `file '${p}'`).join('\n'));
        await encodeVod(['-f', 'concat', '-safe', '0', '-i', listPath], tmp);
      }
      result = tmp;
      console.log(`[rtmp] compress done ${path.basename(absPath)}: ${mb(before)} МБ → ${mb(fileSize(tmp))} МБ (кусков: ${list.length})`);
    } catch (e) {
      console.warn('[rtmp] сжатие не вышло:', e.message);
      rmQuiet(tmp);
    }

    // 2) запасной путь: склеить без пересжатия
    if (!result && list.length > 1) {
      try {
        fs.writeFileSync(listPath, list.map((p) => `file '${p}'`).join('\n'));
        await concatCopy(listPath, tmp);
        result = tmp;
        console.log('[rtmp] склеено без пересжатия', path.basename(absPath));
      } catch (e) {
        console.warn('[rtmp] склейка не вышла:', e.message);
        rmQuiet(tmp);
      }
    }

    // 3) совсем не вышло — оставляем самый большой кусок как есть, запись не пропадает
    if (!result) {
      result = list.reduce((a, b) => (fileSize(a) >= fileSize(b) ? a : b));
      console.warn('[rtmp] оставляю исходный кусок без сжатия:', path.basename(result));
    }

    if (result !== absPath) fs.renameSync(result, absPath);
    list.forEach((p) => { if (p !== absPath) rmQuiet(p); });

    const durationSec = await probeDurationSec(absPath);
    await finalizeVod(vodId, 'ready', durationSec ? { durationSec } : {});
  } catch (e) {
    console.error('[rtmp] compress failed', vodId, e.message);
    rmQuiet(tmp);
    await finalizeVod(vodId, 'failed');
  } finally {
    rmQuiet(listPath);
  }
}

/** Держим запись минуту: если стример вернётся, продолжим её, иначе сожмём */
function holdVodForMerge(key, { vodId, abs, parts }) {
  const prev = pendingVods.get(key);
  if (prev) clearTimeout(prev.timer);

  // 'processing', чтобы finalizeStuckRecordings не пометил запись готовой
  finalizeVod(vodId, 'processing');

  const timer = setTimeout(() => {
    pendingVods.delete(key);
    processVodAfterStop(vodId, abs, parts).catch((e) => {
      console.error('[rtmp] processVodAfterStop', e.message);
    });
  }, MERGE_WINDOW_MS);

  pendingVods.set(key, { vodId, abs, parts, timer });
  console.log('[rtmp] жду возврата стримера', MERGE_WINDOW_MS / 1000, 'с', key.slice(0, 8) + '…');
}

async function finalizeStop(key) {
  clearPendingStop(key);
  nextGen(key);

  let vodId = null;
  let absPath = null;
  let parts = [];

  const entry = activeTranscodes.get(key);
  if (entry) {
    vodId = entry.vodId;
    killProc(entry.proc, 'SIGTERM');
    setTimeout(() => killProc(entry.proc, 'SIGKILL'), 3000);
    activeTranscodes.delete(key);
    console.log('[rtmp] finalizeStop', key.slice(0, 8) + '…', 'vod=', vodId || '—');
  }

  const meta = sessionMeta.get(key);
  if (meta) {
    vodId = vodId || meta.vodId;
    absPath = meta.abs;
    parts = meta.parts || [meta.abs];
  }

  sessionMeta.delete(key);
  wipeLiveMedia(key);
  await setLiveState(key, { isLive: false, touchStartedAt: false });

  // не сжимаем сразу: ждём минуту, вдруг стример переподключится
  if (vodId && absPath) {
    holdVodForMerge(key, { vodId, abs: absPath, parts });
  } else if (vodId) {
    await finalizeVod(vodId, 'ready');
  }
}

function scheduleStop(key) {
  if (pendingStopTimers.has(key)) return;

  const t0 = Date.now();
  let step = 0;

  console.log(
    `[rtmp] grace steps [${GRACE_AT_MS.map((ms) => ms / 1000).join('→')}]s`,
    key.slice(0, 8) + '…'
  );

  function arm() {
    if (step >= GRACE_AT_MS.length) {
      pendingStopTimers.delete(key);
      console.log('[rtmp] grace exhausted → stop', key.slice(0, 8) + '…');
      finalizeStop(key);
      return;
    }

    const delay = Math.max(0, GRACE_AT_MS[step] - (Date.now() - t0));
    const timer = setTimeout(() => {
      if (!pendingStopTimers.has(key)) return;

      step += 1;
      if (step >= GRACE_AT_MS.length) {
        pendingStopTimers.delete(key);
        console.log('[rtmp] grace exhausted → stop', key.slice(0, 8) + '…');
        finalizeStop(key);
      } else {
        console.log(
          `[rtmp] grace checkpoint ${step}/${GRACE_AT_MS.length} (@${GRACE_AT_MS[step - 1] / 1000}s)`,
          key.slice(0, 8) + '…'
        );
        arm();
      }
    }, delay);

    pendingStopTimers.set(key, timer);
  }

  arm();
}

async function createVodDoc(key) {
  const entry = streamKeyCache.get(key);
  if (!entry) return null;
  const user = await User.findById(entry.userId)
    .select('streamerNameLower streamTitle streamDescription streamCategoryId')
    .lean();
  if (!user) return null;

  const mongoose = require('mongoose');
  const vodId = new mongoose.Types.ObjectId();
  const userDir = path.join(VOD_ROOT, String(entry.userId));
  fs.mkdirSync(userDir, { recursive: true });
  const fileRel = `vod/${entry.userId}/${vodId}.mp4`;
  const abs = path.join(MEDIA_ROOT, fileRel);

  await StreamVod.create({
    _id: vodId,
    userId: entry.userId,
    streamerNameLower: user.streamerNameLower,
    title: user.streamTitle || '', // без названия сайт сам покажет «Запись» на языке зрителя
    description: user.streamDescription || '',
    categoryId: user.streamCategoryId || null,
    fileRel,
    published: false,
    status: 'recording',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + VOD_TTL_MS),
  });

  return { vodId: String(vodId), abs, fileRel };
}

/** Собирает аргументы ffmpeg под всю ABR-лестницу + master-плейлист + (опционально) VOD-запись. */
function buildFfmpegArgs(key, hlsRootDir, vodAbs, renditions) {
  const inputUrl = `rtmp://127.0.0.1:1935/live/${key}`;
  const transcodeRenditions = renditions.filter((r) => !r.copy);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-i', inputUrl,
  ];

  if (transcodeRenditions.length) {
    const splitOutputs = transcodeRenditions.map((_, i) => `[t${i}]`).join('');
    const filterParts = [`[0:v]split=${transcodeRenditions.length}${splitOutputs}`];
    transcodeRenditions.forEach((r, i) => {
      // не выше источника; bilinear заметно быстрее bicubic, на 720/360 разницы не видно
      const fps = r.fps ? `fps=${r.fps},` : '';
      filterParts.push(`[t${i}]${fps}scale=w=-2:h='min(${r.height},ih)':flags=bilinear[s${i}]`);
    });
    args.push('-filter_complex', filterParts.join('; '));
  }

  const varStreamMapParts = [];
  let vIdx = 0;
  let aIdx = 0;

  renditions.forEach((r) => {
    if (r.copy) {
      args.push('-map', '0:v', `-c:v:${vIdx}`, 'copy');
      args.push('-map', '0:a', `-c:a:${aIdx}`, 'copy');
    } else {
      const si = transcodeRenditions.indexOf(r);
      args.push(
        '-map', `[s${si}]`,
        `-c:v:${vIdx}`, 'libx264',
        `-preset:v:${vIdx}`, r.preset,
        `-tune:v:${vIdx}`, 'zerolatency',
        `-b:v:${vIdx}`, r.vBitrate,
        `-maxrate:v:${vIdx}`, r.vMaxrate,
        `-bufsize:v:${vIdx}`, r.vBufsize,
        `-force_key_frames:v:${vIdx}`, 'expr:gte(t,n_forced*1)'
      );
      // звук как в «источнике», без перекодирования: AAC из OBS и так лёгкий, а кодировать его на каждое качество — зря
      args.push('-map', '0:a', `-c:a:${aIdx}`, 'copy');
    }
    varStreamMapParts.push(`v:${vIdx},a:${aIdx},name:${r.name}`);
    vIdx += 1;
    aIdx += 1;
  });

  args.push(
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '4',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    // вышедшие из плейлиста сегменты ещё ~40 с лежат на диске: из них режутся клипы (services/clips.js)
    '-hls_delete_threshold', '40',
    // номера сегментов от времени: после перезапуска ffmpeg имена не повторяются, поэтому сегменты можно кэшировать
    '-hls_start_number_source', 'epoch',
    '-hls_allow_cache', '0',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamMapParts.join(' '),
    '-hls_segment_filename', path.join(hlsRootDir, '%v', 'seg_%d.ts'),
    path.join(hlsRootDir, '%v', 'index.m3u8')
  );

  if (vodAbs) {
    args.push(
      '-map', '0:v',
      '-map', '0:a',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      vodAbs
    );
  }

  return args;
}

function spawnFfmpeg(key, gen, hlsRootDir, vodAbs, vodId, renditions) {
  // папки под каждый уровень качества — ffmpeg их сам не создаёт
  renditions.forEach((r) => {
    fs.mkdirSync(path.join(hlsRootDir, r.name), { recursive: true });
  });

  const args = buildFfmpegArgs(key, hlsRootDir, vodAbs, renditions);

  console.log('[rtmp] ffmpeg start', key.slice(0, 8) + '…', 'gen=', gen, 'vod=', vodId || '—', 'качества:', renditions.map((r) => r.name + (r.fps ? '@' + r.fps : '')).join(','));
  // приоритет ниже сайта: при перегрузе первым притормозит перекодирование, а не чат, сокеты и страницы.
  // nice заменяет себя ffmpeg (тот же pid), так что сигналы остановки доходят до ffmpeg напрямую
  const proc = spawn('nice', ['-n', '5', FFMPEG_PATH, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  activeTranscodes.set(key, {
    proc, gen, vodId: vodId || null,
    ladder: renditions.some((r) => !r.copy), // хоть одно перекодирование
    // тяжёлый эфир: 720/360 или «источник» 1440p/4K → 1080p — следующему достанется только облегчённая лесенка
    full: renditions.some((r) => LADDER.some((l) => l.name === r.name) || (r.name === 'source' && !r.copy)),
  });

  proc.stderr.on('data', (c) => {
    const line = c.toString().trim();
    if (line) console.log(`[ffmpeg:${key.slice(0, 8)}]`, line);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[rtmp] ffmpeg exit ${key.slice(0, 8)}… code=${code} signal=${signal} gen=${gen}`);
    const cur = activeTranscodes.get(key);
    if (cur && cur.gen === gen) {
      activeTranscodes.delete(key);
      if (!pendingStopTimers.has(key)) {
        scheduleStop(key);
      }
    }
  });
}

async function startTranscode(key) {
  // ffmpeg и запись на диск только для существующего ключа
  if (!STREAM_KEY_RE.test(String(key)) || !streamKeyCache.get(key)) {
    console.warn('[rtmp] startTranscode: неизвестный ключ, игнорирую');
    return;
  }
  const hadPendingStop = pendingStopTimers.has(key);
  clearPendingStop(key);

  const prev = activeTranscodes.get(key);
  if (prev) {
    // RTMP переподключился, а старый ffmpeg ещё жив — перезапускаем
    console.log('[rtmp] ffmpeg уже есть → restart', key.slice(0, 8) + '…');
    killProc(prev.proc, 'SIGTERM');
    setTimeout(() => killProc(prev.proc, 'SIGKILL'), 2000);
    activeTranscodes.delete(key);
    // дальше обычный старт нового ffmpeg (не return)
  }

  const gen = nextGen(key);
  const hlsRootDir = mediaDir(key);

  // вернулись в течение минуты после конца прошлого эфира → продолжаем ту же запись
  let resumed = false;
  const pending = pendingVods.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingVods.delete(key);
    sessionMeta.set(key, { vodId: pending.vodId, abs: pending.abs, parts: pending.parts });
    finalizeVod(pending.vodId, 'recording');
    resumed = true;
    console.log('[rtmp] стример вернулся, продолжаю запись', key.slice(0, 8) + '…', pending.vodId);
  }

  let meta = sessionMeta.get(key);
  const isNewSession = !meta;

  if (isNewSession) {
    wipeLiveMedia(key);
    fs.mkdirSync(hlsRootDir, { recursive: true });
    try {
      meta = await createVodDoc(key);
      if (meta) {
        meta.parts = [meta.abs];
        sessionMeta.set(key, meta);
      }
    } catch (e) {
      console.error('[rtmp] createVodDoc', e.message);
      meta = null;
    }
  } else {
    console.log('[rtmp] продолжаю сессию VOD', key.slice(0, 8) + '…', meta.vodId);
  }

  let vodAbs = null;
  if (isNewSession) {
    vodAbs = meta?.abs || null;
  } else if (meta) {
    // переподключение: пишем в новый кусок, склеим при остановке
    vodAbs = meta.abs.replace(/\.mp4$/, `.part${meta.parts.length + 1}.mp4`);
    meta.parts.push(vodAbs);
  }
  const vodId = meta?.vodId || null;

  setTimeout(async () => {
    if (currentGen(key) !== gen) return;
    if (pendingStopTimers.has(key)) return;
    if (activeTranscodes.has(key)) return;

    const src = await probeSource(key);
    // пока смотрели источник, эфир мог переподключиться или закончиться
    if (currentGen(key) !== gen || pendingStopTimers.has(key) || activeTranscodes.has(key)) return;
    if (src) console.log(`[rtmp] источник ${key.slice(0, 8)}…: ${src.height}p, ${Math.round(src.fps)} к/с`);
    else console.warn('[rtmp] не удалось узнать параметры источника — полная лесенка', key.slice(0, 8) + '…');

    spawnFfmpeg(key, gen, hlsRootDir, vodAbs, vodId, renditionsFor(key, src));

    await setLiveState(key, {
      isLive: true,
      touchStartedAt: (isNewSession || resumed) && !hadPendingStop,
    });
  }, 300);
}

function rejectSession(session) {
  try {
    if (typeof session?.reject === 'function') return session.reject();
    if (typeof session?.stop === 'function') return session.stop();
  } catch (e) {
    console.warn('[rtmp] reject:', e.message);
  }
}

// кто угодно может подключиться по RTMP с любым ключом, поэтому проверяем его ДО запуска ffmpeg
nms.on('prePublish', (session) => {
  const key = keyFromStreamPath(session?.streamPath || '');
  if (!key || !streamKeyCache.get(key)) {
    console.warn('[rtmp] отклонён неизвестный ключ:', String(session?.streamPath || '').slice(0, 60));
    rejectSession(session);
  }
});

nms.on('postPublish', (session) => {
  const key = keyFromStreamPath(session?.streamPath || '');
  console.log('[rtmp] postPublish', String(session?.streamPath || '').slice(0, 60));
  if (!key || !streamKeyCache.get(key)) {
    rejectSession(session);
    return;
  }
  startTranscode(key);
});

nms.on('donePublish', (session) => {
  const key = keyFromStreamPath(session?.streamPath || '');
  console.log('[rtmp] donePublish', session?.streamPath);
  if (key) scheduleStop(key);
});

module.exports = nms; 