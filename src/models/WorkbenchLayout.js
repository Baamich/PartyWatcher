const mongoose = require('mongoose');

const workbenchLayoutSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    panels: { type: mongoose.Schema.Types.Mixed, default: null }, // { panelId: {x,y,w,h} }
    stats: { type: mongoose.Schema.Types.Mixed, default: null }, // страница статистики: { panels: {id: {x,y,w,h}}, shown: [id] }
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('WorkbenchLayout', workbenchLayoutSchema);