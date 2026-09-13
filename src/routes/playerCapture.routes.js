const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const https = require('https');
const http = require('http');

// Простая функция загрузки страницы
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Очень простые эвристики поиска видеопотоков
function extractStreams(html, pageUrl) {
  const streams = [];

  // Ищем .m3u8
  const m3u8Regex = /https?:\/\/[^"'\s>]+\.m3u8[^"'\s>]*/gi;
  const m3u8Matches = html.match(m3u8Regex) || [];
  m3u8Matches.forEach(url => {
    streams.push({ type: 'hls', url: url.replace(/\\u002F/g, '/').replace(/\\\//g, '/') });
  });

  // Ищем .mp4
  const mp4Regex = /https?:\/\/[^"'\s>]+\.mp4[^"'\s>]*/gi;
  const mp4Matches = html.match(mp4Regex) || [];
  mp4Matches.forEach(url => {
    streams.push({ type: 'mp4', url: url.replace(/\\u002F/g, '/').replace(/\\\//g, '/') });
  });

  // Убираем дубликаты
  const unique = [];
  const seen = new Set();
  for (const s of streams) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  return unique;
}

router.post('/extract', auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Нужна валидная ссылка' });
    }

    const { html, status } = await fetchPage(url);

    if (status >= 400) {
      return res.json({
        success: false,
        error: `Сайт вернул статус ${status}`,
        streams: [],
        meta: null,
      });
    }

    const streams = extractStreams(html, url);

    // Пока простая мета (потом улучшим парсерами)
    const meta = {
      site: detectSite(url),
      seasons: [1],
      currentSeason: 1,
      currentEpisode: 1,
      voices: [],
    };

    res.json({
      success: streams.length > 0,
      streams,
      meta,
      message: streams.length
        ? `Найдено потоков: ${streams.length}`
        : 'Прямые потоки не найдены (сайт сильно защищён или использует динамическую загрузку)',
    });
  } catch (err) {
    console.error('[player-capture extract]', err.message);
    res.json({
      success: false,
      error: err.message,
      streams: [],
      meta: null,
    });
  }
});

function detectSite(url) {
  const lower = url.toLowerCase();
  if (lower.includes('rezka') || lower.includes('hdrezka')) return 'rezka';
  if (lower.includes('kinogo')) return 'kinogo';
  if (lower.includes('lordfilm') || lower.includes('lordserial')) return 'lordfilm';
  return 'unknown';
}

module.exports = router;