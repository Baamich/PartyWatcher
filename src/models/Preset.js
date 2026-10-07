const mongoose = require('mongoose');

const presetSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['style', 'command'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    nameLower: { type: String, required: true },
    description: { type: String, default: '', maxlength: 200 },
    data: { type: mongoose.Schema.Types.Mixed, required: true }, // стиль или { name, response, args }
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    likes: { type: Number, default: 0, min: 0 },
    adds: { type: Number, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

presetSchema.pre('validate', function (next) {
  this.nameLower = String(this.name || '').toLowerCase();
  next();
});

presetSchema.index({ type: 1, likes: -1, createdAt: -1 });
presetSchema.index({ adds: -1, likes: -1 });
presetSchema.index({ createdAt: -1 });
presetSchema.index({ authorId: 1, createdAt: -1 });
presetSchema.index({ nameLower: 1 });

module.exports = mongoose.model('Preset', presetSchema);