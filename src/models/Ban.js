const mongoose = require('mongoose');

// Бан по IP или устройству (services/bans.js держит их в памяти). Бан аккаунта — поля ban* у User
const banSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['ip', 'did', 'hw'], required: true }, // did — браузер, hw — отпечаток железа
    value: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null }, // чей это был IP/устройство
    username: { type: String, default: '' },
    name: { type: String, default: '' }, // название устройства на момент бана
    reason: { type: String, default: '' },
    by: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    until: { type: Date, default: null }, // null — навсегда
  },
  { versionKey: false }
);

banSchema.index({ kind: 1, value: 1 }, { unique: true });
banSchema.index({ at: -1 });

module.exports = mongoose.model('Ban', banSchema);
