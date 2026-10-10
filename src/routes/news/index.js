const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const News = require('../../models/News');
const User = require('../../models/User');
const auth = require('../../middleware/auth');
const adminOnly = require('../../middleware/adminOnly');
const i18n = require('../../services/i18n');
const { translate, detectLang } = require('../../services/translator');

const router = express.Router();

const MAX_IMAGE_CHARS = 3_000_000;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

// adminOnly у тебя async без try/catch: при сбое базы запрос завис бы.
// Эта обёртка отправляет ошибку в обработчик ошибок Express.
const safeAdminOnly = (req, res, next) => Promise.resolve(adminOnly(req, res, next)).catch(next);
const adminGuard = [auth, safeAdminOnly];

// ---- проверки: возвращают ключ словаря ошибки (перевод — req.t) или null ----
function checkTitle(title) {
  if (title.length < 3 || title.length > 140) return 'server.news.titleLen';
  return null;
}
function checkBody(body) {
  if (body.length > 5000) return 'server.news.bodyLong';
  return null;
}
function checkImage(image) {
  if (image.length > MAX_IMAGE_CHARS) return 'server.news.imageBig';
  if (!IMAGE_RE.test(image)) return 'server.news.imageType';
  return null;
}

// Гости и обычные юзеры просто читают. Если вошёл админ, страница покажет кнопки управления.
async function isAdminRequest(req) {
  try {
    const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return false;
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(payload.id).select('role').lean();
    return !!user && user.role === 'admin';
  } catch (_) {
    return false;
  }
}

const stampOf = (n) => new Date(n.editedAt || n.publishedAt).getTime(); // меняется при каждой правке

// ---- автоперевод: делаем один раз после публикации/правки и храним в базе ----
// Очередь последовательная (провайдер с лимитами); после ошибки (например, кончилась дневная квота) — пауза 30 мин
const translating = new Set();
const failedAt = new Map();
let queue = Promise.resolve();

function scheduleTranslation(id) {
  id = String(id);
  const failed = failedAt.get(id);
  if (translating.has(id) || (failed && Date.now() - failed < 30 * 60 * 1000)) return;
  translating.add(id);
  queue = queue.then(() => translateNews(id)).catch(() => {}).finally(() => translating.delete(id));
}

async function translateNews(id) {
  try {
    const n = await News.findById(id).lean();
    if (!n) return;
    const from = detectLang(n.title + '\n' + n.body);
    const tr = {};
    for (const to of i18n.LANGS) {
      if (to === from) continue;
      const texts = n.body ? [n.title, n.body] : [n.title];
      const [title, body = ''] = await translate(texts, from, to);
      tr[to] = { title: String(title).slice(0, 300), body: String(body).slice(0, 8000) };
    }
    // новость успели изменить, пока переводили, — этот перевод уже не про неё
    await News.updateOne({ _id: id, editedAt: n.editedAt ?? null }, { $set: { lang: from, tr, trStamp: stampOf(n) } });
    failedAt.delete(id);
  } catch (e) {
    failedAt.set(id, Date.now());
    if (failedAt.size > 1000) failedAt.clear();
    console.warn('[news translate]', id, e.message);
  }
}

// lang — язык читателя: если новость на другом языке и свежий перевод готов, отдаём его рядом с оригиналом
function serialize(n, lang) {
  const stamp = stampOf(n); // меняется при правке, браузер не держит старую картинку
  const fresh = n.trStamp === stamp && n.tr && n.tr[lang];
  return {
    id: n._id,
    title: n.title,
    body: n.body,
    lang: n.lang || null,
    translation: fresh && n.lang && n.lang !== lang ? { title: n.tr[lang].title, body: n.tr[lang].body } : null,
    publishedAt: n.publishedAt,
    editedAt: n.editedAt || null,
    imageUrl: n.hasImage ? `/api/news/${n._id}/image?v=${stamp}` : null,
  };
}

// GET /news?from=<ISO>&to=<ISO> — от новых к старым
router.get('/', async (req, res) => {
  try {
    const range = {};
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if (from && !isNaN(from)) range.$gte = from;
    if (to && !isNaN(to)) range.$lte = to;

    const filter = Object.keys(range).length ? { publishedAt: range } : {};
    const items = await News.find(filter).sort({ publishedAt: -1 }).limit(100).lean();

    // старые новости без перевода (или изменённые после него) переводим в фоне — увидят при следующем открытии
    items.filter((n) => n.trStamp !== stampOf(n)).slice(0, 10).forEach((n) => scheduleTranslation(n._id));

    res.json({ canManage: await isAdminRequest(req), items: items.map((n) => serialize(n, req.lang)) });
  } catch (err) {
    console.error('[GET /news]', err);
    res.status(500).json({ error: req.t('server.news.loadFailed') });
  }
});

// GET /news/:id/image — картинка-превью (кэшируется браузером)
router.get('/:id/image', async (req, res) => {
  try {
    const n = await News.findById(req.params.id).select('+image').lean();
    if (!n || !n.image) return res.status(404).end();
    const m = n.image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (_) {
    res.status(404).end();
  }
});

// POST /news — создать (только админ). Дата ставится автоматически.
router.post('/', adminGuard, async (req, res) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    const body = String(req.body?.body ?? ''); // как написал, так и сохраняем
    const image = req.body?.image ? String(req.body.image) : null;

    const err = checkTitle(title) || checkBody(body) || (image ? checkImage(image) : null);
    if (err) return res.status(400).json({ error: req.t(err) });

    const me = await User.findById(req.user.id).select('username').lean();
    const news = await News.create({
      title,
      body,
      image,
      hasImage: !!image,
      authorUsername: me?.username || '',
    });

    scheduleTranslation(news._id);
    res.status(201).json(serialize(news, req.lang));
  } catch (err) {
    console.error('[POST /news]', err);
    res.status(500).json({ error: req.t('server.news.publishFailed') });
  }
});

// PATCH /news/:id — изменить (только админ). Дата публикации не меняется.
// В теле: title, body, image (новая картинка) или removeImage: true
router.patch('/:id', adminGuard, async (req, res) => {
  try {
    const news = await News.findById(req.params.id);
    if (!news) return res.status(404).json({ error: req.t('server.news.notFound') });

    if (req.body?.title !== undefined) {
      const title = String(req.body.title).trim();
      const err = checkTitle(title);
      if (err) return res.status(400).json({ error: req.t(err) });
      news.title = title;
    }

    if (req.body?.body !== undefined) {
      const body = String(req.body.body);
      const err = checkBody(body);
      if (err) return res.status(400).json({ error: req.t(err) });
      news.body = body;
    }

    if (req.body?.removeImage) {
      news.image = null;
      news.hasImage = false;
    } else if (req.body?.image) {
      const image = String(req.body.image);
      const err = checkImage(image);
      if (err) return res.status(400).json({ error: req.t(err) });
      news.image = image;
      news.hasImage = true;
    }

    news.editedAt = new Date();
    await news.save();

    scheduleTranslation(news._id);
    res.json(serialize(news, req.lang));
  } catch (err) {
    console.error('[PATCH /news/:id]', err);
    res.status(400).json({ error: req.t('server.saveChangesFailed') });
  }
});

// DELETE /news/:id — удалить (только админ)
router.delete('/:id', adminGuard, async (req, res) => {
  try {
    await News.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (_) {
    res.status(400).json({ error: req.t('server.deleteFailed') });
  }
});

// POST /news/spellcheck — проверка орфографии через LanguageTool (только админ)
router.post('/spellcheck', adminGuard, async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').slice(0, 5000);
    if (!text.trim()) return res.json({ matches: [] });

    const params = new URLSearchParams({ text, language: 'auto', preferredVariants: 'ru-RU,en-US' });
    const r = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('LanguageTool HTTP ' + r.status);
    const data = await r.json();

    res.json({
      matches: (data.matches || []).slice(0, 40).map((m) => ({
        offset: m.offset,
        length: m.length,
        message: m.message,
        replacements: (m.replacements || []).slice(0, 3).map((x) => x.value),
      })),
    });
  } catch (err) {
    console.warn('[news spellcheck]', err.message);
    res.status(502).json({ error: req.t('server.news.spellUnavailable') });
  }
});

module.exports = router;