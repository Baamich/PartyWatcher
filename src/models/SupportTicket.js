const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 12, default: '' },
    email: { type: String, trim: true, maxlength: 100, default: '' },
    // письма бывают длиннее формы на сайте (форма сама режет до 1000)
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    source: { type: String, enum: ['site', 'email'], default: 'site' },
    subject: { type: String, trim: true, maxlength: 200, default: '' }, // тема письма (только для source=email)
    status: {
      type: String,
      enum: ['unread', 'accepted', 'trivial'],
      default: 'unread',
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: '' },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model('SupportTicket', supportTicketSchema);