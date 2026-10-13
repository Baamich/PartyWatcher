const mongoose = require('mongoose');

// Посетитель за день (services/analytics.js): один документ на посетителя в сутки — повторные заходы
// не создают новых записей, только увеличивают счётчики. key — id устройства (cookie pw_dev) или хэш IP+браузера
const visitDaySchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // 'YYYY-MM-DD' (UTC)
    key: { type: String, required: true },
    firstAt: { type: Date },
    lastAt: { type: Date },
    hits: { type: Number }, // все запросы
    pages: { type: Number }, // открытые страницы
    api: { type: Number }, // запросы к /api
    ip: { type: String, default: '' },
    country: { type: String, default: '' }, // cf-ipcountry
    did: { type: String, default: '' },
    hw: { type: String, default: '' },
    type: { type: String, default: '' }, // desktop | mobile | tablet | bot
    os: { type: String, default: '' },
    browser: { type: String, default: '' },
    name: { type: String, default: '' }, // «Android 14 · SM-S918B · Chrome 141»
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    username: { type: String, default: '' },
  },
  { versionKey: false }
);

visitDaySchema.index({ day: 1, key: 1 }, { unique: true });
visitDaySchema.index({ lastAt: -1 });
visitDaySchema.index({ firstAt: 1 }, { expireAfterSeconds: 120 * 86400 }); // хранится 120 дней

module.exports = mongoose.model('VisitDay', visitDaySchema);
