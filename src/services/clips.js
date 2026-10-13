// clips.js — клип из последних ~30 с эфира. Сегменты эфира (1 с) после выхода из плейлиста ещё ~40 с лежат
// на диске (rtmpServer: -hls_delete_threshold), их склеиваем без перекодирования (-c copy) в mp4.
// Качество — «источник» (как у стримера): клип 30 с ~15–25 МБ, поэтому у канала не больше 50 клипов и хранятся 30 дней
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const Clip = require('../models/Clip');
const streamKeyCache = require('./streamKeyCache');
const i18n = require('./i18n');

const FFMPEG_PATH = '/usr/bin/ffmpeg';
const MEDIA_ROOT = path.join(process.cwd(), 'media');
const CLIPS_ROOT = path.join(MEDIA_ROOT, 'clips');
const CLIP_SEC = 30;
const CLIP_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_PER_CHANNEL = 50;
const MAX_JOBS = 2; // одновременно склеиваемых клипов на весь сервер

let jobs = 0;
const channelBusy = new Set();

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('nice', ['-n', '19', FFMPEG_PATH, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
    proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim() || 'ffmpeg ' + code)); });
  });
}

// сегменты последних CLIP_SEC секунд: по времени записи файла, без самого свежего (он ещё пишется)
function pickSegments(dir) {
  const now = Date.now();
  const segs = fs.readdirSync(dir)
    .map((f) => /^seg_(\d+)\.ts$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ file: path.join(dir, m[0]), n: Number(m[1]) }))
    .sort((a, b) => a.n - b.n);
  segs.pop();
  const withTime = segs.map((s) => ({ ...s, t: fs.statSync(s.file).mtimeMs }));
  return withTime.filter((s) => now - s.t <= (CLIP_SEC + 1) * 1000);
}

// склеить последние ~30 с эфира (ключ потока key) в mp4 + кадр-обложку jpg; subs — порядок качеств.
// Возвращает длительность в секундах, бросает i18n.err server.clips.tooShort|failed
async function cutLast(key, subs, mp4, jpg) {
  const liveDir = path.join(MEDIA_ROOT, 'live', key);
  let segs = [];
  for (const sub of subs) {
    if (!fs.existsSync(path.join(liveDir, sub))) continue;
    segs = pickSegments(path.join(liveDir, sub));
    if (segs.length >= 3) break;
  }
  if (segs.length < 3) throw i18n.err('server.clips.tooShort');

  const list = mp4.replace(/\.mp4$/, '.txt');
  try {
    fs.writeFileSync(list, segs.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n'));
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', mp4]);
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', mp4, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', jpg])
      .catch(() => {}); // без обложки клип всё равно есть
  } catch (e) {
    console.warn('[clips] ffmpeg', e.message.slice(0, 300));
    try { fs.unlinkSync(mp4); } catch (_) {}
    throw i18n.err('server.clips.failed');
  } finally {
    try { fs.unlinkSync(list); } catch (_) {}
  }
  return Math.max(1, Math.round((segs[segs.length - 1].t - segs[0].t) / 1000) + 1);
}

/**
 * streamer — { _id, streamerNameLower, streamPlaybackId, streamTitle, streamCategoryId }; creator — { id, username }
 * Бросает i18n.err с ключом server.clips.*
 */
async function createClip(streamer, creator) {
  const key = streamer.streamPlaybackId && streamKeyCache.keyByPlaybackId(streamer.streamPlaybackId);
  if (!key) throw i18n.err('server.clips.notLive');
  if (channelBusy.has(streamer.streamerNameLower) || jobs >= MAX_JOBS) throw i18n.err('server.clips.busy');

  const id = new mongoose.Types.ObjectId();
  const dir = path.join(CLIPS_ROOT, String(streamer._id));
  fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, `${id}.mp4`);
  const jpg = path.join(dir, `${id}.jpg`);

  channelBusy.add(streamer.streamerNameLower);
  jobs += 1;
  let durationSec;
  try {
    durationSec = await cutLast(key, ['source', '720'], mp4, jpg); // клип — всегда в качестве эфира; 720p — запасной вариант
  } finally {
    channelBusy.delete(streamer.streamerNameLower);
    jobs -= 1;
  }

  const rel = (abs) => path.relative(MEDIA_ROOT, abs).split(path.sep).join('/');
  const clip = await Clip.create({
    _id: id,
    streamerId: streamer._id,
    streamerNameLower: streamer.streamerNameLower,
    creatorId: creator.id,
    creatorName: creator.username,
    title: (streamer.streamTitle || '').slice(0, 100),
    categoryId: streamer.streamCategoryId || null,
    durationSec,
    fileRel: rel(mp4),
    thumbRel: fs.existsSync(jpg) ? rel(jpg) : null,
    expiresAt: new Date(Date.now() + CLIP_TTL_MS),
  });

  // у канала не больше MAX_PER_CHANNEL клипов: лишние старые удаляем вместе с файлами
  const extra = await Clip.find({ streamerNameLower: streamer.streamerNameLower }).sort({ createdAt: -1 }).skip(MAX_PER_CHANNEL).limit(50);
  for (const c of extra) await removeClip(c);
  return clip;
}

async function removeClip(c) {
  for (const rel of [c.fileRel, c.thumbRel]) {
    if (!rel) continue;
    try { fs.unlinkSync(path.join(MEDIA_ROOT, rel)); } catch (_) {}
  }
  await Clip.deleteOne({ _id: c._id });
}

async function cleanupExpiredClips() {
  const old = await Clip.find({ expiresAt: { $lte: new Date() } }).limit(200);
  for (const c of old) await removeClip(c);
  if (old.length) console.log('[clips] удалено устаревших:', old.length);
}

// ---- запись-доказательство к 🚩 жалобе на идущий эфир ----
// Последние ~30 с эфира в 720p (если есть — легче «источника»), лежат в media/report-clips (статикой не раздаются):
// смотрит только админ через GET /api/support/clip/:id. Стример её не видит и удалить не может.
// 90 дней и не больше EVIDENCE_MAX файлов (старые удаляются). Несколько жалоб на канал за минуту — одна запись
const EVIDENCE_ROOT = path.join(MEDIA_ROOT, 'report-clips'); // у /media/report-clips нет раздачи статикой
const EVIDENCE_TTL_MS = 90 * 24 * 3600 * 1000;
const EVIDENCE_MAX = 200; // ~20 МБ каждая → до ~4 ГБ
const EVIDENCE_JOBS = 2;
let evidenceJobs = 0;
const evidenceRecent = new Map(); // streamerNameLower → { at, promise }

// → Promise<{ id, sec }>; бросает i18n.err server.clips.*
function createEvidence(streamer) {
  const key = streamer.streamPlaybackId && streamKeyCache.keyByPlaybackId(streamer.streamPlaybackId);
  if (!key) return Promise.reject(i18n.err('server.clips.notLive'));
  const lower = streamer.streamerNameLower;
  const hit = evidenceRecent.get(lower);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.promise;
  if (evidenceJobs >= EVIDENCE_JOBS) return Promise.reject(i18n.err('server.clips.busy'));

  const id = String(new mongoose.Types.ObjectId());
  evidenceJobs += 1;
  const promise = (async () => {
    try {
      fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
      const sec = await cutLast(key, ['720', 'source'], path.join(EVIDENCE_ROOT, id + '.mp4'), path.join(EVIDENCE_ROOT, id + '.jpg'));
      return { id, sec };
    } finally {
      evidenceJobs -= 1;
    }
  })();
  promise.catch(() => evidenceRecent.delete(lower));
  if (evidenceRecent.size > 500) evidenceRecent.clear();
  evidenceRecent.set(lower, { at: Date.now(), promise });
  return promise;
}

// путь к файлу записи (mp4 или обложка jpg) по id; null — нет такого
function evidencePath(id, thumb) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  const file = path.join(EVIDENCE_ROOT, id + (thumb ? '.jpg' : '.mp4'));
  return fs.existsSync(file) ? file : null;
}

// старше 90 дней и сверх EVIDENCE_MAX самых свежих — удаляем (зовёт vodCleanup раз в минуту)
function cleanupEvidence() {
  if (!fs.existsSync(EVIDENCE_ROOT)) return;
  const now = Date.now();
  const files = fs.readdirSync(EVIDENCE_ROOT)
    .filter((f) => /\.mp4$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(EVIDENCE_ROOT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let n = 0;
  files.forEach((x, i) => {
    if (i < EVIDENCE_MAX && now - x.t < EVIDENCE_TTL_MS) return;
    for (const ext of ['.mp4', '.jpg']) {
      try { fs.unlinkSync(path.join(EVIDENCE_ROOT, x.f.replace(/\.mp4$/, ext))); } catch (_) {}
    }
    n += 1;
  });
  if (n) console.log('[clips] удалено записей к жалобам:', n);
}

module.exports = { createClip, removeClip, cleanupExpiredClips, CLIPS_ROOT, createEvidence, evidencePath, cleanupEvidence };
