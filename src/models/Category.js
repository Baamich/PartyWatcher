const mongoose = require('mongoose');

// категория эфира (игра или «Just Chatting» и т.п.) — копия записи Twitch, создаётся, когда стример её выбрал.
// Обложка скачивается один раз и отдаётся зрителям с нашего сервера (/api/categories/:slug/cover)
const categorySchema = new mongoose.Schema(
  {
    tid: { type: String, required: true, unique: true }, // id категории в Twitch
    name: { type: String, required: true }, // оригинальное название (русское для неигровых — из словаря в services/categories.js)
    nameLower: { type: String, required: true, index: true },
    slug: { type: String, required: true, unique: true },
    cover: { type: Buffer, default: null },
    coverType: { type: String, default: null },
    hasCover: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Category', categorySchema);
