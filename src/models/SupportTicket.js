const mongoose = require('mongoose');

// сообщение в переписке по обращению: ответ поддержки, письмо-уведомление или ответ пользователя на письмо
const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['user', 'support'], required: true },
    kind: { type: String, enum: ['reply', 'accepted', 'trivial', 'user'], required: true },
    text: { type: String, trim: true, maxlength: 5000, default: '' },
    author: { type: String, default: '' }, // ник админа, который ответил
    emailed: { type: Boolean, default: false }, // письмо ушло (SMTP настроен и не упал)
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
    source: { type: String, enum: ['site', 'email'], default: 'site' },
    subject: { type: String, trim: true, maxlength: 200, default: '' }, // тема письма (только для source=email)
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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: '' },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
