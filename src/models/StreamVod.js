const mongoose = require('mongoose');

const streamVodSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    streamerNameLower: { type: String, required: true, index: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    /** относительный путь от MEDIA: vod/<userId>/<id>.mp4 */
    fileRel: { type: String, required: true },
    durationSec: { type: Number, default: 0 },
    published: { type: Boolean, default: false, index: true },
    status: {
      type: String,
      enum: ['recording', 'ready', 'failed'],
      default: 'recording',
    },
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { versionKey: false }
);

module.exports = mongoose.model('StreamVod', streamVodSchema);