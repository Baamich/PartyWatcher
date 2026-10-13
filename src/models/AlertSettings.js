const mongoose = require('mongoose');

// настройки алертов канала (студия → 🔔 События) и ключ оверлея/API событий
const alertSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    streamerNameLower: { type: String, required: true, index: true },
    key: { type: String, default: undefined, unique: true, sparse: true }, // /overlay/alerts.html?key=… и API для ботов
    events: { type: mongoose.Schema.Types.Mixed, default: {} }, // { eventId: настройки (alerts/catalog.js cleanEvent) }
    layout: { type: mongoose.Schema.Types.Mixed, default: null }, // раскладка карточек на странице { panels }
    rewardsLayout: { type: mongoose.Schema.Types.Mixed, default: null }, // раскладка карточек «Наград»
    followGoalMax: { type: Number, default: 0 }, // самый большой рубеж подписчиков, о котором уже был алерт
  },
  { versionKey: false }
);

module.exports = mongoose.model('AlertSettings', alertSettingsSchema);
