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
const PUBLISH_GRACE_MS = 12_000;
const VOD_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 дня

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
  const update = { isLive: !!isLive };
  if (isLive && touchStartedAt) {
    update.liveStartedAt = new Date();
  }
  if (!isLive) {
    update.liveStartedAt = null;
  }
  try {
    const r = await User.updateOne({ _id: entry.userId }, { $set: update });
    console.log(
      `[rtmp] isLive=${!!isLive}, startedAt=${touchStartedAt ? 'set' : isLive ? 'keep' : 'clear'}, key=${key.slice(0, 8)}… mod=${r.modifiedCount}`
    );
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
    await StreamVod.updateOne({ _id: vodId, status: 'recording' }, { $set: { status } });
  } catch (e) {
    console.warn('[rtmp] finalizeVod', e.message);
  }
}

async function finalizeStop(key) {
  clearPendingStop(key);
  nextGen(key);

  const entry = activeTranscodes.get(key);
  if (entry) {
    // SIGTERM — чтобы mp4 успел закрыться; через 3с — SIGKILL
    killProc(entry.proc, 'SIGTERM');
    setTimeout(() => killProc(entry.proc, 'SIGKILL'), 3000);
    activeTranscodes.delete(key);
    await finalizeVod(entry.vodId, 'ready');
    console.log('[rtmp] finalizeStop', key.slice(0, 8) + '…');
  }

  wipeLiveMedia(key);
  await setLiveState(key, { isLive: false, touchStartedAt: false });
}

function scheduleStop(key) {
  clearPendingStop(key);
  console.log(`[rtmp] donePublish → grace ${PUBLISH_GRACE_MS / 1000}s`, key.slice(0, 8) + '…');
  const timer = setTimeout(() => {
    pendingStopTimers.delete(key);
    console.log('[rtmp] grace истёк → stop', key.slice(0, 8) + '…');
    finalizeStop(key);
  }, PUBLISH_GRACE_MS);
  pendingStopTimers.set(key, timer);
}

async function createVodDoc(key) {
  const entry = streamKeyCache.get(key);
  if (!entry) return null;
  const user = await User.findById(entry.userId).select('streamerNameLower streamTitle streamDescription').lean();
  if (!user) return null;

  const vodId = new (require('mongoose').Types.ObjectId)();
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

async function startTranscode(key) {
  const hadPendingStop = pendingStopTimers.has(key);
  clearPendingStop(key);

  const prev = activeTranscodes.get(key);
  if (prev) {
    if (hadPendingStop) {
      console.log('[rtmp] reconnect в grace — ffmpeg жив', key.slice(0, 8) + '…');
      // не трогаем liveStartedAt
      await setLiveState(key, { isLive: true, touchStartedAt: false });
      return;
    }
    killProc(prev.proc, 'SIGKILL');
    activeTranscodes.delete(key);
  }

  const gen = nextGen(key);
  if (!hadPendingStop) wipeLiveMedia(key);
  fs.mkdirSync(mediaDir(key), { recursive: true });
  const hlsPath = path.join(mediaDir(key), 'index.m3u8');

  // новый VOD только если не reconnect в grace
  let vodMeta = null;
  if (!hadPendingStop) {
    try {
      vodMeta = await createVodDoc(key);
    } catch (e) {
      console.error('[rtmp] createVodDoc', e.message);
    }
  } else if (prev?.vodId) {
    vodMeta = { vodId: prev.vodId };
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-i', `rtmp://127.0.0.1:1935/live/${key}`,
    // HLS для зрителей
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_allow_cache', '0',
    hlsPath,
  ];

  // параллельная запись VOD (fragmented mp4 переживает обрыв)
  if (vodMeta?.abs) {
    args.push(
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      vodMeta.abs
    );
  }

  setTimeout(async () => {
    if (currentGen(key) !== gen) return;
    if (pendingStopTimers.has(key)) return;

    console.log('[rtmp] ffmpeg start', key.slice(0, 8) + '…', 'gen=', gen, 'vod=', vodMeta?.vodId || '—');
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    activeTranscodes.set(key, { proc, gen, vodId: vodMeta?.vodId || null });

    proc.stderr.on('data', (c) => {
      const line = c.toString().trim();
      if (line) console.log(`[ffmpeg:${key.slice(0, 8)}]`, line);
    });
    proc.on('exit', (code, signal) => {
      console.log(`[rtmp] ffmpeg exit ${key.slice(0, 8)}… code=${code} signal=${signal}`);
      const cur = activeTranscodes.get(key);
      if (cur && cur.gen === gen) activeTranscodes.delete(key);
    });

    // таймер эфира: только при реальном старте, не при grace-reconnect
    await setLiveState(key, { isLive: true, touchStartedAt: !hadPendingStop });
  }, 400);
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