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
};