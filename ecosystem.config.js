module.exports = {
  apps: [
    {
      name: 'partywatcher',
      script: 'src/server.js',
      instances: 1,        // было 2 — с socket.io без redis-адаптера это ломает синхронизацию комнат
      exec_mode: 'cluster', // для zero-downtime reload
      env: { NODE_ENV: 'production' },
    },
  ],
};