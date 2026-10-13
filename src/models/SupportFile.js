const mongoose = require('mongoose');

// скриншот к обращению (поддержка, 🚩 жалоба на эфир): до 5 на обращение, видит только админ.
// Живёт 90 дней (TTL) — дольше доказательства не нужны, а там могут быть чужие данные
const supportFileSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket', required: true, index: true },
    mime: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
    data: { type: Buffer, required: true }, // до 1 МБ
    createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('SupportFile', supportFileSchema);
