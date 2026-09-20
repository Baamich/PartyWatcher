const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    video: {
      type: { 
        type: String, 
        enum: ['youtube', 'twitch', 'vk', 'drive', 'player_capture', 'direct'], 
        required: true 
      },
      url: { type: String, required: true },
      title: { type: String },
      ageRestricted: { type: Boolean, default: false },
      meta: {
        seasons: { type: [Number], default: [] },
        currentSeason: { type: Number, default: null },
        currentEpisode: { type: Number, default: null },
        voices: { type: [String], default: [] },
        currentVoice: { type: String, default: null },
      },
      ageConfirmed: { type: Boolean, default: false }, 
    },
    isPublic: { type: Boolean, default: false },
    thumbnailUrl: { type: String, default: null },
    playback: {
      isPlaying: { type: Boolean, default: false },
      positionSeconds: { type: Number, default: 0 },
      updatedAt: { type: Date, default: Date.now },
    },
    emptySince: { type: Date, default: null },
    viewerCount: { type: Number, default: 0 },
    bannedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Room', roomSchema);