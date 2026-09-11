module.exports = {
  apps: [
    {
      name: 'partywatcher',
      script: 'src/server.js',
      instances: 2,
      exec_mode: 'cluster', // обязательно для zero-downtime pm2 reload
      env: { NODE_ENV: 'production' },
    },
  ],
};