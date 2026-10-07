const mongoose = require('mongoose');

const chatCommandSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 20 }, // без «!», в нижнем регистре
    response: { type: String, required: true, maxlength: 400 },
    enabled: { type: Boolean, default: true },
    args: {
      type: [{ _id: false, name: { type: String, required: true, maxlength: 15 }, optional: { type: Boolean, default: false } }],
      default: [],
    },
    uses: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

chatCommandSchema.index({ streamerNameLower: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('ChatCommand', chatCommandSchema);