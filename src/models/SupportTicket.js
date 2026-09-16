const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 12, default: '' },
    email: { type: String, trim: true, maxlength: 26, default: '' },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
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