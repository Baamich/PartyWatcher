const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    // описание хранится как есть: переносы строк и пробелы не трогаем
    body: { type: String, default: '', maxlength: 5000 },
    // картинка лежит отдельно (data:image/...;base64,...) и в списки не попадает — отдаётся через /news/:id/image
    image: { type: String, default: null, select: false },
    hasImage: { type: Boolean, default: false },
    authorUsername: { type: String, default: '' },
    publishedAt: { type: Date, default: Date.now, index: true },
    editedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

module.exports = mongoose.model('News', newsSchema);