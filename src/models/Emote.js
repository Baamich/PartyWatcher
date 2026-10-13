const mongoose = require('mongoose');

// смайл канала: в чате пишется :code:. Смайлы канала — для его подписчиков; публичные (до 3 у стримера, без анимации) — всем
const emoteSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    streamerNameLower: { type: String, required: true },
    code: { type: String, required: true },
    codeLower: { type: String, required: true },
    isPublic: { type: Boolean, default: false },
    animated: { type: Boolean, default: false },
    mime: { type: String, required: true },
    data: { type: Buffer, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

emoteSchema.index({ streamerNameLower: 1, codeLower: 1 }, { unique: true });
// код публичного смайла один на весь сайт
emoteSchema.index({ codeLower: 1 }, { unique: true, partialFilterExpression: { isPublic: true } });

module.exports = mongoose.model('Emote', emoteSchema);
