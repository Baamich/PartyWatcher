// services/ssrfGuard.js
// Защита от SSRF: сервер ходит по ссылкам, которые дают пользователи (relay, захват плеера).
// Без проверки через них можно достучаться до внутренней сети сервера (localhost, 169.254.169.254 и т.п.).
const dns = require('dns');
const net = require('net');
const { Agent } = require('undici');
const i18n = require('./i18n');

const HOST_OK_TTL_MS = 60_000;
const hostOkCache = new Map(); // имя хоста → до какого времени считаем его адрес публичным

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // не похоже на IPv4 — не рискуем
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||           // link-local, в том числе облачные metadata-сервисы
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224                              // multicast и зарезервированное
  );
}

function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) {
      const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return m ? isPrivateIPv4(m[1]) : true;
    }
    return /^(fc|fd|fe[89ab])/.test(s); // fc00::/7 и fe80::/10
  }
  return true;
}

// проверяет адрес в момент соединения (ловит подмену DNS и редиректы по именам)
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address }];
    if (list.some((a) => isPrivateAddress(a.address))) {
      return callback(i18n.err('server.ssrf.private'));
    }
    callback(null, address, family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });

// Бросает ошибку, если ссылка не http(s) или ведёт во внутреннюю сеть.
async function assertPublicHttpUrl(urlString) {
  let u;
  try {
    u = new URL(String(urlString));
  } catch {
    throw i18n.err('server.ssrf.badUrl');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw i18n.err('server.ssrf.protocol');
  if (u.username || u.password) throw i18n.err('server.ssrf.credentials');

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw i18n.err('server.ssrf.private');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw i18n.err('server.ssrf.private');
    return u;
  }

  const until = hostOkCache.get(host);
  if (until && until > Date.now()) return u; // недавно уже проверяли это имя

  const records = await dns.promises.lookup(host, { all: true });
  if (!records.length || records.some((r) => isPrivateAddress(r.address))) {
    throw i18n.err('server.ssrf.private');
  }
  if (hostOkCache.size > 500) hostOkCache.clear();
  hostOkCache.set(host, Date.now() + HOST_OK_TTL_MS);
  return u;
}

// fetch, который сам ведёт редиректы и проверяет каждый шаг
async function safeFetch(url, options = {}, { guarded = true, maxRedirects = 4 } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHttpUrl(current);
    const opts = { ...options, redirect: 'manual' };
    if (guarded && !opts.dispatcher) opts.dispatcher = guardedAgent;
    const res = await fetch(current, opts);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      try { await res.arrayBuffer(); } catch (_) {} // освобождаем соединение
      continue;
    }
    return res;
  }
  throw i18n.err('server.ssrf.redirects');
}

module.exports = { assertPublicHttpUrl, safeFetch, isPrivateAddress };