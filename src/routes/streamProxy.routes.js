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

function guessReferer(targetUrl) {
  try {
    const u = new URL(targetUrl);

    if (
      u.hostname.includes('vkvideo') ||
      u.hostname.includes('vk.com') ||
      u.hostname.includes('userapi.com') ||
      u.hostname.includes('vkuservideo') ||
      u.hostname.includes('vk-cdn') ||
      u.hostname.includes('vkcs')
    ) {
      return {
        referer: 'https://kinogomy.stravers.live/',
        origin: 'https://kinogomy.stravers.live',
      };
    }

    if (u.hostname.includes('stravers.live') || u.hostname.includes('balabolka')) {
      return { referer: 'https://balabolka.stravers.live/', origin: 'https://balabolka.stravers.live' };
    }
    if (u.hostname.includes('ortified.ws')) {
      return { referer: 'https://api.ortified.ws/', origin: 'https://api.ortified.ws' };
    }
    if (u.hostname.includes('stiven-king.com')) {
      return { referer: 'https://api.stiven-king.com/', origin: 'https://api.stiven-king.com' };
    }

    // kinogo2026 / cinemar embed → CDN cfnd.cinemap.cc
    if (
      u.hostname.includes('cinemap.cc') ||
      u.hostname.includes('cinemar.cc') ||
      u.hostname.includes('cfnd.')
    ) {
      return {
        referer: 'https://cinemar.cc/',
        origin: 'https://cinemar.cc',
      };
    }

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
     // VK CDN часто недоступен через Webshare-прокси — для него прокси не используем.
    // cinemap.cc/cinemar.cc (плеер kinogo2026) — обычный видео-CDN, ему прокси не
    // нужен вообще: он не банит по IP так, как страница-обёртка kinogo2026.com,
    // а через прокси только сжигаем лимит трафика на КАЖДЫЙ HLS-сегмент.
    const isVk = /vkvideo\.cloud|vkuservideo|userapi\.com|vk-cdn/i.test(targetUrl);
    const isDirectCdn = /cinemap\.cc|cinemar\.cc/i.test(targetUrl);
    const dispatcher = (isVk || isDirectCdn) ? null : buildDispatcher();
    console.log('[stream-relay] proxy:', dispatcher ? 'ON' : 'OFF', 'vk:', isVk, 'directCdn:', isDirectCdn, 'url:', targetUrl.slice(0, 80));
    const primary = guessReferer(targetUrl);

    // для VK CDN пробуем несколько referer по очереди
    const refererCandidates = [
      primary,
      { referer: 'https://kinogomy.stravers.live/', origin: 'https://kinogomy.stravers.live' },
      { referer: 'https://balabolka.stravers.live/', origin: 'https://balabolka.stravers.live' },
      { referer: 'https://vk.com/', origin: 'https://vk.com' },
      { referer: 'https://kinogomy.net/', origin: 'https://kinogomy.net' },
    ];

    // убираем дубли
    const seen = new Set();
    const uniqueCandidates = refererCandidates.filter((c) => {
      const key = c.referer + '|' + c.origin;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let response = null;
    let lastStatus = 0;
    let lastBody = '';

    for (let i = 0; i < uniqueCandidates.length; i++) {
    const { referer, origin } = uniqueCandidates[i];
    const isLast = i === uniqueCandidates.length - 1;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': referer,
      'Accept': '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Connection': 'keep-alive',
    };
    // на последней попытке Origin не ставим — VK иногда из‑за него отдаёт 403
    if (!isLast) headers['Origin'] = origin;

    response = await fetch(targetUrl, { dispatcher, headers });

      if (response.ok) {
        console.log('[stream-relay] OK с referer:', referer);
        break;
      }

      lastStatus = response.status;
      lastBody = await response.text().catch(() => '');
      console.warn('[stream-relay] отказ', response.status, 'referer:', referer, targetUrl.slice(0, 80));
      response = null;
    }

    if (!response) {
      console.error('[stream-relay] CDN отказал всеми referer:', lastStatus, targetUrl.slice(0, 120), lastBody.slice(0, 200));
      return res.status(lastStatus || 502).json({ error: `CDN вернул ${lastStatus}` });
    }

        const contentType = response.headers.get('content-type') || '';
    const looksLikeUrlM3u8 = targetUrl.includes('.m3u8');
    const looksLikeType = contentType.includes('mpegurl') || contentType.includes('application/vnd.apple');

    // читаем тело один раз
    const buf = Buffer.from(await response.arrayBuffer());
    const head = buf.slice(0, 16).toString('utf8');
    const isM3u8Body = head.startsWith('#EXTM3U');

    if (looksLikeUrlM3u8 || looksLikeType || isM3u8Body) {
      const text = buf.toString('utf8');
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

    // не m3u8 — отдаём как бинарь (сегменты .ts / .m4s)
    const { Readable } = require('stream');
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const nodeStream = Readable.from(buf);
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