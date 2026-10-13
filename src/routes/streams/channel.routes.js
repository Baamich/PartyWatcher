// /api/channel/:name — управление эфиром чужого канала для высшего модератора (со страницы стримера).
// Стример сам пользуется студией (/api/workbench); здесь — только то, что разрешено правами (services/channelMods)
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const mods = require('../../services/channelMods');
const categories = require('../../services/categories');
const Category = require('../../models/Category');
const User = require('../../models/User');
const chatBus = require('../../services/chatBus');

const nameOf = (req) => String(req.params.name || '').trim().toLowerCase();

// GET /channel/:name/settings — текущие название, описание, категория и что мне можно менять
router.get('/:name/settings', auth, async (req, res) => {
  const nameLower = nameOf(req);
  const { role, perms } = await mods.permsOf(nameLower, req.user.id);
  if (!perms.includes('editTitle') && !perms.includes('editCategory') && !perms.includes('raid')) {
    return res.status(403).json({ error: req.t('server.mods.forbidden') });
  }
  const s = await User.findOne({ streamerNameLower: nameLower }).select('streamTitle streamDescription streamCategoryId').lean();
  if (!s) return res.status(404).json({ error: req.t('server.streamers.notFound') });
  const cat = s.streamCategoryId ? await Category.findOne({ tid: s.streamCategoryId }).select('-cover').lean() : null;
  res.json({
    role,
    perms,
    streamTitle: s.streamTitle || '',
    streamDescription: s.streamDescription || '',
    category: categories.publicView(cat),
    categoriesEnabled: categories.enabled(),
  });
});

// PATCH /channel/:name/settings { streamTitle?, streamDescription?, streamCategoryId? } — по правам
router.patch('/:name/settings', auth, async (req, res) => {
  const nameLower = nameOf(req);
  const { perms } = await mods.permsOf(nameLower, req.user.id);
  const { streamTitle, streamDescription, streamCategoryId } = req.body || {};
  const set = {};
  if (streamTitle !== undefined || streamDescription !== undefined) {
    if (!perms.includes('editTitle')) return res.status(403).json({ error: req.t('server.mods.forbidden') });
    if (streamTitle !== undefined) {
      if (String(streamTitle).length > 140) return res.status(400).json({ error: req.t('server.wb.titleLong') });
      set.streamTitle = String(streamTitle).trim();
    }
    if (streamDescription !== undefined) {
      if (String(streamDescription).length > 2000) return res.status(400).json({ error: req.t('server.streamers.bioLong') });
      set.streamDescription = String(streamDescription).trim();
    }
  }
  let cat = null;
  if (streamCategoryId !== undefined) {
    if (!perms.includes('editCategory')) return res.status(403).json({ error: req.t('server.mods.forbidden') });
    if (streamCategoryId) {
      try {
        cat = await categories.ensure(streamCategoryId);
      } catch (e) {
        if (!e.i18nKey) console.error('[PATCH /channel/settings] категория', e);
        return res.status(400).json({ error: i18n.errText(req, e.i18nKey ? e : null, 'server.cat.searchFailed') });
      }
    }
    set.streamCategoryId = cat ? cat.tid : null;
  }
  if (!Object.keys(set).length) return res.json({ status: 'ok' });
  const prev = await User.findOneAndUpdate({ streamerNameLower: nameLower }, { $set: set }, { new: false })
    .select('streamTitle streamDescription streamCategoryId').lean();
  if (!prev) return res.status(404).json({ error: req.t('server.streamers.notFound') });
  // в журнал действий стримера — только то, что правда поменялось
  if (set.streamTitle !== undefined && set.streamTitle !== (prev.streamTitle || '')) chatBus.logAction(nameLower, req.user.username, 'edit_title', null, set.streamTitle);
  if (set.streamDescription !== undefined && set.streamDescription !== (prev.streamDescription || '')) chatBus.logAction(nameLower, req.user.username, 'edit_desc');
  if (set.streamCategoryId !== undefined && set.streamCategoryId !== (prev.streamCategoryId || null)) chatBus.logAction(nameLower, req.user.username, 'edit_category', null, cat ? cat.name : '');
  console.log(`[channel] ${req.user.username} изменил настройки эфира ${nameLower}:`, Object.keys(set).join(','));
  res.json({ status: 'ok', category: cat ? categories.publicView(cat) : undefined });
});

module.exports = router;
