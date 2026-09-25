// streamProxy.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const PROXY_SERVER = process.env.PROXY_SERVER;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;
const { ProxyAgent } = require('undici');

let cachedDispatcher = null;
function buildDispatcher() {
  if (!PROXY_SERVER) return null;
  // переиспользуем один ProxyAgent вместо нового на каждый запрос —
  // экономит handshake и даёт keep-alive пулу реально работать
  if (!cachedDispatcher) {
    cachedDispatcher = new ProxyAgent(`http://${PROXY_USER}:${PROXY_PASS}@${PROXY_SERVER}`);
  }
  return cachedDispatcher;
}
// манифест (плейлист) для VOD не меняется в течение короткого окна —
// кэшируем на 20 сек, чтобы ретраи hls.js (при капризах CDN вроде voidboost)
// не гоняли заново весь перебор referer-кандидатов на каждую попытку
const playlistRawCache = new Map(); // targetUrl → { text, expires }
const PLAYLIST_CACHE_TTL_MS = 20_000;
const PLAYLIST_CACHE_MAX = 100;

function playlistCacheGet(key) {
  const hit = playlistRawCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    playlistRawCache.delete(key);
    return null;
  }
  return hit.text;
}

function playlistCacheSet(key, text) {
  if (playlistRawCache.size >= PLAYLIST_CACHE_MAX) {
    const first = playlistRawCache.keys().next().value;
    if (first) playlistRawCache.delete(first);
  }
  playlistRawCache.set(key, { text, expires: Date.now() + PLAYLIST_CACHE_TTL_MS });
}

// кэш сегментов
const segmentCache = new Map(); // key → { buf, contentType, expires }
const SEGMENT_CACHE_TTL_MS = 5 * 60_000; // 5 минут
const SEGMENT_CACHE_MAX = 200;

function segmentCacheGet(key) {
  const hit = segmentCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    segmentCache.delete(key);
    return null;
  }
  return hit;
}

// память "какой referer сработал для этого хоста в последний раз" —
// избавляет от полного перебора кандидатов на каждый сегмент, и сам
// подстраивается, если CDN сменит требования (просто перезапишется)
const workingRefererByHost = new Map(); // hostname → { referer, origin }
const WORKING_REFERER_TTL_MS = 30 * 60_000; // 30 минут доверия одному варианту
const WORKING_REFERER_MAX_HOSTS = 200; // страховка от неограниченного роста при множестве разных CDN-хостов

function rememberWorkingReferer(hostname, candidate) {
  if (workingRefererByHost.size >= WORKING_REFERER_MAX_HOSTS && !workingRefererByHost.has(hostname)) {
    const oldestKey = workingRefererByHost.keys().next().value;
    if (oldestKey) workingRefererByHost.delete(oldestKey);
  }
  workingRefererByHost.set(hostname, { ...candidate, expiresAt: Date.now() + WORKING_REFERER_TTL_MS });
}

function getRememberedReferer(hostname) {
  const hit = workingRefererByHost.get(hostname);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    workingRefererByHost.delete(hostname);
    return null;
  }
  return { referer: hit.referer, origin: hit.origin };
}

function forgetWorkingReferer(hostname) {
  workingRefererByHost.delete(hostname);
}

const deadUrlCache = new Map(); // url → expiresAt
const DEAD_URL_TTL_MS = 15_000;

function isMarkedDead(url) {
  const exp = deadUrlCache.get(url);
  if (!exp) return false;
  if (Date.now() > exp) {
    deadUrlCache.delete(url);
    return false;
  }
  return true;
}

function markDead(url) {
  deadUrlCache.set(url, Date.now() + DEAD_URL_TTL_MS);
}

// периодическая чистка — без неё deadUrlCache/workingRefererByHost росли бы
// вечно записями, к которым больше никогда не обратятся
setInterval(() => {
  const now = Date.now();
  for (const [url, exp] of deadUrlCache) {
    if (now > exp) deadUrlCache.delete(url);
  }
  for (const [hostname, entry] of workingRefererByHost) {
    if (now > entry.expiresAt) workingRefererByHost.delete(hostname);
  }
}, 5 * 60_000).unref();

function segmentCacheSet(key, buf, contentType) {
  if (segmentCache.size >= SEGMENT_CACHE_MAX) {
    const first = segmentCache.keys().next().value;
    if (first) segmentCache.delete(first);
  }
  segmentCache.set(key, {
    buf,
    contentType,
    expires: Date.now() + SEGMENT_CACHE_TTL_MS,
  });
}

// если один URL запросили 10 раз одновременно — качаем один раз
const inFlightRelay = new Map();

function fetchOnce(key, fn) {
  if (inFlightRelay.has(key)) return inFlightRelay.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inFlightRelay.delete(key));
  inFlightRelay.set(key, p);
  return p;
}

function buildRewrittenPlaylist(text, targetUrl, fromQuery) {
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
    const ref =
      fromQuery && fromQuery.startsWith('http')
        ? `&referer=${encodeURIComponent(fromQuery)}`
        : '';
    return `/api/stream/relay?url=${encodeURIComponent(absoluteUrl)}${ref}`;
  };

  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#EXT-X-MAP')) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${toRelay(uri)}"`);
      }
      if (line.startsWith('#EXT-X-KEY') && /URI="([^"]+)"/.test(line)) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${toRelay(uri)}"`);
      }
      if (line.startsWith('#') || !line.trim()) return line;
      return toRelay(line.trim());
    })
    .join('\n');
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
        referer: 'https://kinogomy.stloadi.live/',
        origin: 'https://kinogomy.stloadi.live',
      };
    }

    if (u.hostname.includes('stloadi.live')) {
      return { referer: 'https://kinogomy.stloadi.live/', origin: 'https://kinogomy.stloadi.live' };
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

    // Rezka / voidboost / collaps — CDN ждёт referer именно с самой Rezka,
    // а не с себя (origin CDN-хоста даёт 404)
    if (
      u.hostname.includes('voidboost') ||
      u.hostname.includes('collaps') ||
      u.hostname.includes('cdnmovies') ||
      u.hostname.includes('ashdi')
    ) {
      return {
        referer: 'https://rezka-ua.tv/',
        origin: 'https://rezka-ua.tv',
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
    let host = '';
    try {
      host = new URL(targetUrl).hostname || '';
    } catch (_) {}

    const isVk =
      /vkvideo\.cloud|vkuservideo|userapi\.com|vk-cdn|vkcs|vk\.com/i.test(targetUrl) ||
      /vkvideo\.cloud|vkuservideo|userapi\.com|vk-cdn|vkcs/i.test(host);

    const cacheKey = targetUrl;
    const cached = segmentCacheGet(cacheKey);
    if (cached) {
      console.log('[stream-relay] cache HIT', targetUrl.slice(0, 80));
      res.setHeader('Content-Type', cached.contentType || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(cached.buf);
    }

    const cachedPlaylist = playlistCacheGet(cacheKey);
    if (cachedPlaylist !== null) {
      // тот же манифест уже качали недавно — не идём в источник заново,
      // просто пересобираем ссылки под текущий запрос (referer из query может отличаться)
      console.log('[stream-relay] playlist cache HIT', targetUrl.slice(0, 80));
      const fromQueryNow = (req.query.referer || '').toString();
      const rewritten = buildRewrittenPlaylist(cachedPlaylist, targetUrl, fromQueryNow);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    if (isMarkedDead(targetUrl)) {
      // недавно уже перебрали все referer-кандидаты и всё равно 404 —
      // ссылка протухла (истёк временной токен), смысла повторять нет
      return res.status(410).json({ error: 'Ссылка на поток протухла, нужен свежий extract' });
    }

    // один раз качаем на URL, остальные ждут
    const downloadResult = await fetchOnce(cacheKey, async () => {
      const primary = guessReferer(targetUrl);
      const fromQuery = (req.query.referer || '').toString();

      let queryCandidate = null;
      if (fromQuery.startsWith('http')) {
        try {
          const u = new URL(fromQuery);
          queryCandidate = {
            referer: `${u.protocol}//${u.hostname}/`,
            origin: `${u.protocol}//${u.hostname}`,
          };
        } catch (_) {}
      }

      let hostCandidate = null;
      try {
        const u = new URL(targetUrl);
        hostCandidate = {
          referer: `${u.protocol}//${u.hostname}/`,
          origin: `${u.protocol}//${u.hostname}`,
        };
      } catch (_) {}

      function originOf(urlOrHost) {
        try {
          const u = urlOrHost.startsWith('http')
            ? new URL(urlOrHost)
            : new URL('https://' + urlOrHost);
          return {
            referer: `${u.protocol}//${u.hostname}/`,
            origin: `${u.protocol}//${u.hostname}`,
          };
        } catch {
          return null;
        }
      }

      const FAMILY_FALLBACKS = [
        'kinogomy.stravers.live',
        'kinogomy.stloadi.live',
        'balabolka.stravers.live',
        'marie.as.stravers.live',
        'marie-as.stloadi.live',
        'kinogomy.net',
        'cdn.lordfilm64.com',
        'api.ortified.ws',
        'vk.com',
        'rezka-ua.tv',
        'hdrezka.tv',
        'rezka.ag',
      ]
        .map(originOf)
        .filter(Boolean);

      const remembered = getRememberedReferer(host);

      const refererCandidates = [
        remembered,   // сначала то, что сработало для этого хоста в прошлый раз
        queryCandidate,
        primary,
        hostCandidate,
        ...FAMILY_FALLBACKS,
      ].filter(Boolean);

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
      let usedProxy = false;

      for (let i = 0; i < uniqueCandidates.length; i++) {
        const { referer, origin } = uniqueCandidates[i];
        const isLast = i === uniqueCandidates.length - 1;

        const headers = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: referer,
          Accept: '*/*',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          Connection: 'keep-alive',
        };
        if (!isLast) headers['Origin'] = origin;

        // 1) сначала БЕЗ прокси
        try {
          response = await fetch(targetUrl, { headers });
        } catch (e) {
          response = null;
          lastBody = e.message || 'fetch failed';

          // чистый сетевой обрыв (не HTTP-ошибка) — вероятно, случайная заминка,
          // а не проблема с referer; один быстрый повтор того же referer дешевле,
          // чем сразу переходить к следующему кандидату
          try {
            response = await fetch(targetUrl, { headers });
          } catch (e2) {
            response = null;
            lastBody = e2.message || 'fetch failed';
          }
        }

        // 2) если не ок и есть PROXY — пробуем С прокси
        if ((!response || !response.ok) && PROXY_SERVER) {
          const dispatcher = buildDispatcher();
          const fetchOpts = { headers };
          if (dispatcher) fetchOpts.dispatcher = dispatcher;
          try {
            console.log(
              '[stream-relay] retry WITH proxy, was:',
              response?.status || 'fail',
              'host:',
              host
            );
            response = await fetch(targetUrl, fetchOpts);
            usedProxy = true;
          } catch (e) {
            response = null;
            lastBody = e.message || 'fetch failed';
          }
        }

        if (response && response.ok) {
          console.log(
            '[stream-relay] OK',
            usedProxy ? 'proxy:ON' : 'proxy:OFF',
            'referer:',
            referer,
            'status:',
            response.status,
            'vk:',
            isVk,
            'url:',
            targetUrl.slice(0, 80)
          );
          if (host) rememberWorkingReferer(host, { referer, origin });
          break;
        }

        lastStatus = response ? response.status : 0;
        if (response) {
          lastBody = await response.text().catch(() => '');
        }
        console.warn(
          '[stream-relay] отказ',
          lastStatus || 'net',
          'referer:',
          referer,
          targetUrl.slice(0, 80),
          String(lastBody).slice(0, 80)
        );

        // "запомненный" referer только что подвёл (CDN мог сменить вердикт
        // для того же URL/хоста) — забываем его немедленно, а не ждём TTL,
        // иначе следующий запрос снова первым делом упрётся в тот же 404
        if (host && i === 0 && remembered && referer === remembered.referer) {
          forgetWorkingReferer(host);
        }

        response = null;
      }

      if (!response) {
        // помечаем мёртвой только при явном отказе CDN (404/403 — протухший токен),
        // а не при сетевой заминке (таймаут/DNS/разрыв — lastStatus тогда 0)
        if (lastStatus === 404 || lastStatus === 403) {
          markDead(targetUrl);
        }
        return {
          ok: false,
          status: lastStatus || 502,
          body: lastBody,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      const looksLikeUrlM3u8 = targetUrl.includes('.m3u8');
      const looksLikeType =
        contentType.includes('mpegurl') ||
        contentType.includes('application/vnd.apple');

      const buf = Buffer.from(await response.arrayBuffer());
      const head = buf.slice(0, 16).toString('utf8');
      const isM3u8Body = head.startsWith('#EXTM3U');

      return {
        ok: true,
        buf,
        contentType,
        looksLikeUrlM3u8,
        looksLikeType,
        isM3u8Body,
        fromQuery,
      };
    });

    if (!downloadResult.ok) {
      console.error(
        '[stream-relay] CDN отказал:',
        downloadResult.status,
        targetUrl.slice(0, 120),
        String(downloadResult.body || '').slice(0, 200)
      );
      return res
        .status(downloadResult.status || 502)
        .json({ error: `CDN вернул ${downloadResult.status}` });
    }

    const {
      buf,
      contentType,
      looksLikeUrlM3u8,
      looksLikeType,
      isM3u8Body,
      fromQuery,
    } = downloadResult;

    if (looksLikeUrlM3u8 || looksLikeType || isM3u8Body) {
      const text = buf.toString('utf8');
      playlistCacheSet(cacheKey, text); // на будущее — если hls.js вдруг переспросит тот же манифест
      const rewritten = buildRewrittenPlaylist(text, targetUrl, fromQuery);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    // бинарь (сегменты)
    const ct = contentType || 'application/octet-stream';
    if (
      !looksLikeUrlM3u8 &&
      !looksLikeType &&
      !isM3u8Body &&
      buf.length > 0 &&
      buf.length < 8_000_000
    ) {
      segmentCacheSet(cacheKey, buf, ct);
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { Readable } = require('stream');
    const nodeStream = Readable.from(buf);
    nodeStream.pipe(res);
    nodeStream.on('error', (streamErr) => {
      console.error('[stream-relay] ошибка потока:', streamErr.message);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('[stream-relay] EXCEPTION:', err && err.message);
    console.error(err && err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: (err && err.message) || 'relay error' });
    }
  }
});

module.exports = router;