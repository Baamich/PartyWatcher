const mongoose = require('mongoose');

// кто хоть раз писал в чат канала — для события «новый зритель впервые написал в чат»
const channelSeenSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { versionKey: false }
);

channelSeenSchema.index({ streamerNameLower: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ChannelSeen', channelSeenSchema);
