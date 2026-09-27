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

module.exports = mongoose.model('ChannelActionLog', channelActionLogSchema);