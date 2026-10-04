// middleware/securityHeaders.js
// Заголовки безопасности + Content Security Policy.
// Режим задаёт переменная CSP_MODE: report (только отчёты) | enforce (блокировать) | off.
const helmet = require('helmet');
const config = require('../config');

const MODE = (process.env.CSP_MODE || 'report').toLowerCase();

function wsOrigin() {
  try {
    const u = new URL(config.publicUrl);
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
  } catch {
    return null;
  }
}

function buildDirectives() {
  const ws = wsOrigin();
  if (config.env === 'production' && /localhost/.test(config.publicUrl)) {
    console.warn('[csp] PUBLIC_URL похож на localhost: задай в .env адрес сайта (https://partywatcher.de)');
  }

  const directives = {
    defaultSrc: ["'self'"],
    // 'unsafe-inline' нужен, пока в HTML есть onclick="..." (этап 2 — убрать его)
    scriptSrc: [
      "'self'",
      "'unsafe-inline'",
      'https://www.youtube.com',   // YouTube IFrame API
      'https://s.ytimg.com',
      'https://embed.twitch.tv',   // Twitch embed
      'https://player.twitch.tv',
    ],
    styleSrc: ["'self'", "'unsafe-inline'"], // style="..." в разметке и в JS
    imgSrc: ["'self'", 'data:', 'blob:', 'https://img.youtube.com', 'https://i.ytimg.com'],
    mediaSrc: ["'self'", 'blob:', 'https:'], // «прямая ссылка» на видео может вести на любой https-хост
    connectSrc: ["'self'", 'blob:', ...(ws ? [ws] : [])], // Socket.IO и playlist из blob: для hls.js
    fontSrc: ["'self'", 'data:'],
    frameSrc: ['https:'],                    // YouTube, Twitch и сторонние плееры; список заранее неизвестен
    workerSrc: ["'self'", 'blob:'],          // воркер hls.js
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],              // сайт нельзя встроить на чужую страницу
    reportUri: ['/api/csp-report'],
  };

  if (config.env === 'production' && MODE === 'enforce') directives.upgradeInsecureRequests = [];
  return directives;
}

function securityHeaders() {
  if (MODE === 'off') return (req, res, next) => next();

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildDirectives(),
      reportOnly: MODE !== 'enforce',
    },
    // YouTube-плееру нужен Referer: «no-referrer» из настроек helmet по умолчанию ломает встраивание
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 15552000, includeSubDomains: false }, // только на https; поддомены (live.) не трогаем
  });
}

module.exports = securityHeaders;