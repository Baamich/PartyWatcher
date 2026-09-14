const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.warn('[player-capture] puppeteer-core не установлен');
}

const playerCaptureCache = require('../services/playerCaptureCache');
const siteAdapters = require('../services/site-adapters');
const { findPlayerContext, readDropdownTexts, selectDropdownOptionByNumber } = require('../services/dropdown-player');

function detectSite(url) {
  const lower = url.toLowerCase();
  if (lower.includes('rezka') || lower.includes('hdrezka')) return 'rezka';
  if (lower.includes('kinogo')) return 'kinogo';
  if (lower.includes('lordfilm') || lower.includes('lordserial')) return 'lordfilm';
  return 'unknown';
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
  const { url, roomCode } = req.body;
  const requestedEpisodeForCache = req.body.episode ? Number(req.body.episode) : null;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Нужна валидная ссылка' });
  }

  const siteName = detectSite(url);
  const adapter = siteAdapters[siteName] || null;
  console.log('[player-capture] сайт определён как:', siteName, '| адаптер найден:', !!adapter);

  // если для этой комнаты+серии уже есть свежий кэш — не гоняем puppeteer заново
  if (roomCode) {
    const cached = playerCaptureCache.get(roomCode, requestedEpisodeForCache);
    if (cached) {
      console.log('[player-capture] отдаю из кэша для комнаты', roomCode, 'серия', requestedEpisodeForCache || 1);
      return res.json(cached);
    }
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

    // если навигация не удалась вообще (таймаут, ERR_TUNNEL_CONNECTION_FAILED,
    // DNS-ошибка и т.п.) — страницы фактически нет, дальше делать нечего.
    // Раньше код лез читать document.body у пустой/убитой страницы и падал
    // с невнятным "Execution context was destroyed".
    if (!response) {
      console.warn('[player-capture] навигация провалилась, страница пуста — прерываю');
      return res.json({
        success: false,
        error: 'Не удалось открыть страницу (сайт недоступен через прокси или ссылка битая). Проверь прокси/URL.',
        streams: [],
        playerIframes: [],
        meta: null,
      });
    }

    let pageTitle = '(не удалось получить)';
    let bodyLength = 0;
    try {
      pageTitle = await page.title();
      bodyLength = await page.evaluate(() => document.body?.innerHTML?.length || 0);
    } catch (e) {
      // страница могла уйти в очередной редирект прямо в этот момент — не критично
      console.warn('[player-capture] не удалось прочитать title/body:', e.message);
    }
    console.log('[player-capture] заголовок страницы:', pageTitle);
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

              if (requestedEpisode && adapter?.mode === 'dropdown') {
      // режим kinogo/allplay: серия переключается через дропдаун по тексту
      const playerContext = await findPlayerContext(page, adapter.markerSelector);
      console.log('[player-capture] контекст плеера (dropdown) найден:', !!playerContext);

      if (playerContext) {
        // сбрасываем старые потоки — иначе после смены серии в ответе
        // может остаться master.m3u8 от предыдущей серии
        foundStreams.length = 0;
        try {
          const clicked = await selectDropdownOptionByNumber(
            playerContext,
            adapter.episodeDropdownTrigger,
            adapter.episodeListContainer,
            requestedEpisode
          );
          console.log('[player-capture] клик по серии', requestedEpisode, 'выполнен:', clicked);
          if (!clicked) {
            console.warn('[player-capture] пункт серии', requestedEpisode, 'не найден в дропдауне');
            const listHtml = await playerContext
              .evaluate((sel) => document.querySelector(sel)?.outerHTML?.slice(0, 2000) || '(пусто)', adapter.episodeListContainer)
              .catch(() => '(не удалось получить HTML)');
            console.log('[player-capture] HTML списка серий для отладки:', listHtml);
          }
        } catch (e) {
          console.error('[player-capture] ошибка переключения серии (dropdown):', e.message);
        }
      } else {
        console.warn('[player-capture] не найден контекст плеера (markerSelector не сработал)');
      }

      // ждём, пока новый .m3u8 для выбранной серии успеет засветиться в сети
      await new Promise(r => setTimeout(r, 5000));
    } else if (requestedEpisode && adapter?.playerFrameMatch) {
      // режим rezka: фрейм по домену + дропдаун с data-id
      let targetFrame = null;
      for (let i = 0; i < 10; i++) {
        targetFrame = page.frames().find((f) => adapter.playerFrameMatch(f.url()));
        if (targetFrame) break;
        await new Promise(r => setTimeout(r, 500));
      }

      console.log('[player-capture] найден фрейм плеера:', !!targetFrame, targetFrame?.url());

      if (targetFrame) {
        try {
          try {
            await targetFrame.waitForSelector(adapter.episodeDropdownTrigger, { timeout: 10000 });
            console.log('[player-capture] дропдаун серий появился');
          } catch (waitErr) {
            console.warn('[player-capture] дропдаун не появился, дампим HTML iframe:', waitErr.message);
            const frameHtml = await targetFrame.evaluate(() => document.body.innerHTML).catch(() => '(не удалось получить HTML)');
            console.log('[player-capture] HTML внутри iframe (первые 3000 символов):', frameHtml.slice(0, 3000));
            throw waitErr;
          }

          playerApiData = null;
          foundStreams.length = 0;
          await targetFrame.click(adapter.episodeDropdownTrigger);
          await new Promise(r => setTimeout(r, 800));
          await targetFrame.waitForSelector(adapter.episodeListSelector, { timeout: 5000 });

          const episodeBtn = await targetFrame.$(adapter.episodeButtonSelector(requestedEpisode));
          if (episodeBtn) {
            await episodeBtn.click();
            console.log('[player-capture] клик по кнопке серии', requestedEpisode, 'выполнен');
          } else {
            console.warn('[player-capture] кнопка серии не найдена для id', requestedEpisode);
          }
        } catch (e) {
          console.error('[player-capture] ошибка переключения серии:', e.message);
        }
      } else {
        console.warn('[player-capture] фрейм плеера не найден для переключения серии');
      }

      await new Promise(r => setTimeout(r, 5000));

      console.log('[player-capture] playerApiData после клика получен:', !!playerApiData);
      if (!playerApiData) {
        console.warn('[player-capture] после клика новый JSON так и не пришёл — переключение не сработало');
      }
    } else {
      if (requestedEpisode) {
        console.warn('[player-capture] нет адаптера переключения серий для сайта', siteName);
      }
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
      els.map((el) => el.getAttribute('data-lazy-src') || el.src).filter(Boolean)
    );

    console.log('[player-capture] все iframe на странице:', iframes); // ← смотри в pm2 logs

    // парсим график серий — селектор и парсер берём из адаптера конкретного сайта
          // определяем сезоны/серии — способ зависит от режима адаптера сайта
    let seasonsFound = [1];
    let totalEpisodes = 1;

    if (adapter?.mode === 'dropdown') {
      // kinogo/allplay: считаем количество пунктов прямо в дропдаунах плеера
      const playerContext = await findPlayerContext(page, adapter.markerSelector);
      console.log('[player-capture] контекст плеера для чтения meta найден:', !!playerContext);

      if (playerContext) {
        try {
          if (adapter.seasonDropdownTrigger) {
            const seasonTexts = await readDropdownTexts(playerContext, adapter.seasonDropdownTrigger, adapter.seasonListContainer);
            console.log('[player-capture] пункты сезонов:', seasonTexts);
            const seasonNums = seasonTexts.map((t) => Number((t.match(/\d+/) || [])[0])).filter((n) => !Number.isNaN(n));
            if (seasonNums.length) seasonsFound = seasonNums;
          }

          const episodeTexts = await readDropdownTexts(playerContext, adapter.episodeDropdownTrigger, adapter.episodeListContainer);
          console.log('[player-capture] пункты серий:', episodeTexts);
          const episodeNums = episodeTexts.map((t) => Number((t.match(/\d+/) || [])[0])).filter((n) => !Number.isNaN(n));
          if (episodeNums.length) totalEpisodes = Math.max(...episodeNums);
        } catch (e) {
          console.error('[player-capture] ошибка чтения дропдаунов сезон/серия:', e.message);
        }
      }
    } else if (adapter?.scheduleRowSelector) {
      // rezka: расписание берём из таблицы на странице
      const episodesData = await page.$$eval(
        adapter.scheduleRowSelector,
        (rows, parserBody) => {
          const parser = new Function('row', parserBody);
          return rows.map(parser).filter((e) => e && e.episode !== null);
        },
        adapter.scheduleRowParserBody
      ).catch((e) => {
        console.error('[player-capture] ошибка парсинга расписания:', e.message);
        return [];
      });

      console.log('[player-capture] распарсенные серии:', episodesData);

      const releasedEpisodes = episodesData.filter((e) => e.released);
      seasonsFound = [...new Set(episodesData.map((e) => e.season))];
      totalEpisodes = releasedEpisodes.length ? Math.max(...releasedEpisodes.map((e) => e.episode)) : 1;
    } else {
      // нет адаптера под этот сайт вообще — дампим кандидатов для будущего адаптера
      const candidateRows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('tr, li, div, button'))
          .filter((el) => /сезон|серия|эпизод/i.test(el.textContent) && el.textContent.length < 200)
          .slice(0, 15)
          .map((el) => ({ tag: el.tagName, className: el.className, dataSelect: el.closest('[data-select]')?.getAttribute('data-select') || null, text: el.textContent.trim().slice(0, 100) }));
      }).catch(() => []);
      console.log('[player-capture] нет адаптера для сайта', siteName, '— кандидаты для нового адаптера:', JSON.stringify(candidateRows, null, 2));
    }

    const KNOWN_HOSTS = [
      'player', 'embed', 'video', 'alloh', 'collaps', 'voidboost',
      'ashdi', 'cdnmovies', 'kodik', 'hdvb', 'eneyida', 'animevost',
      'moonwalk', 'iframe.', 'vid', 'stream', 'tobaco', 'balabolka',
    ];

    // виджеты соцкнопок, счётчики и прочий шум — точно не видеоплееры
    const IGNORED_HOSTS = ['addtoany', 'yadro', 'counter', 'analytics', 'ads'];

    const relevantIframes = iframes.filter(
      (src) => !IGNORED_HOSTS.some((k) => src.includes(k))
    );

    relevantIframes.forEach((src) => {
      if (KNOWN_HOSTS.some((k) => src.includes(k))) {
        foundIframes.push(src);
      }
    });

    // если по ключевым словам ничего не подошло, но релевантные iframe есть —
    // отдаём их как есть, чтобы фронт хотя бы попытался отрендерить
    if (foundIframes.length === 0 && relevantIframes.length > 0) {
      foundIframes.push(...relevantIframes.filter((src) => !src.startsWith('about:blank')));
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
      currentEpisode: requestedEpisode || 1,
      totalEpisodes,
      voices: [],
    };

    const success = uniqueStreams.length > 0 || uniqueIframes.length > 0;

    const responseData = {
      success,
      streams: uniqueStreams,
      playerIframes: uniqueIframes,
      meta,
      message: success
        ? `Найдено потоков: ${uniqueStreams.length}, iframe: ${uniqueIframes.length}`
        : 'Ничего не найдено',
    };

    // кэшируем только успешный результат — ошибку нет смысла хранить, вдруг в следующий раз получится
    if (roomCode && success) {
      playerCaptureCache.set(roomCode, requestedEpisodeForCache, responseData);
    }

    res.json(responseData);
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

module.exports = router;