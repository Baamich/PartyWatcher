require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  adminPort: parseInt(process.env.ADMIN_PORT || '3001', 10),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,

  mongoUri: required('MONGO_URI'),

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxSizeMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '10240', 10),
    ttlDays: parseInt(process.env.UPLOAD_TTL_DAYS || '30', 10),
  },

  turn: {
    // Вариант 1 — свой coturn (HMAC-креды по времени, безопаснее и без лимитов)
    turnUrl: process.env.TURN_URL || null,           // например "turn.mydomain.com:3478"
    turnSecret: process.env.TURN_SECRET || null,      // static-auth-secret из turnserver.conf
    turnTtlSeconds: parseInt(process.env.TURN_TTL_SECONDS, 10) || 3600,

    // Вариант 2 — публичный/статичный TURN (например Open Relay Project) для быстрого старта
    staticTurnUrls: (process.env.TURN_STATIC_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    staticTurnUsername: process.env.TURN_STATIC_USERNAME || null,
    staticTurnCredential: process.env.TURN_STATIC_CREDENTIAL || null,
  },

  update: {
    repoUrl: process.env.GITHUB_REPO_URL,
    branch: process.env.GITHUB_BRANCH || 'main',
    accessToken: process.env.GITHUB_TOKEN, // тот же токен, что и для gist
    secretKey: process.env.UPDATE_SECRET_KEY,
    },

   drive: {
    apiKey: process.env.GOOGLE_DRIVE_API_KEY,
  },

  kodik: {
    token: process.env.KODIK_TOKEN || null, // без него поиск по названию выключен, работает только ссылка на плеер
    apiUrl: (process.env.KODIK_API_URL || 'https://kodik-api.com').replace(/\/+$/, ''),
    playerHost: process.env.KODIK_PLAYER_HOST || 'kodikplayer.com', // все ссылки на плеер приводятся к этому домену
  },

  // категории эфиров: поиск через Twitch API (игры из IGDB + неигровые категории). Без ключей выбор категории выключен
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || null,
    clientSecret: process.env.TWITCH_CLIENT_SECRET || null,
  },

  // Impressum (§ 18 Abs. 1 MStV — сайт бесплатный, некоммерческий): страница /impressum — имя и адрес, по которому
  // можно вручить письмо (не абонентский ящик; можно адрес сервиса «Impressum-Adresse»/c/o). В репозиторий не кладём
  imprint: {
    name: (process.env.IMPRINT_NAME || '').trim(),
    street: (process.env.IMPRINT_STREET || '').trim(),
    city: (process.env.IMPRINT_CITY || '').trim(), // «70173 Stuttgart»
    country: (process.env.IMPRINT_COUNTRY || 'Deutschland').trim(),
    email: (process.env.IMPRINT_EMAIL || process.env.SUPPORT_EMAIL || 'support@partywatcher.de').trim(),
    phone: (process.env.IMPRINT_PHONE || '').trim(), // необязательно: второй быстрый способ связи — сама почта + форма поддержки
  },
};