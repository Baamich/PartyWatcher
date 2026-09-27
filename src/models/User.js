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
    streamerName: { type: String, default: undefined, trim: true },
    streamerNameLower: { type: String, default: undefined, unique: true, sparse: true },
    isLive: { type: Boolean, default: false },
    liveStartedAt: { type: Date, default: null },
    streamerBio: { type: String, default: '' },
    streamerAvatarUrl: { type: String, default: null },
    streamerBannerUrl: { type: String, default: null },
    profileViews: { type: Number, default: 0 },

    // ---- творческая студия ----
    streamTitle: { type: String, default: '' },
    streamDescription: { type: String, default: '' },
    streamKey: { type: String, default: undefined, unique: true, sparse: true },
    streamPlaybackId: { type: String, default: undefined, unique: true, sparse: true },
  },
  { versionKey: false }
);

userSchema.pre('validate', function (next) {
  if (this.username) {
    this.usernameLower = this.username.toLowerCase();
  }

  if (this.streamerName) {
    this.streamerNameLower = this.streamerName.toLowerCase();
  } else {
    this.streamerNameLower = undefined;
  }

  next();
});

module.exports = mongoose.model('User', userSchema);