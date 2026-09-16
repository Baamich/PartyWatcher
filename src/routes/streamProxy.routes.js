// streamProxy.routes.js
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

/** По URL потока/плеера угадываем нормальный Referer/Origin — без хардкода balabolka */
function guessReferer(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.hostname.includes('stravers.live') || u.hostname.includes('balabolka')) {
      return { referer: 'https://balabolka.stravers.live/', origin: 'https://balabolka.stravers.live' };
    }
    if (u.hostname.includes('ortified.ws')) {
      return { referer: 'https://api.ortified.ws/', origin: 'https://api.ortified.ws' };
    }
    if (u.hostname.includes('stiven-king.com')) {
      return { referer: 'https://api.stiven-king.com/', origin: 'https://api.stiven-king.com' };
    }
    if (u.hostname.includes('vkvideo') || u.hostname.includes('vk.com') || u.hostname.includes('userapi.com')) {
      return { referer: 'https://vk.com/', origin: 'https://vk.com' };
    }
    // fallback — сам хост потока
    return { referer: `${u.protocol}//${u.hostname}/`, origin: `${u.protocol}//${u.hostname}` };
  } catch {
    return { referer: 'https://kinogomy.net/', origin: 'https://kinogomy.net' };
  }
}

router.get('/relay', auth, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Нужен валидный url' });
  }

  try {
    const dispatcher = buildDispatcher();
    const { referer, origin } = guessReferer(targetUrl);

    const response = await fetch(targetUrl, {
      dispatcher,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Origin': origin,
        'Accept': '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      console.error('[stream-relay] CDN отказал:', response.status, targetUrl.slice(0, 120), bodyText.slice(0, 200));
      return res.status(response.status).json({ error: `CDN вернул ${response.status}` });
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
      const text = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const toRelay = (relOrAbsUrl) => {
        let absoluteUrl = relOrAbsUrl;
        if (!relOrAbsUrl.startsWith('http')) {
          try {
            absoluteUrl = new URL(relOrAbsUrl, baseUrl).href;
          } catch {
            absoluteUrl = baseUrl + relOrAbsUrl;
          }
        }
        return `/api/stream/relay?url=${encodeURIComponent(absoluteUrl)}`;
      };

      const rewritten = text.split('\n').map((line) => {
        if (line.startsWith('#EXT-X-MAP')) {
          return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${toRelay(uri)}"`);
        }
        if (line.startsWith('#EXT-X-KEY') && /URI="([^"]+)"/.test(line)) {
          return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${toRelay(uri)}"`);
        }
        if (line.startsWith('#') || !line.trim()) return line;
        return toRelay(line.trim());
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    const { Readable } = require('stream');
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
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