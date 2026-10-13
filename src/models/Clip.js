const mongoose = require('mongoose');

// клип: последние ~30 с эфира, вырезанные зрителем или стримером (services/clips.js)
const clipSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    streamerNameLower: { type: String, required: true },
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    creatorName: { type: String, required: true },
    title: { type: String, default: '' },
    categoryId: { type: String, default: null },
    durationSec: { type: Number, default: 0 },
    fileRel: { type: String, required: true }, // clips/<streamerId>/<id>.mp4 (от media/)
    thumbRel: { type: String, default: null },
    views: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

clipSchema.index({ streamerNameLower: 1, createdAt: -1 });
clipSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('Clip', clipSchema);
