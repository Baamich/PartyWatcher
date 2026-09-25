const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    createdAt: { type: Date, default: Date.now },

    // ---- стример ----
    streamerName: { type: String, default: null, trim: true },
    streamerNameLower: { type: String, default: null, unique: true, sparse: true },
    isLive: { type: Boolean, default: false }, // TODO: пока заглушка, потом будет выставляться реальным трекером эфира
    streamerBio: { type: String, default: '' },
    streamerAvatarUrl: { type: String, default: null },
    streamerBannerUrl: { type: String, default: null },
  },
  { versionKey: false }
);

userSchema.pre('validate', function (next) {
  if (this.username) this.usernameLower = this.username.toLowerCase();
  if (this.streamerName) this.streamerNameLower = this.streamerName.toLowerCase();
  next();
});

module.exports = mongoose.model('User', userSchema);