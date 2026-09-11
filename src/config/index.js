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

  update: {
    repoUrl: process.env.GITHUB_REPO_URL,
    branch: process.env.GITHUB_BRANCH || 'main',
    accessToken: process.env.GITHUB_TOKEN, // тот же токен, что и для gist
    secretKey: process.env.UPDATE_SECRET_KEY,
    },
};