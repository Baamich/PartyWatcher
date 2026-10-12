const mongoose = require('mongoose');

// один завершённый эфир: из них считаются «Активные стримеры» (часы эфира за 30 дней). Старше 40 дней удаляются сами
const streamSessionSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    sec: { type: Number, required: true },
    categoryId: { type: String, default: null }, // Category.tid на момент конца эфира
  },
  { versionKey: false }
);

streamSessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 40 * 24 * 3600 });
streamSessionSchema.index({ streamerId: 1, endedAt: -1 });

module.exports = mongoose.model('StreamSession', streamSessionSchema);
