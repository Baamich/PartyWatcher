const mongoose = require('mongoose');

// виджеты канала для OBS (студия → ⏱️ Виджеты): до 20 штук, одна запись на стримера.
// Ссылка оверлея — по ключу событий (AlertSettings.key) и id виджета. Пишет services/widgets.js (с задержкой)
const channelWidgetsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    streamerNameLower: { type: String, required: true, index: true },
    widgets: { type: mongoose.Schema.Types.Mixed, default: [] }, // [{ id, type, name, slug, style, opts, state }] (widgets/catalog.js)
    layout: { type: mongoose.Schema.Types.Mixed, default: null }, // раскладка карточек в студии { panels }
    last: { type: mongoose.Schema.Types.Mixed, default: {} }, // последнее событие каждого вида { follow: { name, at }, reward: {…} } — для {last_…}
  },
  { versionKey: false, minimize: false }
);

module.exports = mongoose.model('ChannelWidgets', channelWidgetsSchema);
