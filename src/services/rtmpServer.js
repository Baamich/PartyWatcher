// rtmpServer.js

const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const StreamVod = require('../models/StreamVod');
const streamKeyCache = require('./streamKeyCache');

const MEDIA_ROOT = path.join(process.cwd(), 'media');
// ключ стрима — ровно 40 символов 0-9a-f (crypto.randomBytes(20).toString('hex') в workbench.routes.js)
const STREAM_KEY_RE = /^[a-f0-9]{40}$/;
const VOD_ROOT = path.join(MEDIA_ROOT, 'vod');
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const FFPROBE_PATH = '/usr/bin/ffprobe';
const GRACE_AT_MS = [5_000, 7_000, 12_000, 20_000];
const VOD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MERGE_WINDOW_MS = 60_000; // вернулся за минуту → та же запись

const RENDITIONS = [
  { name: 'source', copy: true },
  { name: '720', height: 720, vBitrate: '2500k', vMaxrate: '2800k', vBufsize: '5000k', aBitrate: '128k' },
  { name: '480', height: 480, vBitrate: '1400k', vMaxrate: '1500k', vBufsize: '2800k', aBitrate: '96k' },
];

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
  http: {
    port: 8888,
    mediaroot: MEDIA_ROOT,
    allow_origin: '*',
  },
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
      const r = await User.updateOne(
        { _id: entry.userId },
        { $set: { isLive: false, liveStartedAt: null } }
      );
      console.log(`[rtmp] isLive=false, startedAt=clear, key=${key.slice(0, 8)}… mod=${r.modifiedCount}`);
      return entry;
    }

    if (touchStartedAt) {
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

// сжатие (max 720p, CRF 28) из любого входа; пустой результат считается ошибкой
async function encodeVod(inputArgs, outPath) {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-fflags', '+genpts',
    ...inputArgs,
    '-vf', "scale=-2:'min(720,ih)'",
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '28',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ]);
  if (!(await isGoodMp4(outPath))) {
    rmQuiet(outPath);
    throw new Error('ffmpeg вернул пустой файл');
  }
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
    .select('streamerNameLower streamTitle streamDescription')
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
    title: user.streamTitle || 'Запись эфира',
    description: user.streamDescription || '',
    fileRel,
    published: false,
    status: 'recording',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + VOD_TTL_MS),
  });

  return { vodId: String(vodId), abs, fileRel };
}

/** Собирает аргументы ffmpeg под всю ABR-лестницу + master-плейлист + (опционально) VOD-запись. */
function buildFfmpegArgs(key, hlsRootDir, vodAbs) {
  const inputUrl = `rtmp://127.0.0.1:1935/live/${key}`;
  const transcodeRenditions = RENDITIONS.filter((r) => !r.copy);

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
      filterParts.push(`[t${i}]scale=-2:${r.height}[s${i}]`);
    });
    args.push('-filter_complex', filterParts.join('; '));
  }

  const varStreamMapParts = [];
  let vIdx = 0;
  let aIdx = 0;

  RENDITIONS.forEach((r) => {
    if (r.copy) {
      args.push('-map', '0:v', `-c:v:${vIdx}`, 'copy');
      args.push('-map', '0:a', `-c:a:${aIdx}`, 'copy');
    } else {
      const si = transcodeRenditions.indexOf(r);
      args.push(
        '-map', `[s${si}]`,
        `-c:v:${vIdx}`, 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        `-b:v:${vIdx}`, r.vBitrate,
        `-maxrate:v:${vIdx}`, r.vMaxrate,
        `-bufsize:v:${vIdx}`, r.vBufsize,
        `-force_key_frames:v:${vIdx}`, 'expr:gte(t,n_forced*1)'
      );
      args.push('-map', '0:a', `-c:a:${aIdx}`, 'aac', `-b:a:${aIdx}`, r.aBitrate);
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

function spawnFfmpeg(key, gen, hlsRootDir, vodAbs, vodId) {
  // папки под каждый уровень качества — ffmpeg их сам не создаёт
  RENDITIONS.forEach((r) => {
    fs.mkdirSync(path.join(hlsRootDir, r.name), { recursive: true });
  });

  const args = buildFfmpegArgs(key, hlsRootDir, vodAbs);

  console.log('[rtmp] ffmpeg start', key.slice(0, 8) + '…', 'gen=', gen, 'vod=', vodId || '—');
  const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  activeTranscodes.set(key, { proc, gen, vodId: vodId || null });

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

    spawnFfmpeg(key, gen, hlsRootDir, vodAbs, vodId);

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