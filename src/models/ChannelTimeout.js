const mongoose = require('mongoose');

const channelTimeoutSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { versionKey: false }
);

channelTimeoutSchema.index({ streamerNameLower: 1, userId: 1 }, { unique: true });
channelTimeoutSchema.index({ until: 1 }, { expireAfterSeconds: 0 }); // Mongo удалит запись, когда время вышло

module.exports = mongoose.model('ChannelTimeout', channelTimeoutSchema);