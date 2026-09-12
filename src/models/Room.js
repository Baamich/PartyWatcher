const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    video: {
      type: { type: String, enum: ['youtube', 'twitch', 'vk', 'drive'], required: true },
      url: { type: String, required: true },
      title: { type: String },
    },
    isPublic: { type: Boolean, default: false }, // по умолчанию приватная (закрытый замок)
    playback: {
      isPlaying: { type: Boolean, default: false },
      positionSeconds: { type: Number, default: 0 },
      updatedAt: { type: Date, default: Date.now },
    },
    emptySince: { type: Date, default: null },
    bannedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Room', roomSchema);