const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.warn('[player-capture] puppeteer-core не установлен');
}

router.post('/extract', auth, async (req, res) => {
    if (!puppeteer) {
        return res.json({
        success: false,
        error: 'puppeteer-core не установлен',
        streams: [],
        playerIframes: [],
        meta: null,
        });
    }
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Нужна валидная ссылка' });
  }

  let browser = null;

  try {
        // прокси Webshare — вынесено в переменные окружения, см. .env
    const PROXY_SERVER = process.env.PROXY_SERVER;   // например "31.58.9.4:6077"
    const PROXY_USER = process.env.PROXY_USER;        // "ksiyitlp"
    const PROXY_PASS = process.env.PROXY_PASS;        // "oiv7evgr7rk3"

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ];

    if (PROXY_SERVER) {
      launchArgs.push(`--proxy-server=${PROXY_SERVER}`);
    }

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser', // ← системный Chromium для ARM
      args: launchArgs,
    });

    const page = await browser.newPage();

    if (PROXY_SERVER && PROXY_USER && PROXY_PASS) {
      await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    }
    
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
    await page.setViewport({ width: 1366, height: 768 });

    // скрываем самые очевидные признаки headless/puppeteer
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    } catch (navErr) {
      console.error('[player-capture] ошибка навигации:', navErr.message);
    }

    console.log('[player-capture] HTTP статус:', response ? response.status() : 'нет ответа');
    console.log('[player-capture] финальный URL после редиректов:', page.url());
    console.log('[player-capture] заголовок страницы:', await page.title());

    const bodyLength = await page.evaluate(() => document.body?.innerHTML?.length || 0);
    console.log('[player-capture] длина HTML body:', bodyLength);

    // сохраняем скриншот, чтобы визуально понять что за страница реально отрисовалась
    try {
      await page.screenshot({ path: '/tmp/player-capture-debug.png' });
      console.log('[player-capture] скриншот сохранён: /tmp/player-capture-debug.png');
    } catch (e) {
      console.error('[player-capture] не удалось сделать скриншот:', e.message);
    }

    await new Promise(r => setTimeout(r, 5000)); // ждём загрузки плеера

        // пробуем кликнуть по типичным play-кнопкам/превьюшкам, если плеер лениво грузится
    const playSelectors = [
      '.play-btn', '.player-play', '.b-player__control', '.play', '#play',
      '[class*="play"]', '.video-play-button',
    ];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ delay: 100 }).catch(() => {});
          break;
        }
      } catch (e) {}
    }

    // даём время плееру подгрузиться после возможного клика
    await new Promise(r => setTimeout(r, 4000));

    const iframes = await page.$$eval('iframe', (els) =>
      els.map((el) => el.src).filter(Boolean)
    );

    console.log('[player-capture] все iframe на странице:', iframes); // ← смотри в pm2 logs

    const KNOWN_HOSTS = [
      'player', 'embed', 'video', 'alloh', 'collaps', 'voidboost',
      'ashdi', 'cdnmovies', 'kodik', 'hdvb', 'eneyida', 'animevost',
      'moonwalk', 'iframe.', 'vid', 'stream',
    ];

    iframes.forEach((src) => {
      if (KNOWN_HOSTS.some((k) => src.includes(k))) {
        foundIframes.push(src);
      }
    });

    // если по ключевым словам ничего не подошло, но iframe вообще есть —
    // отдаём всё как есть, чтобы фронт хотя бы попытался их отрендерить,
    // а не молчал "ничего не найдено"
    if (foundIframes.length === 0 && iframes.length > 0) {
      foundIframes.push(...iframes.filter((src) => !src.startsWith('about:blank')));
    }

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