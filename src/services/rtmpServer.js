const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const streamKeyCache = require('./streamKeyCache');

const MEDIA_ROOT = path.join(process.cwd(), 'media');
const FFMPEG_PATH = '/usr/bin/ffmpeg';
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
const activeTranscodes = new Map(); // key -> ChildProcess

function keyFromStreamPath(streamPath) {
  // v4: session.streamPath вида "/live/mySecretKey"
  if (!streamPath || typeof streamPath !== 'string') return null;
  const parts = streamPath.replace(/^\//, '').split('/');
  // app = parts[0] ('live'), key = parts[1]
  if (parts[0] !== 'live' || !parts[1]) return null;
  return parts[1];
}

function startTranscode(key) {
  if (activeTranscodes.has(key)) return;
  const outDir = path.join(MEDIA_ROOT, 'live', key);
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, 'index.m3u8');

  const args = [
    '-i', `rtmp://127.0.0.1:1935/live/${key}`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments',
    outputPath,
  ];

  console.log('[rtmp] запускаю ffmpeg для ключа', key);
  const proc = spawn(FFMPEG_PATH, args);
  activeTranscodes.set(key, proc);

  proc.stderr.on('data', (chunk) => console.log(`[ffmpeg:${key}]`, chunk.toString().trim()));
  proc.on('error', (err) => console.error(`[ffmpeg:${key}] не удалось запустить процесс`, err));
  proc.on('exit', (code, signal) => {
    console.log(`[rtmp] ffmpeg для ${key} завершился (code=${code}, signal=${signal})`);
    activeTranscodes.delete(key);
  });

  const entry = streamKeyCache.get(key);
  if (entry) {
    User.updateOne({ _id: entry.userId }, { isLive: true })
      .then((r) => console.log('[rtmp] isLive=true, matched:', r.matchedCount, 'modified:', r.modifiedCount))
      .catch((err) => console.error('[rtmp] isLive set error', err));
  } else {
    console.warn('[rtmp] стрим идёт под ключом, которого нет в кэше:', key);
  }
}

function stopTranscode(key) {
  const proc = activeTranscodes.get(key);
  if (proc) {
    proc.kill('SIGINT');
    activeTranscodes.delete(key);
  }
  const entry = streamKeyCache.get(key);
  if (entry) {
    User.updateOne({ _id: entry.userId }, { isLive: false })
      .then((r) => console.log('[rtmp] isLive=false, matched:', r.matchedCount, 'modified:', r.modifiedCount))
      .catch((err) => console.error('[rtmp] isLive unset error', err));
  }
}

// v4: nms.on проксирует в Context.eventEmitter; колбэк получает session, не (id, path, args)
nms.on('postPublish', (session) => {
  const streamPath = session?.streamPath || '';
  const key = keyFromStreamPath(streamPath);
  console.log('[rtmp] postPublish', streamPath, '→ key=', key);
  if (key) startTranscode(key);
});

nms.on('donePublish', (session) => {
  const streamPath = session?.streamPath || '';
  const key = keyFromStreamPath(streamPath);
  console.log('[rtmp] donePublish', streamPath, '→ key=', key);
  if (key) stopTranscode(key);
});

// на случай старых/кривых версий, где on() ещё нет — fallback через Context
if (typeof nms.on !== 'function') {
  try {
    const Context = require('node-media-server/src/core/context.js');
    Context.eventEmitter.on('postPublish', (session) => {
      const key = keyFromStreamPath(session?.streamPath);
      if (key) startTranscode(key);
    });
    Context.eventEmitter.on('donePublish', (session) => {
      const key = keyFromStreamPath(session?.streamPath);
      if (key) stopTranscode(key);
    });
    console.log('[rtmp] подписался на Context.eventEmitter (nms.on отсутствует)');
  } catch (e) {
    console.error('[rtmp] не удалось подписаться на события NMS:', e.message);
  }
}

module.exports = nms;