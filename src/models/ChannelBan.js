const mongoose = require('mongoose');

const channelBanSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    bannedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

channelBanSchema.index({ streamerNameLower: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ChannelBan', channelBanSchema);