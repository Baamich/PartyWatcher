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
        'Origin': 'https://balabolka.stravers.live',
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

      const toRelay = (relOrAbsUrl) => {
        const absoluteUrl = relOrAbsUrl.startsWith('http') ? relOrAbsUrl : baseUrl + relOrAbsUrl;
        return `/api/stream/relay?url=${encodeURIComponent(absoluteUrl)}`;
      };

      const rewritten = text.split('\n').map((line) => {
        // особый случай: #EXT-X-MAP:URI="init-....mp4" — ссылка спрятана внутри атрибута тега
        if (line.startsWith('#EXT-X-MAP')) {
          return line.replace(/URI="([^"]+)"/, (match, uri) => `URI="${toRelay(uri)}"`);
        }

        // обычные служебные теги без ссылок — пропускаем как есть
        if (line.startsWith('#') || !line.trim()) return line;

        // обычная строка плейлиста — ссылка на сегмент или вложенный манифест
        return toRelay(line);
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

        const { Readable } = require('stream');

    res.setHeader('Content-Type', contentType);
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
    nodeStream.on('error', (streamErr) => {
      console.error('[stream-relay] ошибка потока:', streamErr.message);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('[stream-relay]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;