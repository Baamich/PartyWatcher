const mongoose = require('mongoose');

const streamChatMessageSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderUsername: { type: String, required: true },
    text: { type: String, required: true, maxlength: 500 },
    deleted: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

streamChatMessageSchema.index({ streamerNameLower: 1, createdAt: 1 });

module.exports = mongoose.model('StreamChatMessage', streamChatMessageSchema);