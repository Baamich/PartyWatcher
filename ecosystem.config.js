module.exports = {
  apps: [
    {
      name: 'partywatcher',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'partywatcher-admin',
      script: 'src/admin-server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: { NODE_ENV: 'production' }, // ADMIN_PORT возьмётся из .env / дефолта 32800
    },
    {
      name: 'partywatcher-tunnel',
      script: 'scripts/start-tunnel.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: {
        TUNNEL_NAME: 'main',
        TUNNEL_LOCAL_URL: 'http://localhost:3000',
      },
    },
    {
      name: 'partywatcher-admin-tunnel',
      script: 'scripts/start-tunnel.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: {
        TUNNEL_NAME: 'admin',
        TUNNEL_LOCAL_URL: 'http://localhost:32800',
      },
    },
  ],
};