const mongoose = require('mongoose');

// сообщение в переписке по обращению: ответ поддержки, письмо-уведомление или ответ пользователя на письмо
const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['user', 'support'], required: true },
    kind: { type: String, enum: ['reply', 'accepted', 'trivial', 'user'], required: true },
    text: { type: String, trim: true, maxlength: 5000, default: '' },
    author: { type: String, default: '' }, // ник админа, который ответил
    emailed: { type: Boolean, default: false }, // письмо ушло (SMTP настроен и не упал)
    site: { type: Boolean, default: undefined }, // через сайт: ответ — уведомлением и в профиле, сообщение человека — из профиля
    fallback: { type: String, default: undefined }, // хотел письмом, но не ушло: mailLimit (лимит писем) | mailFailed — ушло на сайт
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    number: { type: Number, unique: true, sparse: true }, // номер обращения для людей: #123
    name: { type: String, trim: true, maxlength: 12, default: '' },
    email: { type: String, trim: true, maxlength: 100, default: '' },
    // письма бывают длиннее формы на сайте (форма сама режет до 1000)
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    source: { type: String, enum: ['site', 'email', 'stream', 'preset'], default: 'site' }, // stream|preset — 🚩 жалоба на эфир|пре-сет
    // жалоба на эфир: на кого, причина, название эфира и шёл ли эфир в момент жалобы
    report: {
      streamer: { type: String, default: undefined },
      reason: { type: String, default: undefined },
      title: { type: String, default: undefined },
      live: { type: Boolean, default: undefined },
      // жалоба на пре-сет: какой (снимок на момент жалобы) и удалил ли его админ из обращения
      preset: {
        id: { type: String, default: undefined },
        name: { type: String, default: undefined },
        type: { type: String, default: undefined },
        author: { type: String, default: undefined },
        deleted: { type: Boolean, default: undefined },
      },
      // запись последних ~30 с эфира (services/clips.js createEvidence): pending → ready (id файла, секунды) | failed
      clip: {
        id: { type: String, default: undefined },
        status: { type: String, enum: ['pending', 'ready', 'failed'], default: undefined },
        sec: { type: Number, default: undefined },
      },
    },
    subject: { type: String, trim: true, maxlength: 200, default: '' }, // тема письма (только для source=email)
    files: { type: [mongoose.Schema.Types.ObjectId], default: undefined }, // скриншоты (SupportFile, до 5, живут 90 дней)
    lang: { type: String, enum: ['ru', 'en'], default: 'ru' }, // язык писем этому человеку
    status: {
      type: String,
      enum: ['unread', 'accepted', 'trivial', 'answered'],
      default: 'unread',
    },
    hasNewReply: { type: Boolean, default: false }, // человек ответил на наше письмо, а мы ещё не посмотрели
    messages: { type: [messageSchema], default: [] },
    // Message-ID писем этой переписки (входящих и наших): по ним ответ человека находит свой тикет
    mailIds: { type: [String], default: [] },
    // заявка из профиля: emailChange — сменить почту (лимит писем исчерпан), deletion — удалить аккаунт
    request: {
      kind: { type: String, default: undefined },
      from: { type: String, default: undefined },
      to: { type: String, default: undefined },
      deleteAt: { type: Date, default: undefined },
      logs: { type: mongoose.Schema.Types.Mixed, default: undefined }, // снимок «что делал за сутки до запроса» (живёт 30 дней после удаления)
      cancelled: { type: Boolean, default: undefined }, // вошёл с паролем — удаление отменено
      done: { type: Boolean, default: undefined }, // аккаунт удалён
      doneAt: { type: Date, default: undefined },
      doneBy: { type: String, default: undefined }, // админ, если удалил раньше срока
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: '' },
    userSeenAt: { type: Date, default: undefined }, // человек открыл переписку в профиле → «Поддержка» (новее — «новый ответ»)
  },
  { versionKey: false, timestamps: true }
);

// админка: вкладки по статусу и «🚩 Жалобы» по источнику, свежие сверху
supportTicketSchema.index({ status: 1, updatedAt: -1 });
supportTicketSchema.index({ source: 1, updatedAt: -1 });
supportTicketSchema.index({ userId: 1, updatedAt: -1 }, { partialFilterExpression: { userId: { $type: 'objectId' } } }); // профиль → «Поддержка»

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
