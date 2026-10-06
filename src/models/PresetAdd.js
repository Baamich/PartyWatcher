const mongoose = require('mongoose');

const presetAddSchema = new mongoose.Schema(
  {
    presetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Preset', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    commandId: { type: mongoose.Schema.Types.ObjectId, default: null }, // команда, созданная этим добавлением
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

presetAddSchema.index({ presetId: 1, userId: 1 }, { unique: true }); // одно добавление с аккаунта
presetAddSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('PresetAdd', presetAddSchema);