const mongoose = require('mongoose');

// Админка → 🕵️ Обнаружение: совпадение, которое админ пометил «Игнорировать». users — отсортированные id
// аккаунтов на момент решения: появится ещё один аккаунт с тем же IP/устройством — совпадение покажется снова
const detectIgnoreSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['ip', 'did', 'hw'], required: true },
    value: { type: String, required: true },
    users: { type: String, required: true },
    by: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

detectIgnoreSchema.index({ kind: 1, value: 1 }, { unique: true });

module.exports = mongoose.model('DetectIgnore', detectIgnoreSchema);
