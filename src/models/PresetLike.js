const mongoose = require('mongoose');

const presetLikeSchema = new mongoose.Schema(
  {
    presetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Preset', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

presetLikeSchema.index({ presetId: 1, userId: 1 }, { unique: true }); // один лайк с аккаунта
presetLikeSchema.index({ userId: 1 });

module.exports = mongoose.model('PresetLike', presetLikeSchema);