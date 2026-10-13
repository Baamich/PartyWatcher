const mongoose = require('mongoose');

// Нагрузка сервера по часам (services/analytics.js дописывает раз в минуту через $inc/$max).
// У счётчиков нет default: при upsert Mongoose добавил бы их в $setOnInsert — конфликт с $inc того же поля
const serverStatSchema = new mongoose.Schema(
  {
    hour: { type: Date, required: true }, // начало часа (UTC)
    req: { type: Number }, // все запросы (без статики и сокетов)
    pages: { type: Number }, // открытые страницы
    api: { type: Number },
    s4: { type: Number }, // ответы 4xx
    s5: { type: Number }, // ответы 5xx
    durSum: { type: Number }, // сумма времени ответа /api, мс
    durN: { type: Number },
    groups: { type: mongoose.Schema.Types.Mixed }, // /api/<раздел> → число
    paths: { type: mongoose.Schema.Types.Mixed }, // страница → число (точки заменены на ．)
    cpuProcSum: { type: Number }, // % процесса сайта от всех ядер
    cpuSysSum: { type: Number }, // % всего сервера (ffmpeg, Chromium — тоже)
    cpuN: { type: Number },
    cpuProcMax: { type: Number },
    cpuSysMax: { type: Number },
    rssSum: { type: Number }, // МБ
    rssMax: { type: Number },
    loopMax: { type: Number }, // p99 задержки event loop, мс
    sockMax: { type: Number }, // открытых сокетов
  },
  { versionKey: false, minimize: false }
);

serverStatSchema.index({ hour: 1 }, { unique: true, expireAfterSeconds: 120 * 86400 }); // хранится 120 дней

module.exports = mongoose.model('ServerStat', serverStatSchema);
