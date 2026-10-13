const mongoose = require('mongoose');

// модератор канала: обычный (mod — следит за чатом) или высший (senior — ещё и управляет эфиром)
const channelModSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    level: { type: String, enum: ['mod', 'senior'], default: 'mod' },
    addedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

channelModSchema.index({ streamerNameLower: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ChannelMod', channelModSchema);
