// services/kodik.js
// Kodik: поиск фильмов/сериалов через их API (нужен KODIK_TOKEN) и разбор ссылок на их плеер.
// Видео играет iframe Kodik у каждого зрителя: сервер не качает потоки и не запускает Chromium,
// он только ищет и подменяет ссылку при смене озвучки (один GET страницы плеера).
const config = require('../config');
const i18n = require('./i18n');

const PLAYER_HOST = config.kodik.playerHost;
// //kodik.info/serial/6647/<hash>/720p, https://kodikplayer.com/video/…, а также код <iframe src="…">.
// Из ссылки берём только тип, id и hash — хост всегда наш (PLAYER_HOST), чужой адрес не подсунуть.
const LINK_RE = /(?:[a-z0-9-]+\.)*(?:kodik\.(?:info|cc|biz)|kodikplayer\.com|aniqit\.com)\/(serial|video|season|seria)\/(\d{1,12})\/([a-f0-9]{16,64})/i;

function normalizeLink(raw) {
  const m = String(raw || '').slice(0, 2000).match(LINK_RE);
  return m ? `https://${PLAYER_HOST}/${m[1].toLowerCase()}/${m[2]}/${m[3].toLowerCase()}/720p` : null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 300;
const POSTERS_MAX = 3000;
const TR_CACHE_MAX = 500;

const searchCache = new Map(); // запрос → { at, items }
// обложкой комнаты можно поставить только постер, который сервер сам отдал в поиске (не любой адрес от клиента)
const knownPosters = new Map(); // url → время
// ссылки материалов 18+ из нашей же выдачи (рейтинг RX / от 18 лет): комната с такой ссылкой — «18+»
const adultLinks = new Map(); // ссылка → время
const ADULT_MAX = 5000;
const trCache = new Map(); // `${ссылка}|${id озвучки}` → { link, at } (link: null — не нашли, повтор через минуту)
const TR_MISS_TTL_MS = 60 * 1000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value); // самый старый
}

function safePoster(u) {
  if (typeof u !== 'string' || u.length > 500) return null;
  const url = u.startsWith('//') ? 'https:' + u : u;
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Kodik отдаёт каждую озвучку отдельной записью — склеиваем в один фильм/сериал со списком озвучек
function groupResults(results) {
  const groups = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    const link = normalizeLink(r?.link);
    if (!link) continue;
    const key = r.shikimori_id ? 's' + r.shikimori_id
      : r.kinopoisk_id ? 'k' + r.kinopoisk_id
      : r.imdb_id ? 'i' + r.imdb_id
      : 't' + (r.title_orig || r.title) + '|' + r.year;

    let g = groups.get(key);
    if (!g) {
      g = {
        title: String(r.title || r.title_orig || '').slice(0, 200),
        titleOrig: String(r.title_orig || '').slice(0, 200),
        year: posInt(r.year),
        serial: String(r.id || '').startsWith('serial-'),
        poster: null,
        adult: false,
        translations: [],
      };
      groups.set(key, g);
    }
    const mdA = r.material_data || {};
    if (String(mdA.rating_mpaa || '').toLowerCase() === 'rx' || Number(mdA.minimal_age) >= 18) g.adult = true;
    if (!g.poster) {
      const md = r.material_data || {};
      g.poster = safePoster(md.poster_url) || safePoster(md.anime_poster_url);
    }
    if (g.translations.length < 60) {
      g.translations.push({
        id: posInt(r.translation?.id),
        title: String(r.translation?.title || '').slice(0, 100),
        subs: r.translation?.type === 'subtitles',
        episodes: posInt(r.episodes_count) || posInt(r.last_episode),
        link,
      });
    }
  }

  const items = [...groups.values()].slice(0, 30);
  for (const g of items) {
    // сначала озвучки, потом субтитры; внутри — где больше серий
    g.translations.sort((a, b) => (a.subs - b.subs) || ((b.episodes || 0) - (a.episodes || 0)));
    if (g.poster) remember(knownPosters, g.poster, Date.now(), POSTERS_MAX);
    if (g.adult) for (const tr of g.translations) remember(adultLinks, tr.link, Date.now(), ADULT_MAX);
  }
  return items;
}

function hasToken() {
  return !!config.kodik.token;
}

async function search(query) {
  if (!hasToken()) throw i18n.err('server.kodik.noToken');
  const q = String(query || '').trim().slice(0, 100);
  if (q.length < 2) throw i18n.err('server.kodik.badQuery');

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.items;

  const params = new URLSearchParams({
    token: config.kodik.token,
    title: q,
    limit: '100',
    with_material_data: 'true',
  });
  let data;
  try {
    // параметры (и токен) — в теле POST, а не в адресе: адреса запросов попадают в логи прокси и CDN
    const res = await fetch(`${config.kodik.apiUrl}/search`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(8000),
    });
    data = await res.json().catch(() => null);
    // неверный/просроченный токен и прочие отказы Kodik присылает как { error: "..." } (бывает и с 200)
    if (!res.ok || !data || data.error) {
      console.warn('[kodik] search: API отказал', res.status, String(data?.error || '').slice(0, 120));
      throw new Error('status');
    }
  } catch (e) {
    if (e.message !== 'status') console.warn('[kodik] search: нет ответа API:', e.cause?.code || e.name);
    throw i18n.err('server.kodik.apiFailed');
  }

  const items = groupResults(data?.results);
  remember(searchCache, key, { at: Date.now(), items }, SEARCH_CACHE_MAX);
  return items;
}

function isAdultLink(url) {
  const link = normalizeLink(url);
  return !!link && adultLinks.has(link);
}

function isKnownPoster(url) {
  return typeof url === 'string' && knownPosters.has(url);
}

// Хост сменил озвучку в плеере: iframe ушёл на другую ссылку, а снаружи её не прочитать.
// Список озвучек со ссылками есть в самой странице плеера (<option data-id data-media-id data-media-hash>).
async function linkForTranslation(link, translationId) {
  const base = normalizeLink(link);
  const id = posInt(translationId);
  if (!base || !id) return null;

  const key = `${base}|${id}`;
  const hit = trCache.get(key);
  if (hit && (hit.link || Date.now() - hit.at < TR_MISS_TTL_MS)) return hit.link;

  let html;
  try {
    const res = await fetch(base, {
      headers: { 'User-Agent': UA, Referer: config.publicUrl + '/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || Number(res.headers.get('content-length')) > MAX_PAGE_BYTES) {
      console.warn('[kodik] страница плеера ответила', res.status);
      remember(trCache, key, { link: null, at: Date.now() }, TR_CACHE_MAX);
      return null;
    }
    html = (await res.text()).slice(0, MAX_PAGE_BYTES);
  } catch (e) {
    console.warn('[kodik] не открыть страницу плеера:', e.cause?.code || e.name);
    return null;
  }

  let found = null;
  for (const m of html.matchAll(/<option\b([^>]*)>/gi)) {
    const attrs = m[1];
    const attr = (name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i')) || [])[1];
    if (attr('data-id') !== String(id)) continue;
    found = normalizeLink(`//${PLAYER_HOST}/${attr('data-media-type')}/${attr('data-media-id')}/${attr('data-media-hash')}`);
    if (found) break;
  }
  remember(trCache, key, { link: found, at: Date.now() }, TR_CACHE_MAX);
  if (!found) console.warn('[kodik] озвучка', id, 'не найдена на странице плеера');
  return found;
}

module.exports = { normalizeLink, hasToken, search, isKnownPoster, isAdultLink, linkForTranslation, posInt };
