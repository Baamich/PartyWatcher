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
  // trans больше не используем — его внутреннее срабатывание непрозрачно и
  // молча ничего не делало при живом RTMP-соединении, без единой строки в логах.
  // Сами запускаем ffmpeg дочерним процессом ниже — так видно любую ошибку.
};

const nms = new NodeMediaServer(nmsConfig);
const activeTranscodes = new Map(); // key -> ChildProcess

function startTranscode(key) {
  if (activeTranscodes.has(key)) return; // уже запущен
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

  proc.stderr.on('data', (chunk) => {
    console.log(`[ffmpeg:${key}]`, chunk.toString().trim());
  });
  proc.on('error', (err) => {
    console.error(`[ffmpeg:${key}] не удалось запустить процесс`, err);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[rtmp] ffmpeg для ${key} завершился (code=${code}, signal=${signal})`);
    activeTranscodes.delete(key);
  });
}

function stopTranscode(key) {
  const proc = activeTranscodes.get(key);
  if (proc) {
    proc.kill('SIGINT');
    activeTranscodes.delete(key);
  }
}

nms.on('prePublish', (id, streamPath) => {
  try {
    if (!streamPath) return;
    const key = streamPath.split('/').pop();
    const entry = streamKeyCache.get(key);
    const session = nms.getSession(id);

    if (!entry) {
      console.warn('[rtmp] prePublish: ключ не найден в кэше, реджект', key);
      session?.reject();
      return;
    }

    console.log('[rtmp] prePublish: найден пользователь', entry.userId, 'playbackId', entry.playbackId);
    User.updateOne({ _id: entry.userId }, { isLive: true })
      .then((result) => console.log('[rtmp] isLive=true записан, matched:', result.matchedCount, 'modified:', result.modifiedCount))
      .catch((err) => console.error('[rtmp] isLive set error', err));
  } catch (err) {
    console.error('[rtmp] prePublish handler error', err);
  }
});

nms.on('postPublish', (id, streamPath) => {
  try {
    if (!streamPath) return;
    const key = streamPath.split('/').pop();
    startTranscode(key);
  } catch (err) {
    console.error('[rtmp] postPublish handler error', err);
  }
});

nms.on('donePublish', (id, streamPath) => {
  try {
    if (!streamPath) return;
    const key = streamPath.split('/').pop();
    stopTranscode(key);

    const entry = streamKeyCache.get(key);
    if (entry) {
      User.updateOne({ _id: entry.userId }, { isLive: false }).catch((err) =>
        console.error('[rtmp] isLive unset error', err)
      );
    }
  } catch (err) {
    console.error('[rtmp] donePublish handler error', err);
  }
});

module.exports = nms;