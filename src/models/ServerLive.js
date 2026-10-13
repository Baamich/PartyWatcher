const mongoose = require('mongoose');

// Текущее состояние сервера (один документ _id 'main'): пишет процесс сайта раз в минуту,
// читает админка — в том числе отдельный админ-сервер, у которого своей памяти о сайте нет
const serverLiveSchema = new mongoose.Schema(
  {
    _id: { type: String },
    at: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    node: { type: String, default: '' },
    cores: { type: Number, default: 0 },
    cpuProc: { type: Number, default: 0 },
    cpuSys: { type: Number, default: 0 },
    load1: { type: Number, default: 0 },
    rss: { type: Number, default: 0 }, // МБ
    heap: { type: Number, default: 0 },
    memTotal: { type: Number, default: 0 },
    memFree: { type: Number, default: 0 },
    loopP99: { type: Number, default: 0 },
    sockets: { type: Number, default: 0 },
    // последние 6 часов по минутам: { t, p (cpu процесса), s (cpu сервера), r (rss) }
    minutes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { versionKey: false }
);

module.exports = mongoose.model('ServerLive', serverLiveSchema);
