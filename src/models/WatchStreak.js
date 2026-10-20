const mongoose = require('mongoose');

// серия просмотров: сколько эфирных дней канала подряд зритель смотрел (services/streaks.js).
// День — по Москве (сброс в 24:00 МСК; эфир, начатый до полуночи, весь относится к своему дню).
// Запись без новых эфиров дольше 120 дней удаляется сама (серия к тому времени всё равно не продолжится)
const watchStreakSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    count: { type: Number, default: 0 },
    lastDay: { type: String, default: null }, // 'YYYY-MM-DD' (МСК) — последний засчитанный эфирный день
    sharedDay: { type: String, default: null }, // в этот день серией уже поделились (награда выдана)
    // серия прервалась: в этот день (brokenDay) можно восстановить прежнюю (lostCount) — 3 раза в месяц на канал
    brokenDay: { type: String, default: null },
    lostCount: { type: Number, default: 0 },
    restoreMonth: { type: String, default: null }, // 'YYYY-MM' (МСК)
    restoresUsed: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

watchStreakSchema.index({ streamerId: 1, userId: 1 }, { unique: true });
watchStreakSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 120 * 24 * 3600 });

module.exports = mongoose.model('WatchStreak', watchStreakSchema);
