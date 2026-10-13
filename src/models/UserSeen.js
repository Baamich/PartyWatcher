const mongoose = require('mongoose');

// С каких IP и устройств заходил аккаунт (админка: просмотр и бан IP/устройства)
const userSeenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ip: { type: String, default: '' },
    did: { type: String, default: '' }, // id браузера (cookie pw_dev)
    hw: { type: String, default: '' }, // отпечаток железа
    name: { type: String, default: '' }, // «Windows 11 · Chrome 141»
    country: { type: String, default: '' },
    firstAt: { type: Date },
    lastAt: { type: Date },
    hits: { type: Number },
  },
  { versionKey: false }
);

userSeenSchema.index({ userId: 1, ip: 1, did: 1 }, { unique: true });
userSeenSchema.index({ ip: 1 });
userSeenSchema.index({ lastAt: 1 }, { expireAfterSeconds: 365 * 86400 });

module.exports = mongoose.model('UserSeen', userSeenSchema);
