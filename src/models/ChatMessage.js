const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
    username: { type: String, required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

chatMessageSchema.index({ room: 1, createdAt: 1 });
// чат комнаты хранится 3 дня (условия п. 10, политика п. 5), с удалением комнаты — сразу; показывается только последний час
chatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);