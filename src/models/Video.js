const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }, // createdAt + UPLOAD_TTL_DAYS
  },
  { versionKey: false }
);

module.exports = mongoose.model('Video', videoSchema);