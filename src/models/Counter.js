const mongoose = require('mongoose');

// Счётчики для последовательных номеров (например, номер обращения в поддержку)
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

counterSchema.statics.next = async function next(name) {
  const doc = await this.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true }).lean();
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
