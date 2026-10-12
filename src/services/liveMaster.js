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

function fixMaster(text, liveDir) {
  const lines = text.split('\n');
  const bw = (i) => Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
  let srcInf = -1, maxOther = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    if (lines[i + 1].trim().startsWith('source/')) srcInf = i;
    else maxOther = Math.max(maxOther, bw(i));
  }
  if (srcInf < 0) return text;
  // по сегментам; если их ещё нет — хотя бы выше всех перекодированных уровней
  const real = measureBandwidth(path.join(liveDir, 'source'));
  const value = real || (maxOther ? Math.round(maxOther * 1.5) : 0);
  if (!value || (real === 0 && value <= bw(srcInf))) return text;
  lines[srcInf] = lines[srcInf]
    .replace(/(^|[:,])BANDWIDTH=\d+/, `$1BANDWIDTH=${value}`)
    .replace(/,AVERAGE-BANDWIDTH=\d+/, '');
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
