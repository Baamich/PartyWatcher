module.exports = {
  apps: [
    {
      name: 'partywatcher',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'cluster', // для zero-downtime pm2 reload
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'partywatcher-tunnel',
      script: 'scripts/start-tunnel.js',
      instances: 1,
      exec_mode: 'fork', // это не веб-сервер,  кластер тут не нужен
      autorestart: true, // если cloudflared упадёт — PM2 перезапустит
    },
  ],
}; 