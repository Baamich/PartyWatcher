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

const RENDITIONS = [
  { name: 'source', copy: true },
  { name: '1080', height: 1080, vBitrate: '4500k', vMaxrate: '5000k', vBufsize: '9000k', aBitrate: '160k' },
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
  const hadPendingStop = pendingStopTimers.has(key);
  clearPendingStop(key);

  const prev = activeTranscodes.get(key);
  if (prev) {
    console.log('[rtmp] ffmpeg уже есть → skip postPublish', key.slice(0, 8) + '…');
    await setLiveState(key, { isLive: true, touchStartedAt: false });
    return;
  }

  const gen = nextGen(key);
  const hlsRootDir = mediaDir(key);

  let meta = sessionMeta.get(key);
  const isNewSession = !meta;

  if (isNewSession) {
    wipeLiveMedia(key);
    fs.mkdirSync(hlsRootDir, { recursive: true });
    try {
      meta = await createVodDoc(key);
      if (meta) sessionMeta.set(key, meta);
    } catch (e) {
      console.error('[rtmp] createVodDoc', e.message);
      meta = null;
    }
  } else {
    console.log('[rtmp] продолжаю сессию VOD', key.slice(0, 8) + '…', meta.vodId);
  }

  const vodAbs = isNewSession ? meta?.abs : null;
  const vodId = meta?.vodId || null;

  setTimeout(async () => {
    if (currentGen(key) !== gen) return;
    if (pendingStopTimers.has(key)) return;
    if (activeTranscodes.has(key)) return;

    spawnFfmpeg(key, gen, hlsRootDir, vodAbs, vodId);

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