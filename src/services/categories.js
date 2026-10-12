// categories.js — категории эфиров. Поиск идёт через Twitch API: там игры из IGDB (в т.ч. свежие и малоизвестные)
// и неигровые категории Twitch («Just Chatting», «Music»…). Выбранная стримером категория копируется в нашу базу
// вместе с обложкой — зрители Twitch не трогают, а к Twitch ходит только поиск в студии
const config = require('../config');
const Category = require('../models/Category');
const i18n = require('./i18n');

const HELIX = 'https://api.twitch.tv/helix';
const BOX_HOST = 'static-cdn.jtvnw.net';

// русские названия неигровых категорий (игры остаются с оригинальными названиями)
const RU = {
  'Just Chatting': 'Общение',
  Music: 'Музыка',
  Art: 'Искусство',
  IRL: 'IRL',
  Sports: 'Спорт',
  'Travel & Outdoors': 'Путешествия и природа',
  'Talk Shows & Podcasts': 'Ток-шоу и подкасты',
  'Science & Technology': 'Наука и технологии',
  'Software and Game Development': 'Разработка игр и программ',
  'Food & Drink': 'Еда и напитки',
  'Makers & Crafting': 'Мастерская и рукоделие',
  'Fitness & Health': 'Фитнес и здоровье',
  'Beauty & Body Art': 'Красота и боди-арт',
  'Animals, Aquariums, and Zoos': 'Животные',
  'Special Events': 'Особые события',
  'Politics': 'Политика',
  'Games + Demos': 'Игры и демо',
  'Retro': 'Ретро',
  'ASMR': 'ASMR',
  'Writing & Reading': 'Книги и писательство',
  'Pools, Hot Tubs, and Beaches': 'Бассейны и пляжи',
};
const ruName = (name) => RU[name] || '';

const enabled = () => !!(config.twitch.clientId && config.twitch.clientSecret);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- токен приложения Twitch (живёт ~60 дней, держим в памяти) ----------
let token = null;
let tokenExp = 0;
let tokenP = null;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  if (!tokenP) {
    tokenP = (async () => {
      const body = new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        grant_type: 'client_credentials',
      });
      const r = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('twitch token ' + r.status);
      const j = await r.json();
      token = j.access_token;
      tokenExp = Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000;
      return token;
    })().finally(() => { tokenP = null; });
  }
  return tokenP;
}

async function helix(path, retry = true) {
  const t = await getToken();
  const r = await fetch(HELIX + path, {
    headers: { 'Client-Id': config.twitch.clientId, Authorization: 'Bearer ' + t },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401 && retry) { token = null; return helix(path, false); } // токен отозвали — берём новый один раз
  if (!r.ok) throw new Error('twitch ' + r.status);
  return r.json();
}

// адрес обложки нужного размера; только с CDN Twitch
function boxUrl(u, w, h) {
  const s = String(u || '').replace(/-(\{width\}x\{height\}|\d+x\d+)(\.\w+)$/, `-${w}x${h}$2`);
  try {
    return new URL(s).hostname === BOX_HOST ? s : null;
  } catch {
    return null;
  }
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// ---------- поиск (для студии) ----------
const searchCache = new Map(); // запрос → { at, list }
const SEARCH_TTL = 10 * 60 * 1000;

function rank(list, q) {
  const ql = q.toLowerCase();
  const score = (c) => {
    const names = [c.name.toLowerCase(), (c.ru || '').toLowerCase()];
    if (names.includes(ql)) return 0;
    if (names.some((n) => n && n.startsWith(ql))) return 1;
    return 2;
  };
  return list.map((c, i) => ({ c, s: score(c), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.c);
}

async function search(raw) {
  const q = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;

  // русское слово («общение») — ищем и по английскому названию неигровой категории
  const ql = key;
  const viaRu = Object.keys(RU).filter((en) => RU[en].toLowerCase().includes(ql) && en.toLowerCase() !== ql).slice(0, 2);

  const out = new Map();
  const local = await Category.find({ $or: [{ nameLower: { $regex: '^' + escapeRegex(ql) } }, { nameLower: { $in: viaRu.map((s) => s.toLowerCase()) } }] })
    .select('tid name slug hasCover').limit(5).lean();
  for (const c of local) out.set(c.tid, { id: c.tid, name: c.name, ru: ruName(c.name), box: c.hasCover ? `/api/categories/${c.slug}/cover` : null });

  if (enabled()) {
    const queries = [q, ...viaRu];
    const res = await Promise.all(queries.map((s, i) =>
      helix(`/search/categories?first=${i ? 3 : 12}&query=${encodeURIComponent(s)}`).catch((e) => {
        console.warn('[categories] поиск Twitch:', e.message);
        return null;
      })));
    if (res.every((r) => !r) && !out.size) throw i18n.err('server.cat.searchFailed');
    for (const r of res) {
      for (const d of r?.data || []) {
        if (!out.has(String(d.id))) out.set(String(d.id), { id: String(d.id), name: d.name, ru: ruName(d.name), box: boxUrl(d.box_art_url, 72, 96) });
      }
    }
  }

  const list = rank([...out.values()], q).slice(0, 12);
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), list });
  return list;
}

// ---------- выбранная категория: копия в нашей базе ----------
async function downloadCover(u) {
  if (!u) return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length && buf.length <= 400 * 1024 ? { buf, type } : null;
  } catch (e) {
    console.warn('[categories] обложка:', e.message);
    return null;
  }
}

// категория по id Twitch: из базы или (впервые) из Twitch с обложкой. Возвращает документ без обложки
async function ensure(tid) {
  tid = String(tid || '');
  if (!/^\d{1,15}$/.test(tid)) throw i18n.err('server.cat.notFound');
  const have = await Category.findOne({ tid }).select('-cover').lean();
  if (have) return have;
  if (!enabled()) throw i18n.err('server.cat.notConfigured');

  let d;
  try {
    d = (await helix('/games?id=' + tid)).data?.[0];
  } catch (e) {
    console.warn('[categories] Twitch games:', e.message);
    throw i18n.err('server.cat.searchFailed');
  }
  if (!d) throw i18n.err('server.cat.notFound');

  const cover = await downloadCover(boxUrl(d.box_art_url, 285, 380));
  let slug = slugify(d.name) || 'c-' + tid;
  if (await Category.exists({ slug })) slug = `${slug}-${tid}`;
  try {
    await Category.create({
      tid, name: d.name, nameLower: d.name.toLowerCase(), slug,
      cover: cover?.buf || null, coverType: cover?.type || null, hasCover: !!cover,
    });
  } catch (e) {
    if (e.code !== 11000) throw e; // два стримера выбрали одновременно — запись уже есть
  }
  return Category.findOne({ tid }).select('-cover').lean();
}

// для ответов клиенту: оригинал, русское название (если есть) и адрес обложки
function publicView(c) {
  if (!c) return null;
  return { id: c.tid, slug: c.slug, name: c.name, ru: ruName(c.name), cover: c.hasCover ? `/api/categories/${c.slug}/cover` : null };
}

// категория для страницы стримера (опрос раз в 5 с от каждого зрителя) — из памяти, в базу раз в 10 минут
const viewCache = new Map(); // tid → { at, view }
const VIEW_TTL = 10 * 60 * 1000;
async function viewByTid(tid) {
  if (!tid) return null;
  const hit = viewCache.get(tid);
  if (hit && Date.now() - hit.at < VIEW_TTL) return hit.view;
  const c = await Category.findOne({ tid }).select('-cover').lean();
  const v = publicView(c);
  const view = v ? { slug: v.slug, name: v.name, ru: v.ru } : null;
  if (viewCache.size > 1000) viewCache.clear();
  viewCache.set(tid, { at: Date.now(), view });
  return view;
}

module.exports = { enabled, search, ensure, publicView, ruName, viewByTid };
