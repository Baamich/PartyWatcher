// Диагностика скорости сервера (дёшево, всегда включено):
//  - Server-Timing: app;dur=<мс> в HTTP-ответах (кроме /api/auth) — в DevTools (Network → Timing) видно, сколько
//    запрос считался на сервере, а сколько ушло на дорогу (туннель, Cloudflare);
//  - задержка event loop: раз в минуту, если p99 > 100 мс, — строка [perf] в логе (значит, процесс
//    чем-то занят синхронно и все запросы ждут).
const { monitorEventLoopDelay } = require('perf_hooks');

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const lastLoop = { p99: 0, max: 0 }; // за прошлую минуту — для статистики админки (analytics.js)
setInterval(() => {
  const p99 = loop.percentile(99) / 1e6;
  lastLoop.p99 = Math.round(p99);
  lastLoop.max = Math.round(loop.max / 1e6);
  if (p99 > 100) {
    const mem = process.memoryUsage();
    console.warn(`[perf] event loop: p99 ${p99.toFixed(0)} мс, max ${(loop.max / 1e6).toFixed(0)} мс; rss ${(mem.rss / 1048576).toFixed(0)} МБ, heap ${(mem.heapUsed / 1048576).toFixed(0)} МБ`);
  }
  loop.reset();
}, 60 * 1000).unref();

function serverTiming(req, res, next) {
  // вход/регистрация/сброс пароля — без него: точное время обработки помогло бы угадывать, есть ли такой аккаунт
  if (req.path.startsWith('/api/auth/')) return next();
  const t0 = process.hrtime.bigint();
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) {
      res.setHeader('Server-Timing', 'app;dur=' + (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1));
    }
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = { serverTiming, loopStats: () => ({ ...lastLoop }) };
