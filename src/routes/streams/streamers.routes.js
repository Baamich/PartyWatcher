const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const auth = require('../../middleware/auth');
const i18n = require('../../services/i18n');
const { hasProfanity } = require('../../services/profanity');
const PWLayout = require('../../public/js/pwlayout.js');
const categories = require('../../services/categories');
const { isAdultStream, seesAdultStreams } = require('../../services/adultContent');
const { BOT_RE } = require('../../services/clientInfo');

// название и категория идущего эфира (для плашки над плеером и строки под именем)
async function liveInfo(s) {
  if (!s.isLive) return { title: '', category: null };
  return { title: s.streamTitle || '', category: await categories.viewByTid(s.streamCategoryId).catch(() => null) };
}

const Follow = require('../../models/Follow');
const accountLog = require('../../services/accountLog');
const rateLimit = require('express-rate-limit');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 64);

// адрес аватара/баннера картинкой; v = profileRev — новая картинка получает новый адрес, старую браузер держит в кэше.
// В базе они остаются base64, но в ответах профиля — только адреса: bundle не тащит мегабайты на каждое открытие
const imageUrl = (kind) => (nameLower, rev) => `/api/streamers/${encodeURIComponent(nameLower)}/${kind}?v=${Number(rev) || 0}`;
const avatarUrl = imageUrl('avatar');
const bannerUrl = imageUrl('banner');
const IMAGE_FIELDS = { avatar: 'streamerAvatarUrl', banner: 'streamerBannerUrl' };

// раскодированные аватары и баннеры в памяти: повторный запрос не тянет из базы строку base64 (до ~30 МБ на всё)
const AVATAR_CACHE_MAX = 30 * 1024 * 1024;
const avatarCache = new Map(); // 'avatar:'|'banner:' + nameLower → { rev, type, buf }
let avatarCacheBytes = 0;
function avatarCachePut(key, entry) {
  const old = avatarCache.get(key);
  if (old) { avatarCacheBytes -= old.buf.length; avatarCache.delete(key); }
  if (entry.buf.length > AVATAR_CACHE_MAX / 4) return; // огромные не кэшируем
  avatarCache.set(key, entry);
  avatarCacheBytes += entry.buf.length;
  for (const [k, v] of avatarCache) {
    if (avatarCacheBytes <= AVATAR_CACHE_MAX) break;
    avatarCache.delete(k);
    avatarCacheBytes -= v.buf.length;
  }
}

// есть ли аватар/баннер — без чтения самих строк base64 из базы (для $project)
const hasImages = {
  hasAvatar: { $gt: [{ $strLenBytes: { $ifNull: ['$streamerAvatarUrl', ''] } }, 0] },
  hasBanner: { $gt: [{ $strLenBytes: { $ifNull: ['$streamerBannerUrl', ''] } }, 0] },
};
const imageUrls = (nameLower, rev, h) => ({
  streamerAvatarUrl: h?.hasAvatar ? avatarUrl(nameLower, rev) : null,
  streamerBannerUrl: h?.hasBanner ? bannerUrl(nameLower, rev) : null,
});

// подписка/отписка: по аккаунту, 30 в минуту
const followLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.user.id),
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: req.t('server.follow.tooMany') }),
});

function validateStreamerName(name) {
  // возвращает ключ словаря ошибки (перевод — req.t) или null
  if (typeof name !== 'string') return 'server.streamers.badName';
  const v = name.trim();
  if (!v) return 'server.streamers.nameEmpty';
  if (v.length < 3 || v.length > 32) return 'server.streamers.nameLen';
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'server.streamers.nameChars';
  return null;
}

// GET /streamers?q=имя&limit=5  — список стримеров, поиск без учёта регистра.
// Эфир 18+ видят только подтвердившие возраст (как в каталоге, ?adult=1 — для гостя)
router.get('/', auth.optional, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 0, 50) || null;

    const match = { $ne: null };
    if (q) {
      match.$regex = escapeRegex(q);
      match.$options = 'i';
    }

    // аватары (base64, до нескольких МБ) в список не кладём: только адрес картинки, браузер грузит её отдельно и кэширует
    const pipeline = [
      { $match: { streamerNameLower: match } },
      {
        $project: {
          _id: 0, streamerName: 1, streamerNameLower: 1, isLive: 1, profileViews: 1, profileRev: 1, streamAdult: 1, streamTitle: 1,
          hasAvatar: { $gt: ['$streamerAvatarUrl', null] },
        },
      },
      // при поиске сначала эфир, потом чаще открываемые профили, потом по алфавиту
      { $sort: { isLive: -1, profileViews: -1, streamerName: 1 } },
    ];
    if (limit) pipeline.push({ $limit: limit });

    const [rows, seesAdult] = await Promise.all([User.aggregate(pipeline), seesAdultStreams(req)]);
    const out = [];
    for (const s of rows) {
      const adult = !!s.isLive && isAdultStream(s);
      if (adult && !seesAdult) continue;
      out.push({
        streamerName: s.streamerName,
        isLive: !!s.isLive,
        avatarUrl: s.hasAvatar ? avatarUrl(s.streamerNameLower, s.profileRev) : null,
        ...(adult && { adult: true }),
      });
    }
    res.json(out);
  } catch (err) {
    console.error('[GET /streamers]', err);
    res.status(500).json({ error: req.t('server.streamers.listFailed') });
  }
});

// POST /streamers — создать имя стримера себе (один раз, пока имя ещё не занято этим юзером)
router.post('/', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(401).json({ error: req.t('server.userNotFound') });
    if (me.streamerName) return res.status(409).json({ error: req.t('server.streamers.nameSet') });

    const name = String(req.body.streamerName || '').trim();
    const err = validateStreamerName(name);
    if (err) return res.status(400).json({ error: req.t(err) });
    if (hasProfanity(name)) return res.status(400).json({ error: req.t('server.streamers.nameBad') });

    const nameLower = name.toLowerCase();
    const taken = await User.findOne({ streamerNameLower: nameLower });
    if (taken) return res.status(409).json({ error: req.t('server.streamers.nameTaken') });

    me.streamerName = name;
    me.streamerNameLower = nameLower;
    await me.save();
    accountLog.record(me._id, 'streamer', { to: name }, req);

    res.status(201).json({ streamerName: me.streamerName });
  } catch (err) {
    console.error('[POST /streamers]', err);
    res.status(500).json({ error: req.t('server.streamers.createFailed') });
  }
});

// PATCH /streamers/me — редактирование своего профиля (баннер/аватар/описание)
router.patch('/me', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(401).json({ error: req.t('server.userNotFound') });
    if (!me.streamerName) return res.status(409).json({ error: req.t('server.streamers.createFirst') });

    const { streamerBio, streamerAvatarUrl, streamerBannerUrl } = req.body;
    const MAX_IMAGE_CHARS = 6_000_000; // ~4 МБ картинки в base64

    if (streamerBio !== undefined) {
      if (String(streamerBio).length > 2000) {
        return res.status(400).json({ error: req.t('server.streamers.bioLong') });
      }
      me.streamerBio = String(streamerBio).trim();
    }

    const IMAGE_DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

    if (streamerAvatarUrl !== undefined) {
      if (streamerAvatarUrl) {
        if (typeof streamerAvatarUrl !== 'string' || !IMAGE_DATA_RE.test(streamerAvatarUrl)) {
          return res.status(400).json({ error: req.t('server.streamers.avatarType') });
        }
        if (streamerAvatarUrl.length > MAX_IMAGE_CHARS) {
          return res.status(400).json({ error: req.t('server.streamers.avatarBig') });
        }
      }
      me.streamerAvatarUrl = streamerAvatarUrl || null;
    }

    if (streamerBannerUrl !== undefined) {
      if (streamerBannerUrl) {
        if (typeof streamerBannerUrl !== 'string' || !IMAGE_DATA_RE.test(streamerBannerUrl)) {
          return res.status(400).json({ error: req.t('server.streamers.bannerType') });
        }
        if (streamerBannerUrl.length > MAX_IMAGE_CHARS) {
          return res.status(400).json({ error: req.t('server.streamers.bannerBig') });
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
    res.status(500).json({ error: req.t('server.saveChangesFailed') });
  }
});

// PUT /streamers/me/layout — сохранить PRO-макет (layout: null — сброс)
router.put('/me/layout', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select('streamerName');
    if (!me) return res.status(401).json({ error: req.t('server.userNotFound') });
    if (!me.streamerName) return res.status(409).json({ error: req.t('server.streamers.createFirst') });
    if (req.body.layout === undefined) return res.status(400).json({ error: req.t('server.streamers.noLayout') });

    let layout;
    try {
      layout = PWLayout.sanitize(req.body.layout);
    } catch (e) {
      return res.status(400).json({ error: i18n.errText(req, e) });
    }
    // свои надписи кнопки «Подписаться» — без мата, как имя канала
    if (layout && PWLayout.styleTexts(layout).some((s) => hasProfanity(s))) {
      return res.status(400).json({ error: req.t('server.streamers.layoutProfanity') });
    }
    await User.updateOne({ _id: me._id }, { $set: { profileLayout: layout, profileRev: Date.now() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /streamers/me/layout]', err);
    res.status(500).json({ error: req.t('server.streamers.layoutFailed') });
  }
});

// GET /streamers/:name/layout — публичный макет (без +1 просмотра)
router.get('/:name/layout', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: req.t('server.streamers.noName') });
    const s = await User.findOne({ streamerNameLower: nameLower }).select('profileLayout -_id').lean();
    if (!s) return res.status(404).json({ error: req.t('server.streamers.notFound') });
    res.json({ layout: s.profileLayout || null });
  } catch (err) {
    console.error('[GET /streamers/:name/layout]', err);
    res.status(500).json({ error: req.t('server.error') });
  }
});

// GET /streamers/:name/bundle?rev=N — профиль + макет одним запросом.
// Если rev совпал с текущим, тяжёлое (аватар, баннер, макет) не отправляем.
router.get('/:name/bundle', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: req.t('server.streamers.noName') });

    const s = await User.findOneAndUpdate(
      { streamerNameLower: nameLower },
      { $inc: { profileViews: BOT_RE.test(req.headers['user-agent'] || '') ? 0 : 1 } }, // поисковики просмотрами не считаем
      { new: true }
    )
      .select('streamerName isLive streamPlaybackId profileRev streamTitle streamCategoryId streamAdult')
      .lean();
    if (!s) return res.status(404).json({ error: req.t('server.streamers.notFound') });

    const rev = s.profileRev || 0;
    const light = {
      rev,
      streamerName: s.streamerName,
      isLive: !!s.isLive,
      streamPlaybackId: s.streamPlaybackId || null,
      adult: isAdultStream(s), // эфир 18+: до плеера окно «Тебе есть 18?»
      ...(await liveInfo(s)),
    };

    const clientRev = req.query.rev === undefined ? NaN : Number(req.query.rev);
    if (clientRev === rev) return res.json({ ...light, unchanged: true });

    const [heavy] = await User.aggregate([
      { $match: { _id: s._id } },
      { $project: { _id: 0, streamerBio: 1, profileLayout: 1, ...hasImages } },
    ]);

    res.json({
      ...light,
      streamerBio: heavy?.streamerBio || '',
      ...imageUrls(nameLower, rev, heavy),
      layout: heavy?.profileLayout || null,
    });
  } catch (err) {
    console.error('[GET /streamers/:name/bundle]', err);
    res.status(500).json({ error: req.t('server.streamers.profileFailed') });
  }
});

const StreamVod = require('../../models/StreamVod');

// GET /streamers/:name/vods — только опубликованные и не истёкшие
router.get('/:name/vods', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: req.t('server.streamers.noName') });

    const vods = await StreamVod.find({
      streamerNameLower: nameLower,
      published: true,
      status: 'ready',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('title description fileRel createdAt durationSec categoryId')
      .lean();

    // категории записей — из памяти (categories.viewByTid), по одной на разный id
    const cats = new Map();
    for (const id of new Set(vods.map((v) => v.categoryId).filter(Boolean))) {
      cats.set(id, await categories.viewByTid(id).catch(() => null));
    }
    res.json(
      vods.map((v) => ({
        id: v._id,
        title: v.title,
        description: v.description,
        createdAt: v.createdAt,
        durationSec: v.durationSec,
        url: `/media/${v.fileRel}`,
        category: (v.categoryId && cats.get(v.categoryId)) || null,
      }))
    );
  } catch (err) {
    console.error('[GET /streamers/:name/vods]', err);
    res.status(500).json({ error: req.t('server.streamers.vodsFailed') });
  }
});

// старые аватары и баннеры (загружены до пережатия в браузере) бывают по 0,5–4 МБ, а в списках аватар — кружок 40 px.
// Такие один раз ужимаем ffmpeg'ом в webp (аватар до 512 px, баннер до 1600) — в базе остаётся как было, результат
// в памяти, а с актуальным ?v= его год держат Cloudflare и браузер. Нет ffmpeg или ошибка — отдаём оригинал
const SHRINK = { avatar: { over: 120 * 1024, side: 512 }, banner: { over: 400 * 1024, side: 1600 } };
const FFMPEG = '/usr/bin/ffmpeg';
let shrinkChain = Promise.resolve(); // по одному ffmpeg за раз
function shrinkImage(buf, side) {
  const run = () => new Promise((resolve) => {
    const p = require('child_process').spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `scale='min(${side},iw)':-2`, '-c:v', 'libwebp', '-quality', '82', '-f', 'webp', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.stdout.on('data', (c) => out.push(c));
    p.stdin.on('error', () => {});
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const b = Buffer.concat(out);
      resolve(code === 0 && b.length && b.length < buf.length ? b : null);
    });
    p.stdin.end(buf);
  });
  const r = shrinkChain.then(run, run);
  shrinkChain = r.catch(() => {});
  return r;
}
const imageLoading = new Map(); // key → Promise<entry | null> (одновременные запросы ждут одну загрузку)

async function loadImage(kind, nameLower, rev) {
  const field = IMAGE_FIELDS[kind];
  const a = await User.findOne({ streamerNameLower: nameLower }).select(field + ' -_id').lean();
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(a?.[field] || '');
  if (!m) return null;
  let buf = Buffer.from(m[2], 'base64');
  let type = m[1];
  if (buf.length > SHRINK[kind].over) {
    const small = await shrinkImage(buf, SHRINK[kind].side);
    if (small) {
      console.log(`[streamers] ${kind} ${nameLower}: ${Math.round(buf.length / 1024)} → ${Math.round(small.length / 1024)} КБ`);
      buf = small;
      type = 'image/webp';
    }
  }
  return { rev, type, buf };
}

// GET /streamers/:name/avatar|banner?v=rev — аватар или баннер картинкой. С актуальным v кэшируется в браузере на год.
// Есть в памяти с тем же v — отдаём без запроса к базе (адрес с версией: новая картинка — другой v)
router.get('/:name/:kind(avatar|banner)', async (req, res) => {
  const kind = req.params.kind;
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    const key = kind + ':' + nameLower;
    let entry = avatarCache.get(key);
    let rev = entry && req.query.v !== undefined && String(entry.rev) === String(req.query.v) ? entry.rev : null;
    if (rev === null) {
      const s = nameLower && (await User.findOne({ streamerNameLower: nameLower }).select('profileRev -_id').lean());
      if (!s) return res.status(404).set('Cache-Control', 'no-store').end();
      rev = Number(s.profileRev) || 0;
      if (!entry || entry.rev !== rev) {
        const lk = key + ':' + rev;
        if (!imageLoading.has(lk)) imageLoading.set(lk, loadImage(kind, nameLower, rev).finally(() => imageLoading.delete(lk)));
        entry = await imageLoading.get(lk);
        if (!entry) return res.status(404).set('Cache-Control', 'no-store').end();
      }
    }
    avatarCachePut(key, entry); // и для свежего, и чтобы поднять в конец очереди

    res.set('Content-Type', entry.type);
    res.set('Cache-Control', String(req.query.v) === String(rev) ? 'public, max-age=31536000, immutable' : 'no-store');
    res.send(entry.buf);
  } catch (err) {
    console.error('[GET /streamers/:name/' + kind + ']', err);
    res.status(500).set('Cache-Control', 'no-store').end();
  }
});

// ---------- подписки ----------

async function followTarget(req, res) {
  const nameLower = String(req.params.name || '').trim().toLowerCase();
  const s = nameLower && (await User.findOne({ streamerNameLower: nameLower }).select('_id followersCount').lean());
  if (!s) {
    res.status(404).json({ error: req.t('server.streamers.notFound') });
    return null;
  }
  return s;
}

// GET /streamers/:name/follow — число подписчиков и подписан ли я (гостю — только число)
router.get('/:name/follow', auth.optional, async (req, res) => {
  try {
    const s = await followTarget(req, res);
    if (!s) return;
    const self = !!req.user && String(s._id) === String(req.user.id);
    const following = !!req.user && !self && !!(await Follow.exists({ followerId: req.user.id, streamerId: s._id }));
    res.set('Cache-Control', 'no-store');
    res.json({ followers: s.followersCount || 0, following, self });
  } catch (err) {
    console.error('[GET /streamers/:name/follow]', err);
    res.status(500).json({ error: req.t('server.error') });
  }
});

// POST /streamers/:name/follow — подписаться (на себя нельзя; повтор — без изменений)
router.post('/:name/follow', auth, followLimiter, async (req, res) => {
  try {
    const s = await followTarget(req, res);
    if (!s) return;
    if (String(s._id) === String(req.user.id)) return res.status(400).json({ error: req.t('server.follow.self') });

    let added = false;
    try {
      const r = await Follow.updateOne(
        { followerId: req.user.id, streamerId: s._id },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      added = r.upsertedCount > 0;
    } catch (e) {
      if (e.code !== 11000) throw e; // два клика одновременно: второй упёрся в уникальный индекс — уже подписан
    }
    require('../../services/emotes').forgetFollow(s._id, req.user.id);
    let followers = s.followersCount || 0;
    if (added) {
      const u = await User.findOneAndUpdate({ _id: s._id }, { $inc: { followersCount: 1 } }, { new: true })
        .select('followersCount').lean();
      followers = u?.followersCount ?? followers + 1;
      // алерты: «новый подписчик» и рубеж подписчиков (оверлей OBS и боты)
      const alerts = require('../../services/alerts');
      const nameLower = String(req.params.name || '').trim().toLowerCase();
      alerts.fire(nameLower, 'follow', { name: req.user.username }).catch(() => {});
      alerts.followers(nameLower, s._id, followers).catch(() => {});
      // в колокольчик стримеру: подписки подряд копятся в одно «ник и ещё N»
      require('../../services/notify').send(s._id, 'channel.follow', { name: req.user.username }, { group: 'follow', link: '/workbench/channel-activity.html' });
    }
    res.json({ followers, following: true, self: false });
  } catch (err) {
    console.error('[POST /streamers/:name/follow]', err);
    res.status(500).json({ error: req.t('server.follow.failed') });
  }
});

// DELETE /streamers/:name/follow — отписаться
router.delete('/:name/follow', auth, followLimiter, async (req, res) => {
  try {
    const s = await followTarget(req, res);
    if (!s) return;
    const r = await Follow.deleteOne({ followerId: req.user.id, streamerId: s._id });
    require('../../services/emotes').forgetFollow(s._id, req.user.id);
    let followers = s.followersCount || 0;
    if (r.deletedCount) {
      const u = await User.findOneAndUpdate(
        { _id: s._id, followersCount: { $gt: 0 } },
        { $inc: { followersCount: -1 } },
        { new: true }
      ).select('followersCount').lean();
      followers = u ? u.followersCount : 0;
    }
    res.json({ followers, following: false, self: String(s._id) === String(req.user.id) });
  } catch (err) {
    console.error('[DELETE /streamers/:name/follow]', err);
    res.status(500).json({ error: req.t('server.follow.failed') });
  }
});

// GET /streamers/:name/clips — последние клипы канала (блок «Клипы» в профиле)
router.get('/:name/clips', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    const Clip = require('../../models/Clip');
    const { publicClip } = require('./clips.routes');
    const list = await Clip.find({ streamerNameLower: nameLower }).sort({ createdAt: -1 }).limit(24).lean();
    res.set('Cache-Control', 'no-store');
    res.json(await Promise.all(list.map(publicClip)));
  } catch (err) {
    console.error('[GET /streamers/:name/clips]', err);
    res.status(500).json({ error: req.t('server.error') });
  }
});

// GET /streamers/:name/live-status — только isLive + playbackId, без +1 просмотра.
// Его опрашивает каждый зритель канала раз в 5 с: ответ держим в памяти 3 с — 100 зрителей ≈ 1 запрос к базе за 3 с
const LIVE_STATUS_TTL_MS = 3000;
const liveStatusCache = new Map(); // nameLower → { at, data | null }
router.get('/:name/live-status', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: req.t('server.streamers.noName') });

    let hit = liveStatusCache.get(nameLower);
    if (!hit || Date.now() - hit.at > LIVE_STATUS_TTL_MS) {
      const streamer = await User.findOne({ streamerNameLower: nameLower })
        .select('isLive streamPlaybackId streamTitle streamCategoryId streamAdult -_id')
        .lean();
      const data = streamer && { isLive: !!streamer.isLive, streamPlaybackId: streamer.streamPlaybackId || null, adult: isAdultStream(streamer), ...(await liveInfo(streamer)) };
      if (liveStatusCache.size > 3000) liveStatusCache.clear();
      hit = { at: Date.now(), data };
      liveStatusCache.set(nameLower, hit);
    }
    if (!hit.data) return res.status(404).json({ error: req.t('server.streamers.notFound') });
    res.json(hit.data);
  } catch (err) {
    console.error('[GET /streamers/:name/live-status]', err);
    res.status(500).json({ error: req.t('server.error') });
  }
});

// GET /streamers/:name — публичные данные одного стримера (регистр не важен)
router.get('/:name', async (req, res) => {
  try {
    const nameLower = String(req.params.name || '').trim().toLowerCase();
    if (!nameLower) return res.status(400).json({ error: req.t('server.streamers.noName') });

    const s = await User.findOneAndUpdate(
      { streamerNameLower: nameLower },
      { $inc: { profileViews: BOT_RE.test(req.headers['user-agent'] || '') ? 0 : 1 } }, // поисковики просмотрами не считаем
      { new: true }
    )
      .select('streamerName isLive streamerBio streamPlaybackId profileRev streamAdult streamTitle')
      .lean();

    if (!s) return res.status(404).json({ error: req.t('server.streamers.notFound') });

    const [img] = await User.aggregate([{ $match: { _id: s._id } }, { $project: { _id: 0, ...hasImages } }]);
    res.json({
      streamerName: s.streamerName,
      isLive: s.isLive,
      streamerBio: s.streamerBio,
      streamPlaybackId: s.streamPlaybackId,
      adult: isAdultStream(s),
      ...imageUrls(nameLower, s.profileRev, img),
    });
  } catch (err) {
    console.error('[GET /streamers/:name]', err);
    res.status(500).json({ error: req.t('server.streamers.profileFailed') });
  }
});


module.exports = router;