const mongoose = require('mongoose');

// Посетитель «вообще»: когда впервые пришёл — для счёта новых посетителей (повторные не считаются)
const visitorSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    firstAt: { type: Date },
    lastAt: { type: Date },
    bot: { type: Boolean },
  },
  { versionKey: false }
);

visitorSchema.index({ firstAt: -1 });
visitorSchema.index({ lastAt: 1 }, { expireAfterSeconds: 365 * 86400 }); // не заходил год — забываем

module.exports = mongoose.model('Visitor', visitorSchema);
