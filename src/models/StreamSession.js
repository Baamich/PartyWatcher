const mongoose = require('mongoose');

// один завершённый эфир: из них считаются «Активные стримеры» (часы эфира за 30 дней). Старше 40 дней удаляются сами
const streamSessionSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    sec: { type: Number, required: true },
    categoryId: { type: String, default: null }, // Category.tid на момент конца эфира
    title: { type: String, default: '' },
    adult: { type: Boolean, default: false }, // эфир 18+ (категория с таким эфиром не идёт в поисковики)
    peakViewers: { type: Number, default: 0 },
    avgViewers: { type: Number, default: 0 }, // среднее по замерам раз в 30 с (без самого стримера)
    newFollowers: { type: Number, default: 0 }, // подписались за время эфира
    chatMessages: { type: Number, default: 0 }, // сообщений в чате за эфир (от людей, без ботов)
    chatters: { type: Number, default: 0 }, // сколько разных людей писали
  },
  { versionKey: false }
);

streamSessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 40 * 24 * 3600 });
streamSessionSchema.index({ streamerId: 1, endedAt: -1 });

module.exports = mongoose.model('StreamSession', streamSessionSchema);
