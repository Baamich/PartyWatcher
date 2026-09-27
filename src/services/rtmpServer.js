const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const StreamVod = require('../models/StreamVod');
const streamKeyCache = require('./streamKeyCache');

const MEDIA_ROOT = path.join(process.cwd(), 'media');
const VOD_ROOT = path.join(MEDIA_ROOT, 'vod');
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const GRACE_AT_MS = [5_000, 7_000, 12_000, 20_000];
const VOD_TTL_MS = 3 * 24 * 60 * 60 * 1000;

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
/** текущая сессия эфира: один VOD на весь эфир, пока не finalizeStop */
const sessionMeta = new Map(); // key -> { vodId, abs }
const keyGen = new Map();
const pendingStopTimers = new Map();

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
  if (parts[0] !== 'live' || !parts[1]) return null;
  return parts[1];
}
function mediaDir(key) {
  return path.join(MEDIA_ROOT, 'live', key);
}
function wipeLiveMedia(key) {
  try {
    fs.rmSync(mediaDir(key), { recursive: true, force: true });
  } catch (_) {}
}

async function setLiveState(key, { isLive, touchStartedAt }) {
  const entry = streamKeyCache.get(key);
  if (!entry) {
    console.warn('[rtmp] ключ не в кэше:', key.slice(0, 8));
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
      // liveStartedAt ставим ТОЛЬКО если ещё null — иначе таймер не сбрасывается
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
  if (!proc || proc.killed) return;
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

async function finalizeVod(vodId, status = 'ready') {
  if (!vodId) return;
  try {
    await StreamVod.updateOne(
      { _id: vodId, status: 'recording' },
      { $set: { status } }
    );
  } catch (e) {
    console.warn('[rtmp] finalizeVod', e.message);
  }
}

async function finalizeStop(key) {
  clearPendingStop(key);
  nextGen(key);

  const entry = activeTranscodes.get(key);
  if (entry) {
    killProc(entry.proc, 'SIGTERM');
    setTimeout(() => killProc(entry.proc, 'SIGKILL'), 3000);
    activeTranscodes.delete(key);
    await finalizeVod(entry.vodId, 'ready');
    console.log('[rtmp] finalizeStop', key.slice(0, 8) + '…', 'vod=', entry.vodId || '—');
  } else {
    // ffmpeg уже умер, но VOD сессии ещё recording
    const meta = sessionMeta.get(key);
    if (meta?.vodId) await finalizeVod(meta.vodId, 'ready');
  }

  sessionMeta.delete(key);
  wipeLiveMedia(key);
  await setLiveState(key, { isLive: false, touchStartedAt: false });
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
      // postPublish мог снять таймер через clearPendingStop
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

function spawnFfmpeg(key, gen, hlsPath, vodAbs, vodId) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-i', `rtmp://127.0.0.1:1935/live/${key}`,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_allow_cache', '0',
    hlsPath,
  ];

  if (vodAbs) {
    args.push(
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      vodAbs
    );
  }

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
      // RTMP оборвался без donePublish — даём grace, вдруг OBS переподключится
      if (!pendingStopTimers.has(key)) {
        scheduleStop(key);
      }
    }
  });
}

async function startTranscode(key) {
  // отменяем отложенный stop (reconnect)
  const hadPendingStop = pendingStopTimers.has(key);
  clearPendingStop(key);

  // Уже крутится ffmpeg — лишний postPublish / "already has a publisher"
  const prev = activeTranscodes.get(key);
  if (prev) {
    console.log('[rtmp] ffmpeg уже есть → skip postPublish', key.slice(0, 8) + '…');
    await setLiveState(key, { isLive: true, touchStartedAt: false });
    return;
  }

  const gen = nextGen(key);
  fs.mkdirSync(mediaDir(key), { recursive: true });
  const hlsPath = path.join(mediaDir(key), 'index.m3u8');

  // Один VOD на сессию эфира
  let meta = sessionMeta.get(key);
  const isNewSession = !meta;

  if (isNewSession) {
    wipeLiveMedia(key);
    fs.mkdirSync(mediaDir(key), { recursive: true });
    try {
      meta = await createVodDoc(key);
      if (meta) sessionMeta.set(key, meta);
    } catch (e) {
      console.error('[rtmp] createVodDoc', e.message);
      meta = null;
    }
  } else {
    console.log('[rtmp] продолжаю сессию VOD', key.slice(0, 8) + '…', meta.vodId);
    // тот же VOD, но файл уже мог закрыться — пишем в новый файл? 
    // для простоты: при реконнекте после смерти ffmpeg дописывать в тот же frag-mp4 часто ломает файл.
    // Помечаем старый ready и НЕ создаём новый документ — зритель видит одну карточку только если мы не плодим docs.
    // Здесь просто рестарт HLS; VOD-файл сессии уже финализируем как ready, новый кусок не пишем
    // (иначе несколько «идёт запись»). Запись VOD = с начала сессии до первого обрыва.
    // Если нужен один длинный файл — ниже можно сменить стратегию.
  }

  // Для VOD: пишем только пока первая непрерывная сессия; после реконнекта только HLS
  const vodAbs = isNewSession ? meta?.abs : null;
  const vodId = meta?.vodId || null;

  setTimeout(async () => {
    if (currentGen(key) !== gen) return;
    if (pendingStopTimers.has(key)) return;
    if (activeTranscodes.has(key)) return;

    spawnFfmpeg(key, gen, hlsPath, vodAbs, vodId);

    // touchStartedAt только если это реально новый эфир (не было liveStartedAt)
    await setLiveState(key, {
      isLive: true,
      touchStartedAt: isNewSession && !hadPendingStop,
    });
  }, 300);
}

nms.on('postPublish', (session) => {
  const key = keyFromStreamPath(session?.streamPath || '');
  console.log('[rtmp] postPublish', session?.streamPath);
  if (key) startTranscode(key);
});

nms.on('donePublish', (session) => {
  const key = keyFromStreamPath(session?.streamPath || '');
  console.log('[rtmp] donePublish', session?.streamPath);
  if (key) scheduleStop(key);
});

module.exports = nms;