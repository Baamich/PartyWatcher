const mongoose = require('mongoose');

// стрим-поинты зрителя на канале: у каждого канала свой счёт
const channelPointsSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    balance: { type: Number, default: 0 },
    total: { type: Number, default: 0 }, // заработано за всё время (для события «накопил стрим-поинты»)
    lastClaimAt: { type: Date, default: null },
  },
  { versionKey: false }
);

channelPointsSchema.index({ streamerId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ChannelPoints', channelPointsSchema);
