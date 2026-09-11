const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true }, // короткий код для входа/поиска
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    video: {
      type: { type: String, enum: ['direct', 'youtube', 'upload'], required: true },
      url: { type: String, required: true }, // для upload — внутренний путь/эндпоинт
      title: { type: String },
    },
    playback: {
      isPlaying: { type: Boolean, default: false },
      positionSeconds: { type: Number, default: 0 },
      updatedAt: { type: Date, default: Date.now },
    },
    isPublic: { type: Boolean, default: true }, // видна ли в поиске
    createdAt: { type: Date, default: Date.now },
    emptySince: { type: Date, default: null },
  },
  { versionKey: false },
);

module.exports = mongoose.model('Room', roomSchema);