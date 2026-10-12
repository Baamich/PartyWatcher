// services/vkVideo.js — ссылки VK Видео → адрес встроенного плеера с управлением (js_api=1).
// Видео играет iframe VK у каждого зрителя: сервер ничего не скачивает.
// Понимает: vk.com/video-1_2, vkvideo.ru/video-1_2, …?z=video-1_2, vk.com/clip-1_2,
// код встраивания video_ext.php?oid=-1&id=2&hash=… (и целиком <iframe …>).
// Публичные видео встраиваются без hash; для закрытых нужен код встраивания (с hash).

const HOST_RE = /^(?:[a-z0-9-]+\.)*(?:vk\.com|vk\.ru|vkvideo\.ru)$/i;

function normalizeVkLink(raw) {
  let s = String(raw || '').slice(0, 2000).replace(/&amp;/g, '&').trim();
  if (!s.includes('//')) s = 'https://' + s; // «vk.com/video-1_2» без https://
  // вытаскиваем первый адрес VK (в т.ч. из кода <iframe src="…">)
  const m = s.match(/(?:https?:)?\/\/([a-z0-9.-]+)(\/[^\s"'<>]*)?/i);
  if (!m || !HOST_RE.test(m[1])) return null;
  let pathAndQuery = (m[2] || '').replace(/\+/g, ' ');
  try { pathAndQuery = decodeURIComponent(pathAndQuery); } catch { /* битый %xx — разбираем как есть */ }

  let oid, id, hash;
  const ext = pathAndQuery.match(/video_ext\.php\?(.*)$/i);
  if (ext) {
    const q = new URLSearchParams(ext[1]);
    oid = q.get('oid');
    id = q.get('id');
    hash = q.get('hash');
  } else {
    const v = pathAndQuery.match(/(?:video|clip)(-?\d{1,12})_(\d{1,12})/i);
    if (v) [, oid, id] = v;
  }
  if (!/^-?\d{1,12}$/.test(oid || '') || !/^\d{1,12}$/.test(id || '')) return null;

  const out = new URLSearchParams({ oid, id });
  if (hash && /^[a-z0-9]{6,40}$/i.test(hash)) out.set('hash', hash);
  out.set('hd', '2');
  out.set('js_api', '1');
  return `https://vk.com/video_ext.php?${out}`;
}

module.exports = { normalizeVkLink };
