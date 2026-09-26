const NodeMediaServer = require('node-media-server');
const path = require('path');
const User = require('../models/User');
const streamKeyCache = require('./streamKeyCache');

const MEDIA_ROOT = path.join(process.cwd(), 'media');

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
  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=6:hls_flags=delete_segments]',
        dash: false,
      },
    ],
  },
};

const nms = new NodeMediaServer(nmsConfig);

// ВАЖНО: не трогаем session.publishStreamPath и другие внутренности NMS —
// в v4.4.3 подмена этого поля ломает внутреннее состояние broadcast_server
// и вызывает падение процесса при donePublish. Файлы HLS пишутся туда, куда
// FFmpeg и так пишет по умолчанию (папка = имя ключа); публичный доступ
// через playbackId организован отдельным Express-роутом в server.js,
// который ищет нужную папку по обратному соответствию (см. streamKeyCache).

nms.on('prePublish', (id, streamPath) => {
  try {
    if (!streamPath) return;
    const key = streamPath.split('/').pop();
    const entry = streamKeyCache.get(key);
    const session = nms.getSession(id);

    if (!entry) {
      session?.reject();
      return;
    }

    User.updateOne({ _id: entry.userId }, { isLive: true }).catch((err) =>
      console.error('[rtmp] isLive set error', err)
    );
  } catch (err) {
    console.error('[rtmp] prePublish handler error', err);
  }
});

nms.on('donePublish', (id, streamPath) => {
  try {
    if (!streamPath) return;
    const key = streamPath.split('/').pop();
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