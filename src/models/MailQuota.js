const mongoose = require('mongoose');

// счётчик отправленных писем (services/mailQuota.js): _id 'd:2026-10-14' — сутки (UTC), 'm:2026-10' — месяц.
// total — все письма, reg — письма подтверждения регистрации. Запись сама удаляется после exp
const mailQuotaSchema = new mongoose.Schema(
  {
    _id: { type: String },
    total: { type: Number },
    reg: { type: Number },
    exp: { type: Date },
  },
  { versionKey: false }
);
mailQuotaSchema.index({ exp: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('MailQuota', mailQuotaSchema);
