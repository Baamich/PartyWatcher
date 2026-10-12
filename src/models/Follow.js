const mongoose = require('mongoose');

// подписка зрителя на канал стримера (одна на пару; счётчик — User.followersCount)
const followSchema = new mongoose.Schema(
  {
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

followSchema.index({ followerId: 1, streamerId: 1 }, { unique: true });
followSchema.index({ streamerId: 1, createdAt: -1 }); // подписчики канала, новые сверху

module.exports = mongoose.model('Follow', followSchema);
