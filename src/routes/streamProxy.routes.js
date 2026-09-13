const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

const PROXY_SERVER = process.env.PROXY_SERVER;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

const { ProxyAgent } = require('undici');

function buildDispatcher() {
  if (!PROXY_SERVER) return null;
  return new ProxyAgent(`http://${PROXY_USER}:${PROXY_PASS}@${PROXY_SERVER}`);
}

// прокидываем .m3u8 манифест и сегменты через сервер, чтобы CDN не банил браузер зрителя
router.get('/relay', auth, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Нужен валидный url' });
  }

  try {
    const dispatcher = buildDispatcher();
    const response = await fetch(targetUrl, {
      dispatcher,
      headers: {
        'Referer': 'https://balabolka.stravers.live/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      console.error('[stream-relay] CDN отказал:', response.status, targetUrl.slice(0, 100), bodyText.slice(0, 200));
      return res.status(response.status).json({ error: `CDN вернул ${response.status}` });
    }

    const contentType = response.headers.get('content-type') || '';

    // если это m3u8-манифест — переписываем все ссылки внутри на свой relay,
    // иначе сегменты/ключи внутри плейлиста тоже упрутся в тот же 403
    if (contentType.includes('mpegurl') || targetUrl.endsWith('.m3u8')) {
      const text = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const rewritten = text.split('\n').map((line) => {
        if (line.startsWith('#') || !line.trim()) return line;
        const absoluteUrl = line.startsWith('http') ? line : baseUrl + line;
        return `/api/stream/relay?url=${encodeURIComponent(absoluteUrl)}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    res.setHeader('Content-Type', contentType);
    response.body.pipe(res);
  } catch (err) {
    console.error('[stream-relay]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;