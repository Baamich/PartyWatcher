const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const auth = require('../../middleware/auth');
const PWLayout = require('../../public/js/pwlayout.js');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 64);

function validateStreamerName(name) {
  if (typeof name !== 'string') return 'Некорректное имя';
  const v = name.trim();
  if (!v) return 'Введите имя стримера';
  if (v.length < 3 || v.length > 32) return 'Имя: от 3 до 32 символов';
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Имя: только латиница, цифры и _';
  return null;
}

// GET /streamers?q=имя&limit=5  — список стримеров, поиск без учёта регистра
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 0, 50) || null;

    const match = { $ne: null };
    if (q) {
      match.$regex = escapeRegex(q);
      match.$options = 'i';
    }

    let query = User.find({ streamerNameLower: match })
      .select('streamerName isLive profileViews streamerAvatarUrl -_id')
      // при поиске сначала эфир, потом чаще открываемые профили, потом по алфавиту
      .sort({ isLive: -1, profileViews: -1, streamerName: 1 });

    if (limit) query = query.limit(limit);

    const streamers = await query.lean();
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

    const IMAGE_DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

    if (streamerAvatarUrl !== undefined) {
      if (streamerAvatarUrl) {
        if (typeof streamerAvatarUrl !== 'string' || !IMAGE_DATA_RE.test(streamerAvatarUrl)) {
          return res.status(400).json({ error: 'Аватар: нужна картинка PNG, JPEG, WebP или GIF' });
        }
        if (streamerAvatarUrl.length > MAX_IMAGE_CHARS) {
          return res.status(400).json({ error: 'Аватар слишком большой (максимум ~4 МБ)' });
        }
      }
      me.streamerAvatarUrl = streamerAvatarUrl || null;
    }

    if (streamerBannerUrl !== undefined) {
      if (streamerBannerUrl) {
        if (typeof streamerBannerUrl !== 'string' || !IMAGE_DATA_RE.test(streamerBannerUrl)) {
          return res.status(400).json({ error: 'Баннер: нужна картинка PNG, JPEG, WebP или GIF' });
        }
        if (streamerBannerUrl.length > MAX_IMAGE_CHARS) {
          return res.status(400).json({ error: 'Баннер слишком большой (максимум ~4 МБ)' });
        }
      }
      me.streamerBannerUrl = streamerBannerUrl || null;
    }

    me.profileRev = Date.now();
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

// PUT /streamers/me/layout — сохранить PRO-макет (layout: null — сброс)
router.put('/me/layout', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select('streamerName');
    if (!me) return res.status(401).json({ error: 'Юзер не найден' });
    if (!me.streamerName) return res.status(409).json({ error: 'Сначала создай имя стримера' });
    if (req.body.layout === undefined) return res.status(400).json({ error: 'Нет макета' });

    let layout;
    try {
      layout = PWLayout.sanitize(req.body.layout);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await User.updateOne({ _id: me._id }, { $set: { profileLayout: layout, profileRev: Date.now() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /streamers/me/layout]', err);
    res.status(500).json({ error: 'Не удалось сохранить макет' });
  }
});

// GET /streamers/:name/layout — публичный макет (без +1 просмотра)
router.get('/:name/layout', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });
    const s = await User.findOne({ streamerNameLower: nameLower }).select('profileLayout -_id').lean();
    if (!s) return res.status(404).json({ error: 'Стример не найден' });
    res.json({ layout: s.profileLayout || null });
  } catch (err) {
    console.error('[GET /streamers/:name/layout]', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /streamers/:name/bundle?rev=N — профиль + макет одним запросом.
// Если rev совпал с текущим, тяжёлое (аватар, баннер, макет) не отправляем.
router.get('/:name/bundle', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });

    const s = await User.findOneAndUpdate(
      { streamerNameLower: nameLower },
      { $inc: { profileViews: 1 } },
      { new: true }
    )
      .select('streamerName isLive streamPlaybackId profileRev')
      .lean();
    if (!s) return res.status(404).json({ error: 'Стример не найден' });

    const rev = s.profileRev || 0;
    const light = {
      rev,
      streamerName: s.streamerName,
      isLive: !!s.isLive,
      streamPlaybackId: s.streamPlaybackId || null,
    };

    const clientRev = req.query.rev === undefined ? NaN : Number(req.query.rev);
    if (clientRev === rev) return res.json({ ...light, unchanged: true });

    const heavy = await User.findById(s._id)
      .select('streamerBio streamerAvatarUrl streamerBannerUrl profileLayout -_id')
      .lean();

    res.json({
      ...light,
      streamerBio: heavy?.streamerBio || '',
      streamerAvatarUrl: heavy?.streamerAvatarUrl || null,
      streamerBannerUrl: heavy?.streamerBannerUrl || null,
      layout: heavy?.profileLayout || null,
    });
  } catch (err) {
    console.error('[GET /streamers/:name/bundle]', err);
    res.status(500).json({ error: 'Не удалось загрузить профиль стримера' });
  }
});

const StreamVod = require('../../models/StreamVod');

// GET /streamers/:name/vods — только опубликованные и не истёкшие
router.get('/:name/vods', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });

    const vods = await StreamVod.find({
      streamerNameLower: nameLower,
      published: true,
      status: 'ready',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('title description fileRel createdAt durationSec')
      .lean();

    res.json(
      vods.map((v) => ({
        id: v._id,
        title: v.title,
        description: v.description,
        createdAt: v.createdAt,
        durationSec: v.durationSec,
        url: `/media/${v.fileRel}`,
      }))
    );
  } catch (err) {
    console.error('[GET /streamers/:name/vods]', err);
    res.status(500).json({ error: 'Не удалось загрузить записи' });
  }
});

// GET /streamers/:name/live-status — только isLive + playbackId, без +1 просмотра
router.get('/:name/live-status', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });

    const streamer = await User.findOne({ streamerNameLower: nameLower })
      .select('isLive streamPlaybackId -_id')
      .lean();

    if (!streamer) return res.status(404).json({ error: 'Стример не найден' });
    res.json(streamer);
  } catch (err) {
    console.error('[GET /streamers/:name/live-status]', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /streamers/:name — публичные данные одного стримера (регистр не важен)
router.get('/:name', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: 'Не указано имя стримера' });

    const streamer = await User.findOneAndUpdate(
      { streamerNameLower: nameLower },
      { $inc: { profileViews: 1 } },
      { new: true }
    )
      .select('streamerName isLive streamerBio streamerAvatarUrl streamerBannerUrl streamPlaybackId -_id')
      .lean();

    if (!streamer) return res.status(404).json({ error: 'Стример не найден' });

    res.json(streamer);
  } catch (err) {
    console.error('[GET /streamers/:name]', err);
    res.status(500).json({ error: 'Не удалось загрузить профиль стримера' });
  }
});


module.exports = router;