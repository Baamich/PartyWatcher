const mongoose = require('mongoose');

const streamChatMessageSchema = new mongoose.Schema(
  {
    streamerNameLower: { type: String, required: true, index: true },
    // у сообщений из API (боты, мосты) юзера нет — senderId = null
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    senderUsername: { type: String, required: true },
    // у «поделился серией просмотров» текст может быть пустым
    text: { type: String, required: function () { return !this.streak; }, default: '', maxlength: 500 },
    deleted: { type: Boolean, default: false },

    // ---- сообщения из API чата ----
    external: { type: Boolean, default: false },
    source: { type: String, default: null },
    nickColor: { type: String, default: null },
    raidViewers: { type: Number, default: undefined },
    highlight: { type: Boolean, default: undefined }, // выделенное сообщение (награда «Выделить сообщение»)
    streak: { type: Number, default: undefined }, // зритель поделился серией просмотров: сколько эфиров подряд (services/streaks)
    emotes: { type: mongoose.Schema.Types.Mixed, default: undefined }, // { code: id } смайлов в тексте (services/emotes) // source 'raid': сколько зрителей пришло (сайт пишет «Рейд от …» на языке зрителя)
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

streamChatMessageSchema.index({ streamerNameLower: 1, createdAt: 1 });

// сообщения чата хранятся 3 дня (условия п. 10, политика п. 5); «Очистить чат» удаляет сразу
streamChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

const StreamChatMessage = mongoose.model('StreamChatMessage', streamChatMessageSchema);

// раньше 3 дня жили только сообщения из API (partial-индекс с тем же именем): разово меняем его на общий
StreamChatMessage.init().catch(() => {}).then(async () => {
  const old = (await StreamChatMessage.collection.indexes()).find((i) => i.name === 'createdAt_1' && i.partialFilterExpression);
  if (!old) return;
  await StreamChatMessage.collection.dropIndex('createdAt_1');
  await StreamChatMessage.createIndexes();
  console.log('[mongo] stream chat: TTL 3 days for all messages');
}).catch((e) => console.warn('[mongo] stream chat TTL:', e.message));

module.exports = StreamChatMessage;