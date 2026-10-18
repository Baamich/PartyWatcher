const mongoose = require('mongoose');

// Сеанс входа (профиль → «Устройства», services/sessions.js): одна запись на вход с устройства.
// id сеанса (sid) зашит в JWT; удалили запись — токен больше не принимается. Запись сама исчезает,
// когда истекает токен (TTL-индекс по expiresAt)
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    sid: { type: String, required: true, unique: true },
    tv: { type: Number, default: 0 }, // tokenVersion на момент входа: сменился (пароль, бан) — сеанс мёртв
    did: { type: String, default: '' }, // id браузера (cookie pw_dev) — по нему узнаём главное устройство
    device: { type: String, default: '' }, // «Windows 11 · Chrome 141»
    ip: { type: String, default: '' },
    country: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now }, // обновляется не чаще раза в час
    expiresAt: { type: Date, required: true },
    // сеанс из старого токена (без sid): iat того токена. Завершённый такой сеанс не удаляем, а помечаем revoked —
    // иначе старый токен завёл бы новый сеанс
    legacyIat: { type: Number, default: undefined },
    revoked: { type: Boolean, default: undefined },
  },
  { versionKey: false }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, legacyIat: 1 }, { sparse: true });

module.exports = mongoose.model('Session', sessionSchema);
