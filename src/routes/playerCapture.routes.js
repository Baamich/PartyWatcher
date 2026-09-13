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

        let playerApiData = null; // ← сюда попадёт JSON от balabolka.stravers.live/bnsi/movies/<id>

    page.on('response', async (response) => {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (reqUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
        foundStreams.push({ type: 'hls', url: reqUrl });
      }
      if (reqUrl.includes('.mp4') && contentType.includes('video') && !reqUrl.includes('blank.mp4')) {
        foundStreams.push({ type: 'mp4', url: reqUrl });
      }

      // ловим ответ балаболки конкретно по пути /bnsi/movies/<id>
      if (reqUrl.includes('/bnsi/movies/') && contentType.includes('application/json')) {
        try {
          const json = await response.json();
          if (json && json.hlsSource) {
            console.log('[player-capture] найден JSON плеера balabolka:', reqUrl);
            playerApiData = json;
          }
        } catch (e) {}
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

    // если запрошена конкретная серия — переключаем через UI балаболки внутри iframe
    const requestedEpisode = req.body.episode ? Number(req.body.episode) : null;

    if (requestedEpisode) {
      // балаболка обычно грузится не мгновенно — дождёмся появления нужного frame
      let balabolkaFrame = null;
      for (let i = 0; i < 10; i++) {
        balabolkaFrame = page.frames().find((f) => f.url().includes('balabolka.stravers.live'));
        if (balabolkaFrame) break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (balabolkaFrame) {
        try {
          // открываем дропдаун серий
          await balabolkaFrame.click('div[data-select="episodeType1"] .select_item');
          await new Promise(r => setTimeout(r, 500));

          // кликаем на нужную серию по data-id
          const episodeSelector = `div[data-select="episodeType1"] button.select_drop_item[data-id="${requestedEpisode}"]`;
          const episodeBtn = await balabolkaFrame.$(episodeSelector);
          if (episodeBtn) {
            await episodeBtn.click();
            console.log('[player-capture] переключено на серию', requestedEpisode);
          } else {
            console.warn('[player-capture] кнопка серии не найдена:', episodeSelector);
          }
        } catch (e) {
          console.error('[player-capture] ошибка переключения серии:', e.message);
        }
      } else {
        console.warn('[player-capture] frame balabolka не найден для переключения серии');
      }

      // ждём новый запрос /bnsi/movies/<id> с обновлённым потоком
      await new Promise(r => setTimeout(r, 4000));
    } else {
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
      await new Promise(r => setTimeout(r, 4000));
    }

        const iframes = await page.$$eval('iframe', (els) =>
      els.map((el) => el.src).filter(Boolean)
    );

    console.log('[player-capture] все iframe на странице:', iframes); // ← смотри в pm2 logs

        // парсим реальный график серий kinogo: таблица tr.epscape_tr
    const episodesData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr.epscape_tr'));
      return rows.map((row) => {
        const cells = row.querySelectorAll('td');
        const fullText = cells[0]?.textContent.trim() || '';
        const countdownText = cells[3]?.textContent.trim() || '';
        const match = fullText.match(/(\d+)\s*сезон\s*(\d+)\s*серия/i);
        return {
          season: match ? Number(match[1]) : 1,
          episode: match ? Number(match[2]) : null,
          // пустая 4-я ячейка = серия уже вышла; "N дней" = ещё не вышла
          released: countdownText === '',
        };
      }).filter((e) => e.episode !== null);
    });

    console.log('[player-capture] распарсенные серии:', episodesData);

    const releasedEpisodes = episodesData.filter((e) => e.released);
    const seasonsFound = [...new Set(episodesData.map((e) => e.season))];
    const totalEpisodes = releasedEpisodes.length
      ? Math.max(...releasedEpisodes.map((e) => e.episode))
      : 1;

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

    let uniqueStreams = [...new Map(foundStreams.map((s) => [s.url, s])).values()];

    // если нашли богатый JSON от плеера — строим streams из него, это надёжнее
    if (playerApiData?.hlsSource?.length) {
      const qualities = playerApiData.hlsSource[0].quality || {};
      // берём лучшее доступное качество как основной поток
      const bestQuality = Object.keys(qualities).sort((a, b) => Number(b) - Number(a))[0];
      if (bestQuality) {
        uniqueStreams = [
          { type: 'hls', url: qualities[bestQuality], quality: bestQuality },
          ...Object.entries(qualities)
            .filter(([q]) => q !== bestQuality)
            .map(([q, u]) => ({ type: 'hls', url: u, quality: q })),
        ];
      }
    } else {
      // приоритет master.m3u8 — это основной манифест, а не отдельный сегмент/заглушка
      const master = uniqueStreams.find((s) => s.url.includes('master.m3u8'));
      if (master) {
        uniqueStreams = [master, ...uniqueStreams.filter((s) => s !== master)];
      }
    }
    const uniqueIframes = [...new Set(foundIframes)];

        const meta = {
      site: detectSite(url),
      seasons: seasonsFound.length ? seasonsFound : [1],
      currentSeason: 1,
      currentEpisode: 1,
      totalEpisodes,
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