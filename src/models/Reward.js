const mongoose = require('mongoose');

// награда канала за стрим-поинты. kind: custom — своя; highlight / coinflip / hello — стартовые со своим действием
const rewardSchema = new mongoose.Schema(
  {
    streamerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    streamerNameLower: { type: String, required: true },
    slug: { type: String, required: true }, // адрес в API: /api/rewards/<канал>/<slug>
    kind: { type: String, enum: ['custom', 'highlight', 'coinflip', 'hello'], default: 'custom' },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    cost: { type: Number, required: true },
    color: { type: String, default: '#7c3aed' },
    image: { type: String, default: null }, // 'media:<id>' — своя картинка (AlertMedia)
    needInput: { type: Boolean, default: false }, // зритель пишет текст при покупке
    reply: { type: String, default: '' }, // ответ бота в чат после покупки, с {переменными} (rewards.routes REPLY_VARS)
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

rewardSchema.index({ streamerId: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('Reward', rewardSchema);
