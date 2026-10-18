// Поисковики: canonical, hreflang (?lang=ru / ?lang=en, x-default — адрес без языка), noindex, Open Graph,
// разметка schema.org (JSON-LD) и sitemap.xml. Правила (что в поиске, а что нет) — .claude/docs/seo.md.
// Робот получает ту же страницу, что и человек: всё, что здесь вставляется, описывает видимое содержимое.
const config = require('../config');
const i18n = require('./i18n');
const User = require('../models/User');
const Category = require('../models/Category');
const StreamSession = require('../models/StreamSession');
const searchIndex = require('./searchIndex');
const categories = require('./categories');
const { isAdultStream } = require('./adultContent');

const SITE = String(config.publicUrl || '').replace(/\/+$/, '');
const BRAND = 'Party Watcher';
const ALT_NAMES = ['PartyWatcher', 'Пати Вотчер', 'Пати Вочер', 'partywatcher.de'];
const OG_IMAGE = '/img/og-image.png';
const LOGO = '/img/logo-512.png';
const OG_LOCALE = { ru: 'ru_RU', en: 'en_GB' };
const HOUR = 3600 * 1000;

// страницы с постоянным адресом, которые идут в поиск (остальные HTML — noindex). titleKey/descKey — из seo.json,
// у остальных свои <title>/description в разметке. /impressum и /datenschutz — noindex: там имя и адрес владельца
// (страницы обязаны быть доступны, но не обязаны быть в поиске)
const PAGES = {
  'index.html': { path: '/', home: true },
  'streams.html': { path: '/streams.html', titleKey: 'seo.streams.title', descKey: 'seo.streams.description' },
  'workbench/news.html': { path: '/news', titleKey: 'seo.news.title', descKey: 'seo.news.description' },
  'terms.html': { path: '/terms' },
};

const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const abs = (u) => (/^https?:/i.test(u) ? u : SITE + u);
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
};

function url(path, query, lang) {
  const q = new URLSearchParams(query || {});
  if (lang) q.set('lang', lang);
  const s = q.toString();
  return SITE + path + (s ? '?' + s : '');
}

// язык из адреса (?lang=ru|en) — только точное совпадение
const urlLang = (req) => {
  const v = req.query && req.query.lang;
  return typeof v === 'string' && i18n.LANGS.includes(v) ? v : null;
};

function dropTag(html, re) {
  return html.replace(re, '');
}
const metaRe = (key) => new RegExp(`\\s*<meta\\s+(?:name|property)="${key}"[^>]*>`, 'gi');

// html — готовая страница; page — { path, query?, title?, description?, image?, noindex?, jsonld?, home?, titleKey?, descKey? }
function decorate(html, req, res, lang, rel, override) {
  const page = override || PAGES[rel];
  if (!page) {
    if (!res.getHeader('X-Robots-Tag')) res.setHeader('X-Robots-Tag', 'noindex');
    return html;
  }
  const title = page.title || (page.titleKey && i18n.t(lang, page.titleKey));
  const desc = page.description || (page.descKey && i18n.t(lang, page.descKey));
  const out = [];

  if (title) {
    // без data-i18n: иначе i18n.js в браузере вернёт общий заголовок раздела
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escText(title)}</title>`);
    html = dropTag(html, metaRe('og:title'));
    out.push(`<meta property="og:title" content="${escAttr(title)}" />`);
  }
  if (desc) {
    html = dropTag(html, metaRe('description'));
    html = dropTag(html, metaRe('og:description'));
    out.push(`<meta name="description" content="${escAttr(desc)}" />`, `<meta property="og:description" content="${escAttr(desc)}" />`);
  }

  if (page.noindex) {
    res.setHeader('X-Robots-Tag', 'noindex');
    out.push('<meta name="robots" content="noindex" />');
  } else {
    const explicit = urlLang(req);
    const canonical = url(page.path, page.query, explicit);
    html = dropTag(html, /\s*<link\s+rel="canonical"[^>]*>/gi);
    html = dropTag(html, metaRe('og:url'));
    html = dropTag(html, metaRe('og:site_name'));
    html = dropTag(html, metaRe('og:type'));
    out.push(`<link rel="canonical" href="${escAttr(canonical)}" />`);
    for (const l of i18n.LANGS) out.push(`<link rel="alternate" hreflang="${l}" href="${escAttr(url(page.path, page.query, l))}" />`);
    out.push(`<link rel="alternate" hreflang="x-default" href="${escAttr(url(page.path, page.query, null))}" />`);
    out.push(
      `<meta property="og:type" content="${page.ogType || 'website'}" />`,
      `<meta property="og:site_name" content="${BRAND}" />`,
      `<meta property="og:url" content="${escAttr(canonical)}" />`,
      `<meta property="og:locale" content="${OG_LOCALE[lang] || 'en_GB'}" />`,
      `<meta property="og:image" content="${escAttr(abs(page.image || OG_IMAGE))}" />`,
      `<meta name="twitter:card" content="${page.image ? 'summary' : 'summary_large_image'}" />`,
    );
    const ld = [...(page.home ? siteLd(lang) : []), ...(page.jsonld || [])];
    if (ld.length) {
      const json = JSON.stringify(ld.length === 1 ? ld[0] : { '@context': 'https://schema.org', '@graph': ld.map(stripContext) });
      out.push(`<script type="application/ld+json">${json.replace(/</g, '\\u003c')}</script>`);
    }
  }
  return html.replace(/<\/head>/i, `  ${out.join('\n  ')}\n</head>`);
}

function stripContext(x) {
  const { '@context': _c, ...rest } = x;
  return rest;
}

// главная: имя сайта для выдачи («Party Watcher» вместо домена) и логотип
function siteLd(lang) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      name: BRAND,
      alternateName: ALT_NAMES,
      url: SITE + '/',
      description: i18n.t(lang, 'seo.site.description'),
      inLanguage: i18n.LANGS,
      publisher: { '@id': SITE + '/#org' },
    },
    { '@context': 'https://schema.org', '@type': 'Organization', '@id': SITE + '/#org', name: BRAND, url: SITE + '/', logo: abs(LOGO) },
  ];
}

// ---------- страница стримера ----------
const STREAMER_FIELDS = 'streamerName streamerNameLower streamerBio followersCount profileRev isLive liveStartedAt ' +
  'streamPlaybackId streamCategoryId ' + searchIndex.FIELDS;
const streamerCache = new Map(); // nameLower → { at, u }
const STREAMER_TTL = 60 * 1000;

async function loadStreamer(nameLower) {
  const hit = streamerCache.get(nameLower);
  if (hit && Date.now() - hit.at < STREAMER_TTL) return hit.u;
  const [u] = await User.aggregate([
    { $match: { streamerNameLower: nameLower } },
    { $limit: 1 },
    {
      $project: {
        ...Object.fromEntries(STREAMER_FIELDS.split(/\s+/).filter(Boolean).map((f) => [f, 1])),
        hasAvatar: { $gt: [{ $strLenBytes: { $ifNull: ['$streamerAvatarUrl', ''] } }, 0] },
      },
    },
  ]);
  if (streamerCache.size > 2000) streamerCache.clear();
  streamerCache.set(nameLower, { at: Date.now(), u: u || null });
  return u || null;
}

// thumbOf(playbackId) — адрес кадра эфира (directory.routes) или null
async function streamerPage(req, lang, nameLower, thumbOf) {
  const u = await loadStreamer(nameLower);
  if (!u) return { notFound: true, page: { path: `/streamers/${encodeURIComponent(nameLower)}`, noindex: true } };
  const name = u.streamerName;
  const path = `/streamers/${encodeURIComponent(u.streamerNameLower)}`;
  const page = { path, ogType: 'profile', title: i18n.t(lang, 'seo.streamer.title', { name }) };
  page.noindex = !searchIndex.isIndexable(u);
  const avatar = u.hasAvatar ? `/api/streamers/${encodeURIComponent(u.streamerNameLower)}/avatar?v=${Number(u.profileRev) || 0}` : null;
  if (avatar) page.image = avatar;

  const live = u.isLive && !isAdultStream(u);
  const cat = live ? await categories.viewByTid(u.streamCategoryId).catch(() => null) : null;
  const catName = cat ? (lang === 'ru' && cat.ru) || cat.name : '';
  const liveTitle = clip(u.streamTitle, 90) || i18n.t(lang, 'seo.streamer.liveName', { name });
  if (live) {
    page.description = i18n.t(lang, catName ? 'seo.streamer.descLiveCat' : 'seo.streamer.descLive', { name, title: liveTitle, cat: catName });
  } else {
    page.description = u.streamerBio ? clip(`${name}: ${u.streamerBio}`, 160) : i18n.t(lang, 'seo.streamer.desc', { name });
  }
  if (page.noindex) return { page };

  const person = {
    '@type': 'Person',
    name,
    url: SITE + path,
    ...(u.streamerBio && { description: clip(u.streamerBio, 300) }),
    ...(avatar && { image: abs(avatar) }),
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: u.followersCount || 0 },
  };
  page.jsonld = [{ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: person }];
  // идёт эфир: VideoObject + BroadcastEvent — Google может показать значок LIVE
  if (live && u.liveStartedAt) {
    const start = new Date(u.liveStartedAt).toISOString();
    const frame = thumbOf && u.streamPlaybackId ? thumbOf(u.streamPlaybackId) : null;
    const thumb = frame ? frame.replace(/\?.*$/, '') : avatar || OG_IMAGE;
    page.jsonld.push({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: liveTitle,
      description: page.description,
      thumbnailUrl: [abs(thumb)],
      uploadDate: start,
      embedUrl: SITE + path,
      ...(catName && { genre: catName }),
      author: { '@type': 'Person', name, url: SITE + path },
      publication: { '@type': 'BroadcastEvent', isLiveBroadcast: true, startDate: start },
    });
  }
  return { page };
}

// ---------- категории: в поиске те, где за 30 дней был эфир не 18+ ----------
let active = null; // { at, tids: Set }
let activeP = null;
async function activeCategories() {
  if (active && Date.now() - active.at < 10 * 60 * 1000) return active.tids;
  if (!activeP) {
    activeP = (async () => {
      const since = new Date(Date.now() - 30 * 24 * HOUR);
      const [past, now] = await Promise.all([
        StreamSession.find({ endedAt: { $gte: since }, categoryId: { $ne: null } }).select('categoryId title adult -_id').lean(),
        User.find({ isLive: true, streamCategoryId: { $ne: null } }).select('streamCategoryId streamTitle streamAdult -_id').lean(),
      ]);
      const tids = new Set();
      for (const s of past) if (!s.adult && !isAdultStream({ streamTitle: s.title })) tids.add(s.categoryId);
      for (const u of now) if (!isAdultStream(u)) tids.add(u.streamCategoryId);
      active = { at: Date.now(), tids };
      return tids;
    })().finally(() => { activeP = null; });
  }
  return activeP;
}

const catCache = new Map(); // slug → { at, c }
async function categoryPage(lang, slug) {
  let hit = catCache.get(slug);
  if (!hit || Date.now() - hit.at > HOUR) {
    const c = await Category.findOne({ slug }).select('tid name slug hasCover -_id').lean();
    if (catCache.size > 2000) catCache.clear();
    hit = { at: Date.now(), c };
    catCache.set(slug, hit);
  }
  const c = hit.c;
  if (!c) return { notFound: true, page: { path: '/streams.html', query: { cat: slug }, noindex: true } };
  const name = (lang === 'ru' && categories.ruName(c.name)) || c.name;
  const indexable = (await activeCategories()).has(c.tid);
  return {
    page: {
      path: '/streams.html',
      query: { cat: c.slug },
      title: i18n.t(lang, 'seo.category.title', { name }),
      description: i18n.t(lang, 'seo.category.description', { name }),
      ...(c.hasCover && { image: `/api/categories/${encodeURIComponent(c.slug)}/cover` }),
      noindex: !indexable,
    },
  };
}

// ---------- sitemap.xml ----------
let sitemap = null;
let sitemapAt = 0;
let sitemapP = null;

function urlBlock(path, query) {
  const alts = [...i18n.LANGS.map((l) => [l, url(path, query, l)]), ['x-default', url(path, query, null)]];
  const links = alts.map(([l, h]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${escAttr(h)}"/>`).join('');
  return alts.map(([, h]) => `<url><loc>${escText(h)}</loc>${links}</url>`).join('\n');
}

async function buildSitemap() {
  const entries = Object.values(PAGES).map((p) => [p.path, null]);
  const streamers = await User.find({ streamerNameLower: { $ne: null }, searchIndex: { $ne: false }, 'seo.m': { $exists: true } })
    .select(searchIndex.FIELDS + ' -_id').lean();
  for (const u of streamers) if (searchIndex.isIndexable(u)) entries.push([`/streamers/${encodeURIComponent(u.streamerNameLower)}`, null]);
  const tids = [...(await activeCategories())];
  if (tids.length) {
    const cats = await Category.find({ tid: { $in: tids } }).select('slug -_id').lean();
    for (const c of cats) entries.push(['/streams.html', { cat: c.slug }]);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    entries.map(([p, q]) => urlBlock(p, q)).join('\n') + '\n</urlset>\n';
}

async function sitemapXml() {
  if (sitemap && Date.now() - sitemapAt < HOUR) return sitemap;
  if (!sitemapP) {
    sitemapP = buildSitemap()
      .then((x) => { sitemap = x; sitemapAt = Date.now(); return x; })
      .finally(() => { sitemapP = null; });
  }
  return sitemapP;
}

module.exports = { decorate, streamerPage, categoryPage, sitemapXml, urlLang, PAGES };
