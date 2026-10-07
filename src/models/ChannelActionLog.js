const mongoose = require('mongoose');

const channelActionLogSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    actorUsername: { type: String, required: true },
    action: { type: String, required: true }, // 'clear_chat' | 'delete_message' | 'ban' | 'timeout'
    targetUsername: { type: String, default: null },
    details: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Mongo сам удаляет записи старше 7 дней (проверка раз в минуту)
channelActionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('ChannelActionLog', channelActionLogSchema);