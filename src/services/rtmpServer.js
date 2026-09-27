const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const streamKeyCache = require('./streamKeyCache');

const MEDIA_ROOT = path.join(process.cwd(), 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg';
/** сколько ждать postPublish после donePublish (типичный reconnect OBS) */
const PUBLISH_GRACE_MS = 12_000;

fs.mkdirSync(path.join(MEDIA_ROOT, 'live'), { recursive: true });

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

/** @type {Map<string, { proc: import('child_process').ChildProcess, gen: number }>} */
const activeTranscodes = new Map();
/** generation по ключу */
const keyGen = new Map();
/** отложенный полный stop после donePublish */
const pendingStopTimers = new Map(); // key -> Timeout

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

function wipeMedia(key) {
  try {
    fs.rmSync(mediaDir(key), { recursive: true, force: true });
  } catch (_) {}
}

async function setLive(key, isLive) {
  const entry = streamKeyCache.get(key);
  if (!entry) {
    console.warn('[rtmp] ключ не в кэше, isLive не обновлён:', key.slice(0, 8), '→', isLive);
    return;
  }
  try {
    const r = await User.updateOne(
      { _id: entry.userId },
      { $set: { isLive: !!isLive } }
    );
    console.log(
      `[rtmp] isLive=${!!isLive}, key=${key.slice(0, 8)}… matched=${r.matchedCount} modified=${r.modifiedCount}`
    );
  } catch (err) {
    console.error('[rtmp] isLive update error', err.message);
  }
}

function killProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGKILL');
  } catch (_) {}
}

function clearPendingStop(key) {
  const t = pendingStopTimers.get(key);
  if (t) {
    clearTimeout(t);
    pendingStopTimers.delete(key);
  }
}

/** полный стоп: kill ffmpeg + wipe + isLive=false */
function finalizeStop(key) {
  clearPendingStop(key);
  nextGen(key); // отменить отложенные start

  const entry = activeTranscodes.get(key);
  if (entry) {
    killProc(entry.proc);
    activeTranscodes.delete(key);
    console.log('[rtmp] finalizeStop: убил ffmpeg', key.slice(0, 8) + '…');
  }

  wipeMedia(key);
  setLive(key, false);
}

/**
 * donePublish: не рвём сразу — ждём grace.
 * Если за это время снова postPublish — таймер снимут, эфир продолжается.
 */
function scheduleStop(key) {
  clearPendingStop(key);
  console.log(
    `[rtmp] donePublish → grace ${PUBLISH_GRACE_MS / 1000}s, жду reconnect:`,
    key.slice(0, 8) + '…'
  );

  const timer = setTimeout(() => {
    pendingStopTimers.delete(key);
    console.log('[rtmp] grace истёк, полный stop:', key.slice(0, 8) + '…');
    finalizeStop(key);
  }, PUBLISH_GRACE_MS);

  pendingStopTimers.set(key, timer);
}

function startTranscode(key) {
  // reconnect в пределах grace — не считаем новым эфиром
  const hadPendingStop = pendingStopTimers.has(key);
  clearPendingStop(key);

  const prev = activeTranscodes.get(key);
  if (prev) {
    // уже есть ffmpeg (reconnect, пока старый play ещё жив) — не трогаем, только isLive
    if (hadPendingStop) {
      console.log('[rtmp] reconnect в grace — оставляю ffmpeg, isLive=true', key.slice(0, 8) + '…');
      setLive(key, true);
      return;
    }
    killProc(prev.proc);
    activeTranscodes.delete(key);
  }

  const gen = nextGen(key);

  // wipe только если это не быстрый reconnect (не было pending stop)
  // при первом старте / после полного stop — чистим
  if (!hadPendingStop) {
    wipeMedia(key);
  }
  fs.mkdirSync(mediaDir(key), { recursive: true });
  const outputPath = path.join(mediaDir(key), 'index.m3u8');

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
    '-start_number', '0',
    outputPath,
  ];

  setTimeout(() => {
    if (currentGen(key) !== gen) {
      console.log('[rtmp] start отменён (новый gen)', key.slice(0, 8) + '…');
      return;
    }

    // на всякий случай: если за 400мс снова успели поставить pending stop — не стартуем
    if (pendingStopTimers.has(key)) {
      console.log('[rtmp] start отменён (pending stop)', key.slice(0, 8) + '…');
      return;
    }

    console.log('[rtmp] запускаю ffmpeg', key.slice(0, 8) + '…', 'gen=', gen, hadPendingStop ? '(после grace-cancel)' : '');
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    activeTranscodes.set(key, { proc, gen });

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[ffmpeg:${key.slice(0, 8)}]`, line);
    });
    proc.on('error', (err) => {
      console.error(`[ffmpeg:${key.slice(0, 8)}] spawn error`, err.message);
      if (activeTranscodes.get(key)?.gen === gen) activeTranscodes.delete(key);
    });
    proc.on('exit', (code, signal) => {
      console.log(`[rtmp] ffmpeg ${key.slice(0, 8)}… exit code=${code} signal=${signal} gen=${gen}`);
      const cur = activeTranscodes.get(key);
      if (cur && cur.gen === gen) activeTranscodes.delete(key);
    });

    setLive(key, true);
  }, 400);
}

nms.on('postPublish', (session) => {
  const streamPath = session?.streamPath || '';
  const key = keyFromStreamPath(streamPath);
  console.log('[rtmp] postPublish', streamPath);
  if (key) startTranscode(key);
});

nms.on('donePublish', (session) => {
  const streamPath = session?.streamPath || '';
  const key = keyFromStreamPath(streamPath);
  console.log('[rtmp] donePublish', streamPath);
  if (key) scheduleStop(key);
});

if (typeof nms.on !== 'function') {
  try {
    const Context = require('node-media-server/src/core/context.js');
    Context.eventEmitter.on('postPublish', (session) => {
      const key = keyFromStreamPath(session?.streamPath);
      if (key) startTranscode(key);
    });
    Context.eventEmitter.on('donePublish', (session) => {
      const key = keyFromStreamPath(session?.streamPath);
      if (key) scheduleStop(key);
    });
    console.log('[rtmp] подписался на Context.eventEmitter');
  } catch (e) {
    console.error('[rtmp] события NMS:', e.message);
  }
}

module.exports = nms;