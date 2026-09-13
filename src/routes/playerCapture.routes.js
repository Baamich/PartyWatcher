const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const puppeteer = require('puppeteer');

router.post('/extract', auth, async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Нужна валидная ссылка' });
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser', // ← системный Chromium для ARM
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    const foundStreams = [];
    const foundIframes = [];

    page.on('response', async (response) => {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (reqUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
        foundStreams.push({ type: 'hls', url: reqUrl });
      }
      if (reqUrl.includes('.mp4') && contentType.includes('video')) {
        foundStreams.push({ type: 'mp4', url: reqUrl });
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await new Promise(r => setTimeout(r, 5000)); // ждём загрузки плеера

    const iframes = await page.$$eval('iframe', (els) =>
      els.map((el) => el.src).filter(Boolean)
    );

    iframes.forEach((src) => {
      if (
        src.includes('player') ||
        src.includes('embed') ||
        src.includes('video') ||
        src.includes('alloh') ||
        src.includes('collaps') ||
        src.includes('voidboost') ||
        src.includes('ashdi') ||
        src.includes('cdnmovies')
      ) {
        foundIframes.push(src);
      }
    });

    const uniqueStreams = [...new Map(foundStreams.map((s) => [s.url, s])).values()];
    const uniqueIframes = [...new Set(foundIframes)];

    const meta = {
      site: detectSite(url),
      seasons: [1],
      currentSeason: 1,
      currentEpisode: 1,
      voices: [],
    };

    const success = uniqueStreams.length > 0 || uniqueIframes.length > 0;

    res.json({
      success,
      streams: uniqueStreams,
      playerIframes: uniqueIframes,
      meta,
      message: success
        ? `Найдено потоков: ${uniqueStreams.length}, iframe: ${uniqueIframes.length}`
        : 'Ничего не найдено',
    });
  } catch (err) {
    console.error('[player-capture puppeteer]', err.message);
    res.json({
      success: false,
      error: err.message,
      streams: [],
      playerIframes: [],
      meta: null,
    });
  } finally {
    if (browser) await browser.close();
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