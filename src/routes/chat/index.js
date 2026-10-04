const express = require('express');
const User = require('../../models/User');
const StreamChatMessage = require('../../models/StreamChatMessage');
const chatBus = require('../../services/chatBus');

const router = express.Router();

// CORS: авторизация по ключу в заголовке, куки не используются
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// лимиты на канал: короткий всплеск + общий потолок за минуту
const LIMITS = [
  { windowMs: 10_000, max: 20 },
  { windowMs: 60_000, max: 100 },
];
const MAX_WINDOW_MS = LIMITS[LIMITS.length - 1].windowMs;
const hits = new Map();

// 0 — можно слать; иначе через сколько секунд повторить
function checkRate(id) {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < MAX_WINDOW_MS);

  for (const { windowMs, max } of LIMITS) {
    const inWindow = arr.filter((t) => now - t < windowMs);
    if (inWindow.length >= max) {
      hits.set(id, arr);
      return Math.max(1, Math.ceil((inWindow[0] + windowMs - now) / 1000));
    }
  }

  arr.push(now);
  hits.set(id, arr);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, arr] of hits) {
    const fresh = arr.filter((t) => now - t < MAX_WINDOW_MS);
    if (fresh.length) hits.set(id, fresh);
    else hits.delete(id);
  }
}, 60_000).unref();

function extractKey(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
}

// POST /api/chat/send
// Header: Authorization: Bearer <ключ>   (или X-Api-Key: <ключ>)
// Body:   { "text": "...", "username": "Бот", "source": "twitch", "color": "#9146ff" }
router.post('/send', async (req, res) => {
  try {
    const key = extractKey(req);
    if (!key) return res.status(401).json({ error: 'Нужен API-ключ (Authorization: Bearer <ключ>)' });

    const streamer = await User.findOne({ chatApiKey: key }).select('_id streamerNameLower').lean();
    if (!streamer || !streamer.streamerNameLower) {
      return res.status(401).json({ error: 'Неверный API-ключ' });
    }

    const retryAfter = checkRate(String(streamer._id));
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Слишком много сообщений, повтори через ${retryAfter} с`, retryAfter });
    }

    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

    const username = String(req.body?.username || 'Бот').trim().slice(0, 32) || 'Бот';
    const source = String(req.body?.source || 'api')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 16) || 'api';
    const color = /^#[0-9a-f]{6}$/i.test(String(req.body?.color || '')) ? String(req.body.color) : null;

    const msg = await StreamChatMessage.create({
      streamerNameLower: streamer.streamerNameLower,
      senderId: null,
      senderUsername: username,
      text,
      external: true,
      source,
      nickColor: color,
    });

    chatBus.emitMessage(streamer.streamerNameLower, {
      _id: msg._id,
      senderId: null,
      senderUsername: msg.senderUsername,
      text: msg.text,
      deleted: false,
      createdAt: msg.createdAt,
      external: true,
      source,
      nickColor: color,
      isOwner: false,
    });

    res.json({ ok: true, id: String(msg._id) });
  } catch (err) {
    console.error('[POST /api/chat/send]', err);
    res.status(500).json({ error: 'Не удалось отправить сообщение' });
  }
});

module.exports = router;