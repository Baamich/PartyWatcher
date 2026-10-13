const mongoose = require('mongoose');

// свои файлы для алертов и наград: GIF/картинка (до 3 МБ) или звук (до 1 МБ)
const alertMediaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['image', 'sound'], required: true },
    name: { type: String, default: '' },
    mime: { type: String, required: true },
    data: { type: Buffer, required: true },
    size: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('AlertMedia', alertMediaSchema);
