const mongoose = require('mongoose');

// покупка награды: её видят бот стримера (API) и «Награды» в студии. Хранится 30 дней
const redemptionSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rewardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reward', required: true },
    rewardSlug: { type: String, required: true },
    rewardTitle: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    cost: { type: Number, required: true },
    message: { type: String, default: '' },
    status: { type: String, enum: ['new', 'done', 'refunded'], default: 'new' },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

redemptionSchema.index({ streamerId: 1, rewardSlug: 1, createdAt: -1 });
redemptionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('Redemption', redemptionSchema);
