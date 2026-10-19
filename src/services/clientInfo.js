// Кто пришёл: IP, устройство (cookie pw_dev от js/device.js) и понятное название по User-Agent и Client Hints.
// Общее для статистики (analytics.js), банов (bans.js) и регистрации
const crypto = require('crypto');

// за туннелем Cloudflare: cf-connecting-ip, иначе req.ip (trust proxy) или адрес сокета (сырой запрос сокетов)
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && typeof cf === 'string') return cf.trim().slice(0, 64);
  if (req.ip) return String(req.ip).replace(/^::ffff:/, '');
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.socket?.remoteAddress || req.connection?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
}

// cookie pw_dev = '1.<did 16 hex>.<hw 16 hex>' — ставит public/js/device.js
const DEV_RE = /(?:^|;\s*)pw_dev=1\.([0-9a-f]{16})\.([0-9a-f]{16})(?:;|$)/;
function deviceIds(req) {
  const m = String(req.headers.cookie || '').match(DEV_RE);
  return m ? { did: m[1], hw: m[2] } : { did: '', hw: '' };
}

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|preview|curl|wget|python|httpclient|go-http|okhttp|java\/|axios|node-fetch|undici|headless|lighthouse|monitor|uptime/i;

const unq = (v) => String(v || '').replace(/^"|"$/g, '').trim();

// { type, os, browser, name } по User-Agent (+ Sec-CH-UA-*: модель телефона и Windows 11 — их просит pages.js)
function parseUA(headers) {
  const ua = String(headers['user-agent'] || '');
  if (!ua) return { type: 'bot', os: '', browser: '', name: 'unknown' };
  if (BOT_RE.test(ua)) {
    // имя бота для админки («Последние боты»): первое узнаваемое слово, иначе просто «bot»
    const b = (ua.match(/([A-Za-z][\w.-]*bot|facebookexternalhit|[\w-]*preview|embedly|[\w-]*crawler|[\w-]*spider|curl|wget|python[\w.-]*|Go-http-client|okhttp|axios|node-fetch|undici|Java|HeadlessChrome|Lighthouse|[\w-]*monitor[\w-]*|[\w-]*uptime[\w-]*)[/ ]?([\d.]*)/i) || [])[1] || 'bot';
    return { type: 'bot', os: '', browser: b, name: b };
  }

  let os = 'Other';
  let osVer = '';
  const model = unq(headers['sec-ch-ua-model']);
  const platVer = unq(headers['sec-ch-ua-platform-version']);
  let m;
  if (/Windows NT/.test(ua)) {
    os = 'Windows';
    m = ua.match(/Windows NT ([\d.]+)/);
    if (m) osVer = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]] || m[1];
    if (osVer === '10' && parseInt(platVer, 10) >= 13) osVer = '11'; // Chrome шлёт 10.0 и для Windows 11
  } else if ((m = ua.match(/(iPhone|iPad|iPod).*? OS (\d+)[_\d]*/))) {
    os = m[1] === 'iPad' ? 'iPadOS' : 'iOS';
    osVer = m[2];
  } else if ((m = ua.match(/Android ([\d.]+)/))) {
    os = 'Android';
    osVer = m[1].split('.')[0];
  } else if (/Mac OS X|Macintosh/.test(ua)) {
    os = 'macOS';
  } else if (/CrOS/.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    os = 'Linux';
  }

  let browser = 'Other';
  const B = [
    [/YaBrowser\/(\d+)/, 'Yandex'],
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)|Opera\/(\d+)/, 'Opera'],
    [/SamsungBrowser\/(\d+)/, 'Samsung'],
    [/Vivaldi\/(\d+)/, 'Vivaldi'],
    [/Firefox\/(\d+)|FxiOS\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/OBS\/(\d+)/, 'OBS'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ];
  for (const [re, nm] of B) {
    m = ua.match(re);
    if (m) {
      browser = nm + ' ' + (m[1] || m[2] || '');
      break;
    }
  }
  browser = browser.trim();

  const tablet = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  const mobile = !tablet && (/Mobi|iPhone|iPod/.test(ua) || unq(headers['sec-ch-ua-mobile']) === '?1');
  const type = tablet ? 'tablet' : mobile ? 'mobile' : 'desktop';

  // модель: из Client Hints, иначе из старого UA Android («; SM-S918B Build/»), для Apple — сам iPhone/iPad
  let dev = model;
  if (!dev && (m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/|\))/)) && m[1] !== 'K') dev = m[1].trim();
  if (!dev && (m = ua.match(/\((iPhone|iPad|iPod)/))) dev = m[1];

  const osName = (os + ' ' + osVer).trim();
  const name = [osName, dev, browser].filter(Boolean).join(' · ').slice(0, 120);
  return { type, os: osName.slice(0, 40), browser: browser.slice(0, 40), name };
}

// ключ посетителя — самый точный из известных: аккаунт → устройство (cookie pw_dev) → хэш IP + браузера.
// aliases — менее точные ключи того же запроса: первый заход идёт ещё без cookie устройства и без входа,
// analytics.js склеивает такие записи с человеком, чтобы он не считался дважды
function visitorKeys(ip, ids, ua, userId) {
  const anon = 'a:' + crypto.createHash('sha1').update(ip + '|' + ua).digest('hex').slice(0, 16);
  const dev = ids.did ? 'd:' + ids.did : '';
  const key = userId ? 'u:' + userId : dev || anon;
  return { key, aliases: [dev, anon].filter((k) => k && k !== key) };
}

module.exports = { clientIp, deviceIds, parseUA, visitorKeys, BOT_RE };
