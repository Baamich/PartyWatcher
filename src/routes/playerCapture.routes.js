// playerCapture.routes.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const auth = require('../middleware/auth');

// папка для отладочных скриншотов — внутри проекта, чтобы отдавать через статику
// Express и смотреть в браузере, без scp/ssh (см. подключение статики в server.js)
const debugScreenshotsDir = path.join(process.cwd(), 'debug-screenshots');
if (!fs.existsSync(debugScreenshotsDir)) fs.mkdirSync(debugScreenshotsDir, { recursive: true });

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


let adblockerPromise = null;
function getAdblocker() {
  if (!adblockerPromise) {
    adblockerPromise = PuppeteerBlocker.fromLists(fetch, [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/BaseFilter/sections/adservers.txt',
      'https://filters.adtidy.org/extension/chromium/filters/18.txt',
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
  // короткий скролл — хватает, чтобы контейнер попал в зону
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel({ deltaY: 400 });
    await new Promise((r) => setTimeout(r, 100));
  }

  const box = await page.evaluate(() => {
    const el = document.querySelector('#cdnplayer-container') ||
               document.querySelector('#cdnplayer') ||
               document.querySelector('.b-player__holder_cdn') ||
               document.querySelector('.b-player');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!box) {
    console.warn(`[player-capture] (${logLabel}) контейнер плеера не найден на странице`);
    return false;
  }

  await page.mouse.move(box.x, box.y, { steps: 8 });
  await new Promise((r) => setTimeout(r, 150));

  const popupCloser = async (popup) => {
    try {
      const u = popup.url() || '';
      // support/premium на том же домене — не трогаем, закрытие иногда роняет страницу
      if (/support\.html|premium|#pp\d/i.test(u) || u.includes('rezka.')) {
        console.log(`[player-capture] (${logLabel}) попап rezka, игнор:`, u);
        return;
      }
      console.log(`[player-capture] (${logLabel}) рекламный попап, закрываю:`, u);
      await popup.close().catch(() => {});
    } catch (_) {}
  };
  page.on('popup', popupCloser);

  try {
    await page.mouse.click(box.x, box.y);
    console.log(`[player-capture] (${logLabel}) клик по контейнеру плеера, жду...`);

    const totalWaitMs = 5000;
    const pollEveryMs = 400;
    let waited = 0;

    while (waited < totalWaitMs) {
      await new Promise((r) => setTimeout(r, pollEveryMs));
      waited += pollEveryMs;

      const hasIframe = adapter?.playerFrameMatch
        ? page.frames().some((f) => adapter.playerFrameMatch(f.url()))
        : false;

      const hasNativeVideo = await page.evaluate(() => !!(
        document.querySelector('#oframecdnplayer video') ||
        document.querySelector('#cdnplayer video') ||
        document.querySelector('#cdnplayer-container video') ||
        document.querySelector('.b-player video')
      ));

      if (hasIframe || hasNativeVideo) {
        console.log(`[player-capture] (${logLabel}) плеер найден за ${waited}мс`);
        return true;
      }
    }

    // один быстрый retry
    console.warn(`[player-capture] (${logLabel}) не появился за ${totalWaitMs}мс, повторный клик`);
    await page.mouse.click(box.x, box.y);
    await new Promise((r) => setTimeout(r, 900));

    const ok = adapter?.playerFrameMatch
      ? page.frames().some((f) => adapter.playerFrameMatch(f.url()))
      : false;
    const okNative = await page.evaluate(() => !!(
      document.querySelector('#oframecdnplayer video') ||
      document.querySelector('#cdnplayer video') ||
      document.querySelector('.b-player video')
    ));
    return ok || okNative;
  } catch (e) {
    console.error(`[player-capture] (${logLabel}) ошибка клика:`, e.message);
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
  let requestedEpisodeForCache = req.body.episode ? Number(req.body.episode) : null;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Нужна валидная ссылка' });
  }

  // если episode не передали в body — пробуем вытащить из хеша Rezka:
  // #t:440-s:1-e:2  или  #t:440-s:1-e2  или  #t:440-s:1-e:1
  if (!requestedEpisodeForCache) {
    const hashMatch = url.match(/[#&](?:e|episode)[=:]?(\d+)/i) ||
                      url.match(/-e[=:]?(\d+)/i) ||
                      url.match(/e[=:](\d+)/i);
    if (hashMatch) {
      requestedEpisodeForCache = Number(hashMatch[1]);
      console.log('[player-capture] episode взят из URL-хеша:', requestedEpisodeForCache);
    }
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

      // логируем каждый заблокированный запрос — нужно увидеть, действительно ли
      // adblocker режет рекламный редирект (или, наоборот, случайно блокирует
      // что-то из настоящего плеера balabolka)
      blocker.on('request-blocked', (request) => {
        console.log('[adblock] заблокирован запрос:', request.url);
      });
      blocker.on('request-redirected', (request) => {
        console.log('[adblock] редирект запроса (например анти-трекинг):', request.url);
      });
    } else {
      console.warn('[player-capture] adblocker недоступен — работаем без него');
    }

    // рекламные CDN, которые Rezka показывает поверх плеера при первом клике —
    // если поток пришёл отсюда, это реклама (ставки/казино), а не фильм.
    // Оставляем как доп. страховку — вдруг что-то проскочит мимо adblocker'а.
    const AD_STREAM_HOSTS = ['botsford.link', 'r.botsford', 'adv.', '.bet', 'casino'];

    const foundStreams = [];
    const foundIframes = [];
    // потоки ТОЛЬКО из get_cdn_series — им доверяем больше, чем случайным .m3u8 из сети
    const cdnSeriesStreams = [];

    let playerApiData = null; // ← сюда попадёт JSON от balabolka.stravers.live/bnsi/movies/<id>

    page.on('response', async (response) => {
    const reqUrl = response.url();
    const contentType = response.headers()['content-type'] || '';

    // DEBUG: все ajax rezka
    if (reqUrl.includes('/ajax/') || reqUrl.includes('get_cdn') || reqUrl.includes('voidboost')) {
      console.log('[player-capture] NET:', response.status(), reqUrl.slice(0, 180));
    }

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

    // ловим JSON от balabolka
    if (reqUrl.includes('/bnsi/movies/') && contentType.includes('application/json')) {
      try {
        const json = await response.json();
        if (json && json.hlsSource) {
          console.log('[player-capture] найден JSON плеера balabolka:', reqUrl);
          playerApiData = json;
        }
      } catch (e) {}
    }

        // === ловим ответ Rezka CDN — это ГЛАВНЫЙ источник потоков ===
    if (
      reqUrl.includes('/ajax/get_cdn_series') ||
      reqUrl.includes('get_cdn_series') ||
      reqUrl.includes('/ajax/get_cdn') ||
      reqUrl.includes('get_cdn_movie') ||
      reqUrl.includes('get_movie')
    ) {
      try {
        const json = await response.json();
        if (json && json.url) {
          console.log('[player-capture] найден get_cdn_series:', String(json.url).slice(0, 200));

          // формат: [1080p]https://...m3u8 or https://...mp4,[720p]https://...
          // сначала режем по запятой (качества), потом внутри берём первую http-ссылку
          const parts = String(json.url).split(',');
          for (const part of parts) {
            const qualityMatch = part.match(/\[(\d+p?)\]/i);
            const quality = qualityMatch ? qualityMatch[1] : undefined;

            // берём первую https-ссылку в куске (до " or " / пробела, если есть)
            const urlMatch = part.match(/https?:\/\/[^\s,]+/i);
                        if (urlMatch) {
              let streamUrl = urlMatch[0].trim();
              // иногда в конце лишняя скобка/кавычка
              streamUrl = streamUrl.replace(/["')]+$/, '');

              // отсекаем мусор: иконки, картинки, css, js
              const lower = streamUrl.toLowerCase();
              if (
                lower.includes('.svg') ||
                lower.includes('.png') ||
                lower.includes('.jpg') ||
                lower.includes('.jpeg') ||
                lower.includes('.gif') ||
                lower.includes('.webp') ||
                lower.includes('.css') ||
                lower.includes('.js') ||
                lower.includes('prem-icon') ||
                lower.includes('/images/')
              ) {
                continue;
              }

              if (streamUrl.startsWith('http')) {
                const entry = {
                  type: streamUrl.includes('.mp4') ? 'mp4' : 'hls',
                  url: streamUrl,
                  quality: quality || undefined,
                };
                cdnSeriesStreams.push(entry);
                foundStreams.push(entry);
                console.log('[player-capture] CDN stream:', quality || '?', streamUrl.slice(0, 100));
              }
            }
          }
        }
      } catch (e) {
        // бывает, что ответ не json — игнорируем
      }
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
      const isAntibot = async () => {
        const t = (await page.title().catch(() => '')).toLowerCase();
        const len = await page.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
        return (
          len < 15000 ||
          /не бот|проверяем|checking your browser|just a moment|attention required|cloudflare|captcha/i.test(t)
        );
      };

      if (await isAntibot()) {
        console.warn('[player-capture] антибот-заглушка (title/body), жду и перезахожу...');
        // даём JS антибота отработать
        await new Promise((r) => setTimeout(r, 6000));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
          console.error('[player-capture] повторный заход не удался:', e.message);
        });
        await new Promise((r) => setTimeout(r, 2000));

        // второй шанс
        if (await isAntibot()) {
          console.warn('[player-capture] всё ещё антибот, ещё 5 сек...');
          await new Promise((r) => setTimeout(r, 5000));
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        }

        console.log(
          '[player-capture] после антибота:',
          await page.title().catch(() => '?'),
          'body:',
          await page.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0)
        );
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

    // сохраняем скриншот в папку проекта (не /tmp) и отдаём через статику Express —
    // так его можно открыть прямо в браузере по ссылке, без scp/ssh-ключей
    if (process.env.PLAYER_CAPTURE_DEBUG === '1') {
      try {
        await page.screenshot({ path: path.join(debugScreenshotsDir, 'before-click.png') });
        console.log('[player-capture] скриншот сохранён: debug-screenshots/before-click.png');
      } catch (e) {}
    }

        try {
      await page.waitForSelector('#cdnplayer-container, #cdnplayer, .b-player', { timeout: 2500 });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 800));

    // ============================================================
    // REZKA: прямой AJAX get_cdn_series (фильм + сериал)
    // ============================================================
    if (siteName === 'rezka') {
      try {
                const pageMeta = await page.evaluate(() => {
          const postId =
            document.querySelector('#post_id')?.value ||
            document.querySelector('[name="post_id"]')?.value ||
            document.querySelector('[data-id]')?.getAttribute('data-id') ||
            (location.pathname.match(/\/(\d+)-/) || [])[1] ||
            null;

          // все возможные места translator_id
          const translators = [];
          const seen = new Set();

          const push = (id, name, active, premium) => {
            if (!id || seen.has(String(id))) return;
            seen.add(String(id));
            translators.push({
              id: String(id),
              name: (name || '').trim().replace(/\s+/g, ' '),
              active: !!active,
              premium: !!premium,
            });
          };

          // 1) классические кнопки озвучек
          document.querySelectorAll(
            '.b-translator__item[data-translator_id], [data-translator_id], .b-translator__list [data-translator_id]'
          ).forEach((el) => {
            push(
              el.getAttribute('data-translator_id'),
              el.textContent,
              el.classList.contains('active'),
              /prem|premium|pro/i.test(el.className || '') || !!el.querySelector('.prem, .b-prem, [class*="prem"]')
            );
          });

          // 2) sof.tv.initCDNMoviesEvents / initCDNSeriesEvents — может быть несколько вызовов
          for (const s of Array.from(document.scripts)) {
            const txt = s.textContent || '';
            const re = /sof\.tv\.initCDN(?:Movies|Series)Events\(\s*(\d+)\s*,\s*(\d+)/g;
            let m;
            while ((m = re.exec(txt)) !== null) {
              push(m[2], 'sof', false, false);
            }
          }

          // 3) data-translator в любых data-* / onclick
          document.querySelectorAll('[onclick*="translator"], [data-id]').forEach((el) => {
            const oc = el.getAttribute('onclick') || '';
            const m = oc.match(/translator[_-]?id['\":\s=]+(\d+)/i);
            if (m) push(m[1], el.textContent, el.classList.contains('active'), false);
          });

          let sofTranslator = translators[0]?.id || null;

          const activeSeason =
            document.querySelector('.b-simple_season__item.active, .b-simple_seasons__list .active')?.getAttribute('data-tab_id') ||
            document.querySelector('[data-season_id].active')?.getAttribute('data-season_id') ||
            '1';

          const activeEpisode =
            document.querySelector('li.b-simple_episode_item.active, li.b-simple_episode_item.b-simple_episode_item_active')?.getAttribute('data-episode_id') ||
            null;

          return {
            postId: postId,
            translators,
            sofTranslator,
            activeSeason: Number(activeSeason) || 1,
            activeEpisode: activeEpisode ? Number(activeEpisode) : null,
            isSeries: /\/series\//.test(location.pathname) || !!document.querySelector('li.b-simple_episode_item, .b-simple_episodes_list'),
          };
        });

        console.log('[player-capture] rezka pageMeta:', JSON.stringify({
          postId: pageMeta.postId,
          translators: pageMeta.translators.map((t) => `${t.id}:${t.name}${t.active ? '*' : ''}`),
          sofTranslator: pageMeta.sofTranslator,
          activeSeason: pageMeta.activeSeason,
          activeEpisode: pageMeta.activeEpisode,
          isSeries: pageMeta.isSeries,
        }));

                if (pageMeta.postId) {
          // список id для перебора: active non-prem → non-prem → active → остальные → sof
          const idsToTry = [];
          const addId = (id) => {
            if (id && !idsToTry.includes(String(id))) idsToTry.push(String(id));
          };
          pageMeta.translators.filter((t) => t.active && !t.premium).forEach((t) => addId(t.id));
          pageMeta.translators.filter((t) => !t.premium).forEach((t) => addId(t.id));
          pageMeta.translators.filter((t) => t.active).forEach((t) => addId(t.id));
          pageMeta.translators.forEach((t) => addId(t.id));
          addId(pageMeta.sofTranslator);

          // запасные частые id (если на странице вообще пусто)
          if (idsToTry.length === 0) {
            ['110', '1', '56', '238', '111'].forEach(addId);
          }

          console.log('[player-capture] translators to try:', idsToTry);

          const isSeries = pageMeta.isSeries;
          const season = pageMeta.activeSeason || 1;
          const episode = requestedEpisodeForCache || pageMeta.activeEpisode || 1;

          let gotUrl = false;

          for (const translatorId of idsToTry) {
            const form = new URLSearchParams();
            form.set('id', String(pageMeta.postId));
            form.set('translator_id', String(translatorId));
            // некоторые зеркала требуют favs
            form.set('favs', String(Math.floor(Math.random() * 1e8)));
            if (isSeries) {
              form.set('season', String(season));
              form.set('episode', String(episode));
              form.set('action', 'get_stream');
            } else {
              form.set('action', 'get_movie');
            }

            console.log('[player-capture] AJAX get_cdn_series body:', form.toString());

            const cdnJson = await page.evaluate(async (bodyStr) => {
              const res = await fetch('/ajax/get_cdn_series/?t=' + Date.now(), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest',
                },
                body: bodyStr,
                credentials: 'same-origin',
              });
              const text = await res.text();
              try {
                return JSON.parse(text);
              } catch {
                return { _raw: text.slice(0, 300) };
              }
            }, form.toString());

            if (cdnJson?.url && cdnJson.url !== false && String(cdnJson.url).length > 10) {
              console.log('[player-capture] AJAX CDN OK (translator', translatorId, '), url slice:', String(cdnJson.url).slice(0, 180));

              const parts = String(cdnJson.url).split(',');
              for (const part of parts) {
                const qualityMatch = part.match(/\[(\d+p?)\]/i);
                const quality = qualityMatch ? qualityMatch[1] : undefined;
                const urlMatch = part.match(/https?:\/\/[^\s,]+/i);
                if (!urlMatch) continue;

                let streamUrl = urlMatch[0].trim().replace(/["')]+$/, '');
                const lower = streamUrl.toLowerCase();
                if (
                  lower.includes('.svg') || lower.includes('.png') || lower.includes('.jpg') ||
                  lower.includes('.jpeg') || lower.includes('.gif') || lower.includes('.webp') ||
                  lower.includes('.css') || lower.includes('.js') || lower.includes('prem-icon') ||
                  lower.includes('/images/')
                ) continue;

                if (streamUrl.startsWith('http')) {
                  const entry = {
                    type: streamUrl.includes('.mp4') ? 'mp4' : 'hls',
                    url: streamUrl,
                    quality: quality || undefined,
                  };
                  cdnSeriesStreams.push(entry);
                  foundStreams.push(entry);
                  console.log('[player-capture] AJAX CDN stream:', quality || '?', streamUrl.slice(0, 100));
                }
              }
              gotUrl = true;
              break; // хватит одного рабочего translator
            } else {
              console.warn('[player-capture] AJAX translator', translatorId, 'без url:', JSON.stringify(cdnJson).slice(0, 200));
            }
          }

          if (!gotUrl) {
            console.warn('[player-capture] ни один translator не вернул url');
          }
        } else {
          console.warn('[player-capture] post_id не найден на странице');
        }
      } catch (e) {
        console.error('[player-capture] AJAX CDN ошибка:', e.message);
      }
    }

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
          await new Promise((r) => setTimeout(r, 2500));
        } catch (e) {
          console.error('[player-capture] ошибка клика по вкладке плеера:', e.message);
        }
      } else {
        console.warn('[player-capture] запрошенный плеер не найден:', requestedPlayer);
      }
    }

    // используем то же значение, что и для кэша (body или хеш)
    const requestedEpisode = requestedEpisodeForCache;
    const alreadyHaveCdn = cdnSeriesStreams.length > 0;

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
    } else if (requestedEpisode && (adapter?.playerFrameMatch || siteName === 'rezka')) {
      if (alreadyHaveCdn) {
        console.log('[player-capture] CDN уже есть из AJAX, skip клики/переключение серии');
      } else {
      // сначала пытаемся разбудить плеер
      await clickPlayerAndWaitFrame(page, adapter, 'серия');
      // ... весь код этой ветки до её закрывающей }
      } // закрыть else от alreadyHaveCdn

      // --- 1) пробуем старый способ (iframe balabolka) ---
      let targetFrame = null;
      if (adapter?.playerFrameMatch) {
        for (let i = 0; i < 10; i++) {
          targetFrame = page.frames().find((f) => adapter.playerFrameMatch(f.url()));
          if (targetFrame) break;
          if (i === 4) {
            console.log('[player-capture] плеер ещё не найден на середине ожидания, текущие фреймы:', page.frames().map((f) => f.url()));
          }
          await new Promise(r => setTimeout(r, 800));
        }
      }

      console.log('[player-capture] найден фрейм плеера:', !!targetFrame, targetFrame?.url());

      let episodeSwitched = false;

      if (targetFrame) {
        try {
          try {
            await targetFrame.waitForSelector(adapter.episodeDropdownTrigger, { timeout: 8000 });
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
            console.log('[player-capture] клик по кнопке серии', requestedEpisode, 'выполнен (iframe)');
            episodeSwitched = true;
          } else {
            console.warn('[player-capture] кнопка серии не найдена для id', requestedEpisode);
          }
        } catch (e) {
          console.error('[player-capture] ошибка переключения серии в iframe:', e.message);
        }
      }

        // --- 2) fallback для native CDN-player (rezka-ua.tv и похожие) ---
      if (!episodeSwitched) {
        console.log('[player-capture] iframe не найден — пробую native клик по серии на основной странице');

        // проверяем, не является ли запрошенная серия уже активной
        const alreadyActive = await page.evaluate((ep) => {
          const selectors = [
            `li.b-simple_episode_item[data-episode_id="${ep}"]`,
            `li.b-simple_episode_item[data-id][data-episode_id="${ep}"]`,
            `.b-simple_episodes_list li[data-episode_id="${ep}"]`,
            `#simple-episodes-list-1 li[data-episode_id="${ep}"]`,
            `.b-simple_episodes__list li[data-episode_id="${ep}"]`,
          ];
          for (const sel of selectors) {
            const li = document.querySelector(sel);
            if (li && (li.classList.contains('active') || li.classList.contains('b-simple_episode_item_active'))) {
              return true;
            }
          }
          // запасной вариант — если активный элемент вообще есть и его номер совпадает
          const active = document.querySelector('li.b-simple_episode_item.active, li.b-simple_episode_item.b-simple_episode_item_active');
          if (active) {
            const activeEp = Number(active.getAttribute('data-episode_id') || 0);
            return activeEp === Number(ep);
          }
          return false;
        }, requestedEpisode);

        // если CDN уже поймали при load/клике плеера и серия активна — не чистим и не дёргаем
        if (cdnSeriesStreams.length > 0 && alreadyActive) {
          console.log('[player-capture] CDN уже есть для активной серии, skip toggle, потоков:', cdnSeriesStreams.length);
          episodeSwitched = true;
        } else if (alreadyActive) {
          // нужен toggle — только тогда чистим
          playerApiData = null;
          foundStreams.length = 0;
          cdnSeriesStreams.length = 0;
          // серия уже активна → get_cdn_series сам не придёт.
          // Трюк: кликаем любую ДРУГУЮ серию, потом обратно нужную.
          console.log('[player-capture] серия', requestedEpisode, 'уже активна — делаю принудительное переключение туда-обратно');

          const otherEp = await page.evaluate((ep) => {
            const items = Array.from(document.querySelectorAll(
              'li.b-simple_episode_item[data-episode_id], #simple-episodes-list-1 li[data-episode_id]'
            ));
            for (const li of items) {
              const id = Number(li.getAttribute('data-episode_id'));
              if (id && id !== Number(ep)) return id;
            }
            return null;
          }, requestedEpisode);

          if (otherEp) {
            // 1) клик по другой серии (этот поток нам НЕ нужен)
            await page.evaluate((ep) => {
              const li = document.querySelector(
                `li.b-simple_episode_item[data-episode_id="${ep}"], #simple-episodes-list-1 li[data-episode_id="${ep}"]`
              );
              if (li) li.click();
            }, otherEp);
            console.log('[player-capture] временно кликнул серию', otherEp);
            await new Promise((r) => setTimeout(r, 2000));

            playerApiData = null;
            foundStreams.length = 0;
            cdnSeriesStreams.length = 0;
            console.log('[player-capture] потоки от временной серии очищены, кликаю целевую');

            // 2) клик обратно на нужную — ТОЛЬКО её потоки должны остаться
            await page.evaluate((ep) => {
              const li = document.querySelector(
                `li.b-simple_episode_item[data-episode_id="${ep}"], #simple-episodes-list-1 li[data-episode_id="${ep}"]`
              );
              if (li) li.click();
            }, requestedEpisode);
            console.log('[player-capture] клик обратно на серию', requestedEpisode);
            episodeSwitched = true;
          } else {
            console.log('[player-capture] других серий нет, жду поток от уже активного плеера');
            episodeSwitched = true;
          }
        } else {
          // серия другая — чистим старое и кликаем
          playerApiData = null;
          foundStreams.length = 0;
          cdnSeriesStreams.length = 0;

          const clicked = await page.evaluate((ep) => {
            const selectors = [
              `li.b-simple_episode_item[data-episode_id="${ep}"]`,
              `li.b-simple_episode_item[data-id][data-episode_id="${ep}"]`,
              `.b-simple_episodes_list li[data-episode_id="${ep}"]`,
              `#simple-episodes-list-1 li[data-episode_id="${ep}"]`,
              `.b-simple_episodes__list li[data-episode_id="${ep}"]`,
            ];

            for (const sel of selectors) {
              const li = document.querySelector(sel);
              if (li) {
                li.click();
                return sel;
              }
            }
            return null;
          }, requestedEpisode);

          if (clicked) {
            console.log('[player-capture] клик по серии', requestedEpisode, 'выполнен (native), селектор:', clicked);
            episodeSwitched = true;
          } else {
            console.warn('[player-capture] native кнопка серии не найдена для', requestedEpisode);

            const debugList = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('li.b-simple_episode_item, .b-simple_episodes_list li'))
                .slice(0, 15)
                .map((li) => ({
                  text: (li.textContent || '').trim().slice(0, 40),
                  episodeId: li.getAttribute('data-episode_id'),
                  seasonId: li.getAttribute('data-season_id'),
                  className: li.className,
                }));
            }).catch(() => []);
            console.log('[player-capture] найденные элементы серий на странице:', JSON.stringify(debugList, null, 2));
          }
        }
      }

      // ждём get_cdn_series до 4с, выходим раньше если уже есть
      {
        const maxWait = 4000;
        const step = 300;
        let t = 0;
        while (t < maxWait && cdnSeriesStreams.length === 0) {
          await new Promise((r) => setTimeout(r, step));
          t += step;
        }
        console.log('[player-capture] ожидание CDN:', t, 'мс, потоков:', cdnSeriesStreams.length);
      }

      if (cdnSeriesStreams.length > 0) {
        const before = foundStreams.length;
        foundStreams.length = 0;
        const uniq = [...new Map(cdnSeriesStreams.map((s) => [s.url, s])).values()];
        foundStreams.push(...uniq);
        console.log('[player-capture] оставил только CDN-потоки:', foundStreams.length, '(было всего', before, ')');
        foundStreams.forEach((s) => {
          console.log('[player-capture]   →', s.quality || '?', s.url.slice(0, 120));
        });
      }

      // если поток всё ещё пустой — пробуем вытащить src напрямую из <video>
      if (foundStreams.length === 0) {
        const videoSrc = await page.evaluate(() => {
          const v =
            document.querySelector('#oframecdnplayer video') ||
            document.querySelector('#cdnplayer video') ||
            document.querySelector('#cdnplayer-container video') ||
            document.querySelector('.b-player video') ||
            document.querySelector('video');
          if (!v) return null;
          // currentSrc — то, что реально играет; src — атрибут
          return v.currentSrc || v.src || null;
        }).catch(() => null);

        if (videoSrc && (videoSrc.includes('.m3u8') || videoSrc.includes('.mp4'))) {
          console.log('[player-capture] поток взят напрямую из <video>:', videoSrc.slice(0, 180));
          foundStreams.push({
            type: videoSrc.includes('.m3u8') ? 'hls' : 'mp4',
            url: videoSrc,
          });
        } else if (videoSrc) {
          console.log('[player-capture] у <video> есть src, но это не m3u8/mp4:', String(videoSrc).slice(0, 120));
        } else {
          console.warn('[player-capture] у <video> нет usable src');
        }
      }

      console.log('[player-capture] playerApiData после клика получен:', !!playerApiData);
      console.log('[player-capture] foundStreams после ожидания:', foundStreams.length);
      if (!playerApiData && foundStreams.length === 0) {
        console.warn('[player-capture] после клика новый поток так и не пришёл — переключение, скорее всего, не сработало');
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
        await new Promise(r => setTimeout(r, 1500));
      }

      // rezka/кастомным CDN-плеерам без явного episode-режима нужно больше времени на разворачивание
      await new Promise(r => setTimeout(r, 2500));

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
    } else if (adapter?.scheduleRowSelector || siteName === 'rezka') {
      // rezka: сначала пробуем таблицу из адаптера, потом native список серий
      let episodesData = [];

      if (adapter?.scheduleRowSelector) {
        episodesData = await page.$$eval(
          adapter.scheduleRowSelector,
          (rows, parserBody) => {
            const parser = new Function('row', parserBody);
            return rows.map(parser).filter((e) => e && e.episode !== null);
          },
          adapter.scheduleRowParserBody
        ).catch((e) => {
          console.error('[player-capture] ошибка парсинга расписания (адаптер):', e.message);
          return [];
        });
      }

      // fallback — native список серий на странице (rezka-ua.tv и зеркала)
      if (!episodesData.length) {
        episodesData = await page.$$eval(
          'li.b-simple_episode_item, .b-simple_episodes_list li[data-episode_id], #simple-episodes-list-1 li',
          (items) => {
            return items
              .map((li) => {
                const episode = Number(li.getAttribute('data-episode_id') || li.getAttribute('data-id') || 0);
                const season = Number(li.getAttribute('data-season_id') || 1);
                if (!episode) return null;
                return {
                  season,
                  episode,
                  released: !li.classList.contains('disabled') && !li.classList.contains('b-simple_episode_item_disabled'),
                };
              })
              .filter(Boolean);
          }
        ).catch((e) => {
          console.error('[player-capture] ошибка парсинга native списка серий:', e.message);
          return [];
        });
      }

      console.log('[player-capture] распарсенные серии:', episodesData);

      const releasedEpisodes = episodesData.filter((e) => e.released !== false);
      seasonsFound = [...new Set(episodesData.map((e) => e.season).filter(Boolean))];
      if (!seasonsFound.length) seasonsFound = [1];
      totalEpisodes = releasedEpisodes.length
        ? Math.max(...releasedEpisodes.map((e) => e.episode))
        : 1;
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
        } else if (cdnSeriesStreams.length > 0) {
      // Rezka native: только то, что пришло из get_cdn_series
      uniqueStreams = [...new Map(cdnSeriesStreams.map((s) => [s.url, s])).values()]
        .filter((s) => {
          const u = (s.url || '').toLowerCase();
          return !u.includes('.svg') && !u.includes('prem-icon') && !u.includes('/images/');
        });

      // сортировка: 720p → 1080p → 480p → 360p (720 стабильнее для HLS через voidboost)
      const rank = (q) => {
        const n = parseInt(q, 10) || 0;
        if (n === 720) return 1000;
        if (n === 1080) return 900;
        if (n === 480) return 800;
        if (n === 360) return 700;
        return n;
      };
      uniqueStreams.sort((a, b) => rank(b.quality) - rank(a.quality));

      console.log('[player-capture] uniqueStreams из CDN:', uniqueStreams.map((s) => s.quality || s.url.slice(0, 60)));
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