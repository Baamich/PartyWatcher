// playerCapture.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

let puppeteer = null;
try {
  const puppeteerCore = require('puppeteer-core');
  const { addExtra } = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer = addExtra(puppeteerCore);
  puppeteer.use(StealthPlugin());
} catch (e) {
  console.warn('[player-capture] puppeteer-core/stealth не установлены:', e.message);
}

const playerCaptureCache = require('../services/playerCaptureCache');
const siteAdapters = require('../services/site-adapters');
const { findPlayerContext, readDropdownTexts, selectDropdownOptionByNumber } = require('../services/dropdown-player');

const fetch = require('cross-fetch');
const { PuppeteerBlocker } = require('@cliqz/adblocker-puppeteer');

// Настоящий adblock-движок (те же списки фильтров, что у AdGuard/uBlock —
// EasyList + EasyPrivacy), а не наивный список доменов. Важно: рекламные
// скрипты на Rezka "зеркалируются" под постоянно меняющимися доменами
// (franecki.net, ad2the.net, get2.fun, botsford.link, stawkibet4.io...) —
// статичный список доменов устаревает за считанные дни. Фильтр-листы вместо
// этого матчят по URL-паттернам (например "point/?method=video_link",
// "gfp=", "adtag="), которые остаются стабильными даже когда домен меняется.
// Скачиваем списки один раз при старте сервера и переиспользуем между запросами.
let adblockerPromise = null;
function getAdblocker() {
  if (!adblockerPromise) {
    adblockerPromise = PuppeteerBlocker.fromLists(fetch, [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/adservers.txt',
    ]).catch((e) => {
      console.error('[player-capture] не удалось загрузить фильтр-листы adblocker:', e.message);
      adblockerPromise = null; // разрешаем повторную попытку при следующем запросе
      return null;
    });
  }
  return adblockerPromise;
}

function detectSite(url) {
  const lower = url.toLowerCase();
  if (lower.includes('rezka') || lower.includes('hdrezka')) return 'rezka';
  if (lower.includes('kinogo')) return 'kinogo';
  if (lower.includes('lordfilm') || lower.includes('lordserial')) return 'lordfilm';
  if (lower.includes('yandex.ru/video')) return 'yandex';
  if (lower.includes('my.mail.ru')) return 'mailru';
  return 'unknown';
}

// защита от дублей: если для одной комнаты+серии уже выполняется /extract,
// повторный запрос просто ждёт результат первого, вместо запуска второго
// Puppeteer+прокси параллельно (что удваивает нагрузку и путает логи)
const inFlightExtracts = new Map(); // key: `${roomCode}:${episode}` → Promise

/**
 * Кликает по #cdnplayer-container несколько раз подряд, проверяя после каждого клика,
 * не появился ли фрейм плеера (adapter.playerFrameMatch). Нужно потому что:
 * 1) плеер грузится лениво — без клика фрейм вообще не появится;
 * 2) первый клик на Rezka почти всегда открывает рекламный оверлей (ставки/казино),
 *    а не сам плеер — поэтому кликаем несколько раз с паузами;
 * 3) реклама иногда открывается отдельной вкладкой (window.open), а не фреймом внутри
 *    страницы — на время кликов слушаем событие 'popup' и сразу закрываем такие вкладки,
 *    чтобы они не мешали.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} adapter - адаптер сайта, обязателен playerFrameMatch
 * @param {string} logLabel - префикс для логов, чтобы отличать сценарий (серия/фильм)
 * @param {number} maxAttempts - сколько раз кликать максимум
 * @returns {Promise<boolean>} true если фрейм плеера найден после кликов
 */
async function clickPlayerAndWaitFrame(page, adapter, logLabel, maxAttempts = 5) {
  // Реальное колесо мыши вместо scrollIntoView() — некоторые сайты отличают
  // программный скролл от настоящего и используют это как сигнал для антибота.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaY: 300 });
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 200));
  }
  await new Promise((r) => setTimeout(r, 500));

  const box = await page.evaluate(() => {
    const el = document.querySelector('#cdnplayer-container');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!box) {
    console.warn(`[player-capture] (${logLabel}) #cdnplayer-container не найден на странице`);
    return false;
  }

  // движение мыши по нескольким промежуточным точкам вместо телепортации курсора —
  // резкий прыжок координат без движения является явным признаком автоматизации
  const startX = 100 + Math.random() * 200;
  const startY = 100 + Math.random() * 200;
  await page.mouse.move(startX, startY);
  await page.mouse.move(box.x, box.y, { steps: 25 });
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));

  const popupCloser = (popup) => {
    console.log(`[player-capture] (${logLabel}) обнаружен рекламный попап, закрываю:`, popup.url());
    popup.close().catch(() => {});
  };
  page.on('popup', popupCloser);

  try {
    // С adblocker'ом рекламный скрипт не должен успевать перехватить клик —
    // ждём короче, но оставляем возможность повторного клика на случай,
    // если что-то всё же проскочило мимо фильтров.
    await page.mouse.click(box.x, box.y);
    console.log(`[player-capture] (${logLabel}) первый клик по #cdnplayer-container выполнен, жду...`);

    const totalWaitMs = 10000;
    const pollEveryMs = 1000;
    let waited = 0;

    while (waited < totalWaitMs) {
      await new Promise((r) => setTimeout(r, pollEveryMs));
      waited += pollEveryMs;

      if (page.frames().some((f) => adapter.playerFrameMatch(f.url()))) {
        console.log(`[player-capture] (${logLabel}) balabolka найдена после ${waited}мс ожидания`);
        return true;
      }
    }

    // если за долгое ожидание ничего не произошло — пробуем ещё один клик
    // (реклама могла зависнуть и не закрыться сама, второй клик иногда её пропускает)
    console.warn(`[player-capture] (${logLabel}) плеер не появился за ${totalWaitMs}мс, пробую повторный клик`);
    await page.mouse.click(box.x, box.y);
    await new Promise((r) => setTimeout(r, 5000));

    const foundAfterRetry = page.frames().some((f) => adapter.playerFrameMatch(f.url()));
    if (foundAfterRetry) {
      console.log(`[player-capture] (${logLabel}) balabolka найдена после повторного клика`);
    } else {
      console.warn(`[player-capture] (${logLabel}) плеер так и не появился`);
    }
    return foundAfterRetry;
  } catch (e) {
    console.error(`[player-capture] (${logLabel}) ошибка клика по #cdnplayer-container:`, e.message);
    return false;
  } finally {
    page.off('popup', popupCloser);
  }
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

    // зритель: только кэш, puppeteer не трогаем
    if (req.body.onlyCache) {
      return res.json({
        success: false,
        error: 'Поток ещё не готов — подожди хоста',
        streams: [],
        playerIframes: [],
        meta: null,
      });
    }
  }

  // если для этой же комнаты+серии уже выполняется extract прямо сейчас —
  // не запускаем второй Puppeteer параллельно, а просто ждём результат первого
  const inFlightKey = roomCode ? `${roomCode}:${requestedEpisodeForCache || 1}` : null;
  if (inFlightKey && inFlightExtracts.has(inFlightKey)) {
    console.log('[player-capture] extract уже выполняется для', inFlightKey, '— жду результат вместо повторного запуска');
    try {
      const result = await inFlightExtracts.get(inFlightKey);
      return res.json(result);
    } catch (e) {
      return res.json({ success: false, error: e.message, streams: [], playerIframes: [], meta: null });
    }
  }

  let browser = null;
  let resolveInFlight, rejectInFlight;
  if (inFlightKey) {
    const promise = new Promise((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    inFlightExtracts.set(inFlightKey, promise);
  }

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

    // подключаем настоящий adblock-движок (см. getAdblocker выше) — блокирует
    // сами рекламные/трекинговые скрипты по сигнатурам, а не по домену,
    // так что клик по плееру доходит до реального контента, а не до рекламы
    const blocker = await getAdblocker();
    if (blocker) {
      await blocker.enableBlockingInPage(page);
      console.log('[player-capture] adblocker подключен к странице');
    } else {
      console.warn('[player-capture] adblocker недоступен — работаем без него');
    }

    // рекламные CDN, которые Rezka показывает поверх плеера при первом клике —
    // если поток пришёл отсюда, это реклама (ставки/казино), а не фильм.
    // Оставляем как доп. страховку — вдруг что-то проскочит мимо adblocker'а.
    const AD_STREAM_HOSTS = ['botsford.link', 'r.botsford', 'adv.', '.bet', 'casino'];

    const foundStreams = [];
    const foundIframes = [];

    let playerApiData = null; // ← сюда попадёт JSON от balabolka.stravers.live/bnsi/movies/<id>

    page.on('response', async (response) => {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (reqUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
        foundStreams.push({ type: 'hls', url: reqUrl });
      }
      if (
        reqUrl.includes('.mp4') &&
        contentType.includes('video') &&
        !reqUrl.includes('blank.mp4') &&
        !AD_STREAM_HOSTS.some((h) => reqUrl.includes(h))
      ) {
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
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    } catch (navErr) {
      console.error('[player-capture] ошибка навигации:', navErr.message, 'at', url);
    }

    console.log('[player-capture] HTTP статус:', response ? response.status() : 'нет ответа');
    console.log('[player-capture] финальный URL после редиректов:', page.url());

    // антибот-заглушка Rezka показывает короткую страницу с этим текстом,
    // сама себя обычно редиректит через несколько секунд после JS-проверки —
    // ждём и пробуем перечитать страницу ещё раз
    try {
      const initialTitle = await page.title();
      if (/не бот|checking|just a moment/i.test(initialTitle)) {
        console.warn('[player-capture] похоже на антибот-заглушку, жду 8 сек и перезахожу...');
        await new Promise(r => setTimeout(r, 8000));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
          console.error('[player-capture] повторный заход не удался:', e.message);
        });
        console.log('[player-capture] заголовок после повторного захода:', await page.title().catch(() => '?'));
      }
    } catch (e) {
      console.warn('[player-capture] ошибка проверки антибот-заглушки:', e.message);
    }

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

    // --- вкладки плееров (Kinogo и похожие: Смотреть онлайн / 4K Качество / ...) ---
    let playersFound = [];
    if (adapter?.playerTabsSelector) {
      try {
        playersFound = await page.$$eval(adapter.playerTabsSelector, (lis) =>
          lis
            .map((li) => ({
              label: (li.textContent || '').trim(),
              src: li.getAttribute('data-src') || '',
              tab: li.getAttribute('data-tab') || '',
            }))
            .filter((p) => p.label && p.src && !/трейлер/i.test(p.label))
        );
        console.log('[player-capture] найдены плееры:', playersFound.map((p) => p.label));
      } catch (e) {
        console.warn('[player-capture] не удалось прочитать вкладки плееров:', e.message);
      }
    }

    const requestedPlayer = (req.body.player || '').trim();
    if (requestedPlayer && playersFound.length) {
      const target = playersFound.find(
        (p) => p.label.toLowerCase() === requestedPlayer.toLowerCase()
      );
      if (target) {
        console.log('[player-capture] переключаю на плеер:', target.label);
        foundStreams.length = 0;
        playerApiData = null;
        try {
          await page.evaluate((label) => {
            const lis = Array.from(document.querySelectorAll('ul.tabs li[data-src]'));
            const li = lis.find((el) => (el.textContent || '').trim() === label);
            if (li) li.click();
          }, target.label);
          await new Promise((r) => setTimeout(r, 6000));
        } catch (e) {
          console.error('[player-capture] ошибка клика по вкладке плеера:', e.message);
        }
      } else {
        console.warn('[player-capture] запрошенный плеер не найден:', requestedPlayer);
      }
    }

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
      // плеер лениво грузится только по клику по #cdnplayer-container — без этого
      // фрейм balabolka никогда не появится, сколько его ни жди.
      await clickPlayerAndWaitFrame(page, adapter, 'серия');

      // режим rezka: фрейм по домену + дропдаун с data-id
      let targetFrame = null;
      for (let i = 0; i < 20; i++) {
        targetFrame = page.frames().find((f) => adapter.playerFrameMatch(f.url()));
        if (targetFrame) break;
        if (i === 9) {
          console.log('[player-capture] плеер ещё не найден на середине ожидания, текущие фреймы:', page.frames().map((f) => f.url()));
        }
        await new Promise(r => setTimeout(r, 1000));
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

      // Сайты с известным playerFrameMatch (например Rezka/balabolka) обычно
      // грузят плеер сами по себе, без клика — а общий клик по ".play"/"[class*=play]"
      // на таких сайтах слишком часто попадает по рекламному оверлею.
      // Это триггерит верхнеуровневую навигацию через прокси, которая падает
      // (рекламный домен заблокирован/недоступен) и убивает уже загруженный плеер
      // (весь фрейм улетает в chrome-error). Поэтому для таких сайтов вообще
      // пропускаем кликанье по общим классам и жмём точечно по контейнеру плеера.
      const skipGenericClick = !!adapter?.playerFrameMatch;

      if (skipGenericClick) {
        await clickPlayerAndWaitFrame(page, adapter, 'фильм');
      } else {
        // пробуем кликнуть по типичным play-кнопкам/превьюшкам, если плеер лениво грузится
        const playSelectors = [
          '.play-btn', '.player-play', '.b-player__control', '.play', '#play',
          '[class*="play"]', '.video-play-button',
          '#cdnplayer-container', '.b-post__player', '#player',
        ];
        let clickedPlaySelector = false;
        for (const sel of playSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.click({ delay: 100 }).catch(() => {});
              console.log('[player-capture] клик по селектору плеера:', sel);
              clickedPlaySelector = true;
              break;
            }
          } catch (e) {}
        }

        // fallback: если ни один селектор не найден — используем ту же логику
        // клика+ожидания фрейма, что и для Rezka (сработает, только если у адаптера
        // вообще есть playerFrameMatch — для остальных сайтов просто ничего не сделает)
        if (!clickedPlaySelector && adapter?.playerFrameMatch) {
          await clickPlayerAndWaitFrame(page, adapter, 'фильм-fallback');
        }
      }

      // некоторые сайты (yandex-превью, my.mail.ru) отдают видео через чужой
      // iframe-плеер — обычный page.$() внутрь фрейма не заглядывает. Если у
      // адаптера есть frameMatch — ищем такой фрейм отдельно и жмём play уже в нём.
      if (adapter?.frameMatch) {
        let embedFrame = null;
        for (let i = 0; i < 10; i++) {
          embedFrame = page.frames().find((f) => adapter.frameMatch(f.url()));
          if (embedFrame) break;
          await new Promise(r => setTimeout(r, 500));
        }
        console.log('[player-capture] найден embed-фрейм для клика:', !!embedFrame, embedFrame?.url());

        if (embedFrame && adapter.playSelector) {
          try {
            const el = await embedFrame.$(adapter.playSelector);
            if (el) {
              await el.click({ delay: 100 }).catch(() => {});
              console.log('[player-capture] клик по play внутри embed-фрейма выполнен');
            } else {
              console.warn('[player-capture] play-кнопка не найдена внутри embed-фрейма');
            }
          } catch (e) {
            console.error('[player-capture] ошибка клика внутри embed-фрейма:', e.message);
          }
        }

        // embed-плеерам через прокси нужно больше времени на подгрузку потока
        await new Promise(r => setTimeout(r, 4000));
      }

      // rezka/кастомным CDN-плеерам без явного episode-режима нужно больше времени на разворачивание
      await new Promise(r => setTimeout(r, 8000));

      // фильмы (без requestedEpisode) тоже используют balabolka — на случай, если
      // clickPlayerAndWaitFrame выше не успел поймать фрейм с первого раза, даём
      // ещё немного времени и логируем итог для отладки. Исключаем декой-фреймы
      // вида /series/.../....html (виджеты "похожие релизы") — они уже отсеяны
      // самим adapter.playerFrameMatch.
      if (adapter?.playerFrameMatch) {
        let movieFrame = page.frames().find((f) => adapter.playerFrameMatch(f.url()));
        if (!movieFrame) {
          for (let i = 0; i < 10; i++) {
            movieFrame = page.frames().find((f) => adapter.playerFrameMatch(f.url()));
            if (movieFrame) break;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        console.log('[player-capture] (фильм) найден фрейм плеера:', !!movieFrame, movieFrame?.url());
        if (!movieFrame) {
          console.log('[player-capture] (фильм) все фреймы на странице:', page.frames().map((f) => f.url()));
        }
      }
    }

    const iframes = await page.$$eval('iframe', (els) =>
      els.map((el) => el.getAttribute('data-lazy-src') || el.src).filter(Boolean)
    );

    console.log('[player-capture] все iframe на странице:', iframes); // ← смотри в pm2 logs
    console.log('[player-capture] все фреймы страницы (frames()):', page.frames().map((f) => f.url()));

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
    } else if (!adapter) {
      // нет адаптера под этот сайт вообще — дампим кандидатов для будущего адаптера
      const candidateRows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('tr, li, div, button'))
          .filter((el) => /сезон|серия|эпизод/i.test(el.textContent) && el.textContent.length < 200)
          .slice(0, 15)
          .map((el) => ({ tag: el.tagName, className: el.className, dataSelect: el.closest('[data-select]')?.getAttribute('data-select') || null, text: el.textContent.trim().slice(0, 100) }));
      }).catch(() => []);
      console.log('[player-capture] нет адаптера для сайта', siteName, '— кандидаты для нового адаптера:', JSON.stringify(candidateRows, null, 2));
    }
    // адаптер есть, но mode:null (например yandex) — доп. парсинг серий не нужен, молча пропускаем

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
      players: playersFound.map((p) => p.label),
      currentPlayer: requestedPlayer || (playersFound[0]?.label || null),
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
    if (inFlightKey) resolveInFlight(responseData);
  } catch (err) {
    console.error('[player-capture puppeteer]', err.message);
    const errorData = {
      success: false,
      error: err.message,
      streams: [],
      playerIframes: [],
      meta: null,
    };
    res.json(errorData);
    if (inFlightKey) resolveInFlight(errorData); // резолвим (не реджектим), чтобы ждущие запросы получили тот же ответ с ошибкой
  } finally {
    if (browser) await browser.close();
    if (inFlightKey) inFlightExtracts.delete(inFlightKey);
  }
});

module.exports = router;