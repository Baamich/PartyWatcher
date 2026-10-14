// Время (UTC) и уровень в начале каждой строки лога: «2026-10-14 10:49:25 WRN [tag] текст».
// По ним раздел «📜 Логи» админки (routes/adminLogs.routes.js) сортирует и фильтрует файлы логов pm2.
// Подключается первой строкой в server.js и admin-server.js
const LEVELS = { log: 'INF', info: 'INF', warn: 'WRN', error: 'ERR', debug: 'DBG' };

if (!console.__pwTime) {
  console.__pwTime = true;
  for (const [method, level] of Object.entries(LEVELS)) {
    const orig = console[method].bind(console);
    console[method] = (...args) => orig(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + level, ...args);
  }
}
