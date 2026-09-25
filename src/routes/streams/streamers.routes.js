const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const auth = require('../../middleware/auth');

function validateStreamerName(name) {
  if (typeof name !== 'string') return 'Некорректное имя';
  const v = name.trim();
  if (!v) return 'Введите имя стримера';
  if (v.length < 3 || v.length > 32) return 'Имя: от 3 до 32 символов';
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Имя: только латиница, цифры и _';
  return null;
}

// GET /streamers?q=имя  — список стримеров, поиск без учёта регистра
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();

    const match = { $ne: null };
    if (q) {
      match.$regex = q;
      match.$options = 'i';
    }

    const streamers = await User.find({ streamerNameLower: match })
      .select('streamerName isLive -_id')
      .sort({ isLive: -1, streamerName: 1 })
      .lean();

    res.json(streamers);
  } catch (err) {
    console.error('[GET /streamers]', err);
    res.status(500).json({ error: 'Не удалось загрузить список стримеров' });
  }
});

// POST /streamers — создать имя стримера себе (один раз, пока имя ещё не занято этим юзером)
router.post('/', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(401).json({ error: 'Юзер не найден' });
    if (me.streamerName) return res.status(409).json({ error: 'Имя стримера уже задано' });

    const name = String(req.body.streamerName || '').trim();
    const err = validateStreamerName(name);
    if (err) return res.status(400).json({ error: err });

    const nameLower = name.toLowerCase();
    const taken = await User.findOne({ streamerNameLower: nameLower });
    if (taken) return res.status(409).json({ error: 'Это имя уже занято' });

    me.streamerName = name;
    me.streamerNameLower = nameLower;
    await me.save();

    res.status(201).json({ streamerName: me.streamerName });
  } catch (err) {
    console.error('[POST /streamers]', err);
    res.status(500).json({ error: 'Не удалось создать имя стримера' });
  }
});

// PATCH /streamers/me — редактирование своего профиля (баннер/аватар/описание)
router.patch('/me', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(401).json({ error: 'Юзер не найден' });
    if (!me.streamerName) return res.status(409).json({ error: 'Сначала создай имя стримера' });

    const { streamerBio, streamerAvatarUrl, streamerBannerUrl } = req.body;
    const MAX_IMAGE_CHARS = 6_000_000; // ~4 МБ картинки в base64

    if (streamerBio !== undefined) {
      if (String(streamerBio).length > 2000) {
        return res.status(400).json({ error: 'Описание слишком длинное (максимум 2000 символов)' });
      }
      me.streamerBio = String(streamerBio).trim();
    }

    if (streamerAvatarUrl !== undefined) {
      if (streamerAvatarUrl && streamerAvatarUrl.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ error: 'Аватар слишком большой (максимум ~4 МБ)' });
      }
      me.streamerAvatarUrl = streamerAvatarUrl || null;
    }

    if (streamerBannerUrl !== undefined) {
      if (streamerBannerUrl && streamerBannerUrl.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ error: 'Баннер слишком большой (максимум ~4 МБ)' });
      }
      me.streamerBannerUrl = streamerBannerUrl || null;
    }

    await me.save();

    res.json({
      streamerName: me.streamerName,
      streamerBio: me.streamerBio,
      streamerAvatarUrl: me.streamerAvatarUrl,
      streamerBannerUrl: me.streamerBannerUrl,
    });
  } catch (err) {
    console.error('[PATCH /streamers/me]', err);
    res.status(500).json({ error: 'Не удалось сохранить изменения' });
  }
});

// GET /streamers/:name — публичные данные одного стримера (регистр не важен)
router.get('/:name', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });

    const streamer = await User.findOne({ streamerNameLower: nameLower })
      .select('streamerName isLive streamerBio streamerAvatarUrl streamerBannerUrl -_id')
      .lean();

    if (!streamer) return res.status(404).json({ error: 'Стример не найден' });

    res.json(streamer);
  } catch (err) {
    console.error('[GET /streamers/:name]', err);
    res.status(500).json({ error: 'Не удалось загрузить профиль стримера' });
  }
});

module.exports = router;