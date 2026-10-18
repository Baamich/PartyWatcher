// «Страница обновилась» поисковикам — сразу, а не когда робот зайдёт сам (дни):
//  - IndexNow (Bing, Яндекс и др.): ключ INDEXNOW_KEY, файл с ключом раздаёт server.js (/<ключ>.txt);
//  - Google Indexing API: для страниц с прямым эфиром (разметка BroadcastEvent — значок LIVE в выдаче).
//    Ключ сервисного аккаунта — JSON-файл, путь в GOOGLE_INDEXING_KEY_FILE; бесплатно 200 запросов в сутки.
// Нет переменной — соответствующая часть молча выключена. Один адрес — не чаще раза в PER_URL_MS.
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const PER_URL_MS = 60 * 60 * 1000;
const GOOGLE_DAILY = 180; // запас до лимита 200
const TIMEOUT = 8000;

const INDEXNOW_KEY = /^[a-zA-Z0-9-]{8,128}$/.test(process.env.INDEXNOW_KEY || '') ? process.env.INDEXNOW_KEY : '';
const SITE = String(config.publicUrl || '').replace(/\/+$/, '');
const HOST = (() => { try { return new URL(SITE).host; } catch { return ''; } })();
const isPublic = HOST && !/^(localhost|127\.|\[::1\])/.test(HOST);

const last = new Map(); // 'g:'|'n:' + вид + адрес → время последней отправки
function due(key) {
  const now = Date.now();
  const at = last.get(key);
  if (at && now - at < PER_URL_MS) return false;
  if (last.size > 5000) for (const [k, v] of last) if (now - v >= PER_URL_MS) last.delete(k);
  last.set(key, now);
  return true;
}

// ---------- IndexNow ----------
async function indexNow(urls, kind) {
  const list = urls.filter((u) => due(`n:${kind}:${u}`));
  if (!INDEXNOW_KEY || !isPublic || !list.length) return;
  const r = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: list }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status >= 300) console.warn('[searchPing] IndexNow', r.status);
}

// ---------- Google Indexing API ----------
let gKey = null; // { client_email, private_key }
let gKeyTried = false;
function googleKey() {
  if (gKeyTried) return gKey;
  gKeyTried = true;
  const file = process.env.GOOGLE_INDEXING_KEY_FILE;
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.client_email && j.private_key) gKey = { client_email: j.client_email, private_key: j.private_key };
    else console.warn('[searchPing] в GOOGLE_INDEXING_KEY_FILE нет client_email/private_key');
  } catch (e) {
    console.warn('[searchPing] не прочитать GOOGLE_INDEXING_KEY_FILE:', e.code || e.message);
  }
  return gKey;
}

const b64url = (v) => Buffer.from(v).toString('base64url');
let gToken = null;
let gTokenExp = 0;
async function googleToken(key) {
  if (gToken && Date.now() < gTokenExp - 60000) return gToken;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token ' + r.status + ' ' + (j.error || ''));
  gToken = j.access_token;
  gTokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return gToken;
}

let gDay = '';
let gCount = 0;
async function google(url, kind) {
  const key = googleKey();
  if (!key || !isPublic) return;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== gDay) { gDay = day; gCount = 0; }
  if (gCount >= GOOGLE_DAILY || !due(`g:${kind}:${url}`)) return;
  gCount++;
  const token = await googleToken(key);
  const r = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) console.warn('[searchPing] Google Indexing', r.status);
}

// адреса страницы стримера на обоих языках (как в sitemap.xml)
function streamerUrls(nameLower) {
  const base = `${SITE}/streamers/${encodeURIComponent(nameLower)}`;
  return [base, base + '?lang=ru', base + '?lang=en'];
}

// эфир начался (kind 'start') или закончился ('end'): поисковики обновят страницу и значок LIVE.
// Начало и конец считаются отдельно — короткий эфир тоже снимет LIVE
function streamChanged(nameLower, kind) {
  if (!nameLower || !isPublic) return;
  const urls = streamerUrls(nameLower);
  indexNow(urls, kind).catch((e) => console.warn('[searchPing] IndexNow', e.message));
  google(urls[0], kind).catch((e) => console.warn('[searchPing] Google', e.message));
}

module.exports = { INDEXNOW_KEY, streamChanged };
