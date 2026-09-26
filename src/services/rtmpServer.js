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
    port: 8888, // локальный, наружу не открываем — HLS отдаёт Express через /media/live
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

// СИНХРОННАЯ проверка по кэшу в памяти — критично: если бы тут был await к базе,
// FFmpeg мог бы успеть начать писать файлы под секретным ключом ещё до ответа Mongo.
nms.on('prePublish', (id, streamPath) => {
  const key = streamPath.split('/').pop();
  const entry = streamKeyCache.get(key);
  const session = nms.getSession(id);

  if (!entry) {
    session.reject(); // неизвестный ключ — обрываем немедленно, до записи чего-либо на диск
    return;
  }

  // Подменяем путь публикации на публичный playbackId ДО того, как транскодер начнёт
  // писать HLS-файлы. Секретный ключ в итоге никогда не становится именем папки на диске.
  session.publishStreamPath = `/live/${entry.playbackId}`;

  User.updateOne({ _id: entry.userId }, { isLive: true }).catch((err) =>
    console.error('[rtmp] isLive set error', err)
  );
});

nms.on('donePublish', (id, streamPath) => {
  const key = streamPath.split('/').pop();
  const entry = streamKeyCache.get(key);
  if (entry) {
    User.updateOne({ _id: entry.userId }, { isLive: false }).catch((err) =>
      console.error('[rtmp] isLive unset error', err)
    );
  }
});

module.exports = nms;