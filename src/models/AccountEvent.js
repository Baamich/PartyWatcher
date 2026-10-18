const mongoose = require('mongoose');

// История аккаунта (services/accountLog.js): смены почты и логина, стрим-канал, пароль, главное устройство,
// запрос на удаление. Нужна, чтобы вернуть украденный аккаунт: админка показывает первую почту и все смены.
// Живёт, пока жив аккаунт (удаляется вместе с ним)
const accountEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // email | username | streamer | password | mainDevice | deleteRequest | deleteCancel
    type: { type: String, required: true },
    from: { type: String, default: '' }, // было (старая почта, старый логин)
    to: { type: String, default: '' }, // стало; у пароля — 'change' | 'reset'
    by: { type: String, default: '' }, // логин админа, если сделал он; пусто — сам человек
    ip: { type: String, default: '' },
    device: { type: String, default: '' }, // «Windows 11 · Chrome 141»
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

accountEventSchema.index({ userId: 1, at: 1 });

module.exports = mongoose.model('AccountEvent', accountEventSchema);
