const mongoose = require('mongoose');

const streamChatMessageSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    // у сообщений из API (боты, мосты) юзера нет — senderId = null
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    senderUsername: { type: String, required: true },
    text: { type: String, required: true, maxlength: 500 },
    deleted: { type: Boolean, default: false },

    // ---- сообщения из API чата ----
    external: { type: Boolean, default: false },
    source: { type: String, default: null },
    nickColor: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

streamChatMessageSchema.index({ streamerNameLower: 1, createdAt: 1 });

// сообщения из API (боты, мосты) хранятся 3 дня, чтобы база не пухла от спама
streamChatMessageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 3 * 24 * 60 * 60, partialFilterExpression: { external: true } }
);

module.exports = mongoose.model('StreamChatMessage', streamChatMessageSchema);