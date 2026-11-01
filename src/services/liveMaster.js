// services/liveMaster.js — master.m3u8 эфира с честным битрейтом «источника».
// «Источник» идёт без перекодирования (copy), и ffmpeg не знает его битрейт: в master-плейлисте у него
// BANDWIDTH мал или почти ноль. hls.js сортирует качества по битрейту и в «Авто» мог считать «источник»
// самым лёгким. Перед отдачей считаем битрейт по реальным сегментам и подставляем его.
const fs = require('fs');
const path = require('path');

const cache = new Map(); // папка эфира → { at, text }
const TTL_MS = 10_000;

// бит/с по последним сегментам плейлиста уровня: сумма размеров / сумма длительностей
function measureBandwidth(levelDir) {
  let text;
  try { text = fs.readFileSync(path.join(levelDir, 'index.m3u8'), 'utf8'); } catch (_) { return 0; }
  let dur = 0, bytes = 0, last = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const m = t.match(/^#EXTINF:([\d.]+)/);
    if (m) { last = parseFloat(m[1]) || 0; continue; }
    if (!t || t.startsWith('#') || t.includes('/') || t.includes('..')) continue;
    try {
      bytes += fs.statSync(path.join(levelDir, t)).size;
      dur += last;
    } catch (_) {} // сегмент уже удалён
  }
  return dur > 0 ? Math.round(((bytes * 8) / dur) * 1.1) : 0;
}

// у копии ffmpeg пишет почти один звук (~140 кбит/с): ниже этого уровень точно не перекодирован
const COPY_BW_MAX = 300_000;

function fixMaster(text, liveDir) {
  const lines = text.split('\n');
  const bw = (i) => Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
  const setBw = (i, value) => {
    lines[i] = lines[i]
      .replace(/(^|[:,])BANDWIDTH=\d+/, `$1BANDWIDTH=${value}`)
      .replace(/,AVERAGE-BANDWIDTH=\d+/, '');
  };
  let srcInf = -1, maxOther = 0, changed = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines[i + 1].trim();
    if (uri.startsWith('source/')) { srcInf = i; continue; }
    // качества от стримера (OBS «Multitrack Video») — тоже копии: считаем по сегментам
    const dir = uri.split('/')[0];
    if (bw(i) < COPY_BW_MAX && /^\d+$/.test(dir)) {
      const real = measureBandwidth(path.join(liveDir, dir));
      if (real) { setBw(i, real); changed = true; }
    }
    maxOther = Math.max(maxOther, bw(i));
  }
  if (srcInf < 0) return changed ? lines.join('\n') : text;
  // по сегментам; если их ещё нет — хотя бы выше всех остальных уровней
  const real = measureBandwidth(path.join(liveDir, 'source'));
  const value = real || (maxOther ? Math.round(maxOther * 1.5) : 0);
  if (!value || (real === 0 && value <= bw(srcInf))) return changed ? lines.join('\n') : text;
  setBw(srcInf, value);
  return lines.join('\n');
}

function sendLiveMaster(liveDir, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  const hit = cache.get(liveDir);
  if (hit && Date.now() - hit.at < TTL_MS) return res.send(hit.text);
  let text;
  try { text = fs.readFileSync(path.join(liveDir, 'master.m3u8'), 'utf8'); } catch (_) { return res.status(404).end(); }
  const fixed = fixMaster(text, liveDir);
  if (cache.size > 200) cache.clear();
  cache.set(liveDir, { at: Date.now(), text: fixed });
  res.send(fixed);
}

module.exports = { sendLiveMaster, fixMaster, measureBandwidth };
