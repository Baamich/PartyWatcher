async function initMeName() {
  try {
    const me = await api('/auth/me');
    const el = document.getElementById('meName');
    if (el) el.textContent = me.username || '';
    return me;
  } catch {
    return null; // не авторизован
  }
}

function streamerInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const profileHref = (name) => `/streamers/${encodeURIComponent(String(name).toLowerCase())}`;

// название категории на языке зрителя: у неигровых есть русское, игры — как в оригинале
function catName(c) {
  return (window.I18N?.lang === 'ru' && c?.ru) || c?.name || '';
}

function avatarHtml(s, cls, fallbackCls) {
  return s.avatarUrl
    ? `<img class="${cls}" src="${esc(s.avatarUrl)}" loading="lazy" decoding="async" alt="" />`
    : `<div class="${fallbackCls}">${esc(streamerInitial(s.streamerName))}</div>`;
}

// подпись под именем: в эфире — название эфира или категория, иначе «офлайн»
function cardMeta(s, withCategory) {
  if (!s.isLive) return t('streams.offline');
  if (withCategory && s.category) return catName(s.category);
  return s.title || (s.category ? catName(s.category) : t('streams.live'));
}

function renderStreamerCard(streamer, opts = {}) {
  const card = document.createElement('a');
  card.className = 'streamer-card';
  card.href = profileHref(streamer.streamerName);
  const meta = cardMeta(streamer, opts.withCategory);
  card.innerHTML = `
    <div class="streamer-avatar-wrap${streamer.isLive ? ' is-live' : ''}">
      ${avatarHtml(streamer, 'streamer-avatar', 'streamer-avatar-fallback')}
      ${streamer.isLive ? `<span class="live-badge">${t('streams.liveBadge')}</span>` : ''}
    </div>
    ${streamer.isLive && streamer.viewers ? `<span class="card-viewers" title="${esc(t('streams.viewers'))}">👁 ${streamer.viewers}</span>` : ''}
    <div class="streamer-name" title="${esc(streamer.streamerName)}">${esc(streamer.streamerName)}</div>
    <div class="streamer-meta" title="${esc(meta)}">${esc(meta)}</div>
  `;
  return card;
}

function renderStreamersList(container, streamers, emptyText, opts) {
  if (!container) return;
  container.innerHTML = '';
  if (!streamers.length) {
    // emptyText может содержать поисковый запрос из адреса страницы — вставляем только как текст
    const p = document.createElement('p');
    p.className = 'streams-empty';
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }
  streamers.forEach((s) => container.appendChild(renderStreamerCard(s, opts)));
}

// строка бокового списка (подписки слева, все стримеры справа)
function renderSideRow(s) {
  const a = document.createElement('a');
  a.className = 'side-row' + (s.isLive ? ' is-live' : '');
  a.href = profileHref(s.streamerName);
  a.title = s.streamerName;
  const line2 = s.isLive
    ? `<span class="side-live">${t('streams.liveBadge')}</span>${s.category ? ' ' + esc(catName(s.category)) : ''}`
    : esc(t('streams.offline'));
  a.innerHTML = `
    <span class="side-avatar">${avatarHtml(s, 'side-avatar-img', 'side-avatar-fallback')}</span>
    <span class="side-text">
      <span class="side-name">${esc(s.streamerName)}</span>
      <span class="side-meta">${line2}</span>
    </span>
    ${s.isLive ? `<span class="side-viewers" title="${esc(t('streams.viewers'))}">● ${s.viewers || 0}</span>` : ''}
  `;
  return a;
}

function renderSideList(box, list, emptyHtml) {
  if (!box) return;
  box.innerHTML = '';
  if (!list || !list.length) {
    box.innerHTML = emptyHtml;
    return;
  }
  list.forEach((s) => box.appendChild(renderSideRow(s)));
}

// ---------- ряды с прокруткой вбок: стрелки появляются, только если есть куда листать ----------
function attachScroller(wrap) {
  if (!wrap || wrap.dataset.scroller) return;
  wrap.dataset.scroller = '1';
  const row = wrap.firstElementChild;
  const mk = (dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-arrow row-arrow-' + (dir < 0 ? 'l' : 'r');
    b.textContent = dir < 0 ? '‹' : '›';
    b.setAttribute('aria-label', t(dir < 0 ? 'streams.scrollLeft' : 'streams.scrollRight'));
    b.addEventListener('click', () => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: 'smooth' }));
    wrap.appendChild(b);
    return b;
  };
  const l = mk(-1), r = mk(1);
  const sync = () => {
    l.classList.toggle('hidden', row.scrollLeft <= 2);
    r.classList.toggle('hidden', row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
  };
  row.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(row);
  sync();
  wrap._sync = sync;
}

// ---------- страница трансляций ----------
let dirData = null; // ответ /streams/directory
let allSide = null; // правый столбик берём с главной; в полном списке он не меняется

function currentView() {
  const p = new URLSearchParams(location.search);
  if (p.get('cat')) return { cat: p.get('cat') };
  const v = p.get('view');
  return v === 'all' || v === 'active' ? { view: v } : {};
}

function viewQuery(v) {
  if (v.cat) return '?cat=' + encodeURIComponent(v.cat);
  if (v.view) return '?view=' + v.view;
  return '';
}

function goView(v) {
  const q = viewQuery(v);
  if (q !== location.search) history.pushState(null, '', '/streams.html' + q);
  loadDirectory();
  window.scrollTo({ top: 0 });
}

function renderFollowing(list) {
  const box = document.getElementById('followList');
  if (list === null) {
    box.innerHTML = `<p class="side-hint">${esc(t('streams.followGuest'))} <a href="/?returnTo=%2Fstreams.html">${esc(t('streams.signIn'))}</a></p>`;
    return;
  }
  renderSideList(box, list, `<p class="side-hint">${esc(t('streams.followEmpty'))}</p>`);
}

function categoryCover(c, cls) {
  const el = document.createElement('a');
  el.className = cls;
  el.href = '/streams.html?cat=' + encodeURIComponent(c.slug);
  el.title = catName(c);
  if (c.cover) el.innerHTML = `<img src="${esc(c.cover)}" loading="lazy" decoding="async" alt="" />`;
  else el.innerHTML = `<span>${esc(catName(c))}</span>`;
  el.addEventListener('click', (e) => { e.preventDefault(); goView({ cat: c.slug }); });
  return el;
}

function liveCountText(c) {
  return c.live ? t('streams.liveCount', { n: c.live }) : t('streams.streamersCount', { n: c.total });
}

function renderHome(d) {
  const active = document.getElementById('activeStreamersRow');
  renderStreamersList(active, d.active, t('streams.noActive'), { withCategory: true });

  const rows = document.getElementById('categoryRows');
  rows.innerHTML = '';
  for (const c of d.categories) {
    const sec = document.createElement('section');
    sec.className = 'streams-section cat-section';
    const head = document.createElement('div');
    head.className = 'streams-section-head';
    head.innerHTML = `
      <h2 class="section-title"><button type="button" class="section-link"><span>${esc(catName(c))}</span><span class="chev">›</span></button></h2>
      <span class="cat-count${c.live ? ' is-live' : ''}">${esc(liveCountText(c))}</span>`;
    head.querySelector('.section-link').addEventListener('click', () => goView({ cat: c.slug }));

    const wrap = document.createElement('div');
    wrap.className = 'row-scroller';
    const row = document.createElement('div');
    row.className = 'active-streamers-row';
    row.appendChild(categoryCover(c, 'cat-cover-tile'));
    c.streamers.forEach((s) => row.appendChild(renderStreamerCard(s)));
    wrap.appendChild(row);
    sec.append(head, wrap);
    rows.appendChild(sec);
    attachScroller(wrap);
  }
  attachScroller(active.parentElement);
  active.parentElement._sync?.();
}

function renderList(d, v) {
  const title = document.getElementById('listTitle');
  const count = document.getElementById('listCount');
  const cover = document.getElementById('listCover');
  cover.classList.toggle('hidden', !v.cat);
  cover.innerHTML = '';
  if (v.cat) {
    if (!d.category) {
      title.textContent = t('streams.catNotFound');
      count.textContent = '';
      document.getElementById('listGrid').innerHTML = '';
      return;
    }
    cover.appendChild(categoryCover(d.category, 'cat-cover-big'));
    title.textContent = catName(d.category);
    count.textContent = liveCountText(d.category);
  } else if (v.view === 'active') {
    title.textContent = t('streams.active');
    count.textContent = t('streams.activeHint');
  } else {
    title.textContent = t('streams.all');
    count.textContent = t('streams.streamersCount', { n: d.total || d.list.length });
  }
  renderStreamersList(document.getElementById('listGrid'), d.list, t('streams.noStreamers'), { withCategory: !v.cat });
}

function renderDirectory() {
  const d = dirData;
  if (!d) return;
  const v = currentView();
  renderFollowing(d.following);
  const home = !v.cat && !v.view;
  document.getElementById('homeView').classList.toggle('hidden', !home);
  document.getElementById('listView').classList.toggle('hidden', home);
  if (home) {
    renderHome(d);
    renderSideList(document.getElementById('allList'), d.all, `<p class="side-hint">${esc(t('streams.noStreamers'))}</p>`);
    allSide = d.all;
  } else {
    renderList(d, v);
    if (allSide) renderSideList(document.getElementById('allList'), allSide, '');
  }
}

async function loadDirectory() {
  const q = viewQuery(currentView());
  try {
    let d;
    try {
      d = await api('/streams/directory' + q);
    } catch (err) {
      if (err.status !== 404) throw err;
      d = { following: null, category: null, list: [] }; // категории больше нет
    }
    if (q !== viewQuery(currentView())) return; // пока грузилось, ушли на другой вид
    dirData = d;
    if (!allSide && q) {
      // открыли сразу полный список — правый столбик догружаем отдельно
      api('/streams/directory').then((h) => { allSide = h.all; renderSideList(document.getElementById('allList'), allSide, ''); }).catch(() => {});
    }
    renderDirectory();
  } catch (err) {
    console.warn('[loadDirectory]', err.message);
  }
}

// свернуть подписки до аватаров (запоминается в браузере)
function setFollowCollapsed(on) {
  document.getElementById('followSide')?.classList.toggle('collapsed', on);
  const b = document.getElementById('followSideToggle');
  if (b) {
    b.textContent = on ? '»' : '«';
    b.setAttribute('data-i18n-title', on ? 'streams.expand' : 'streams.collapse');
    b.title = t(on ? 'streams.expand' : 'streams.collapse');
  }
  try { localStorage.setItem('pw-follow-collapsed', on ? '1' : '0'); } catch {}
}

function initStreamsPage() {
  if (!document.getElementById('streamsMain')) return; // страница поиска берёт отсюда только общие функции
  let collapsed = false;
  try { collapsed = localStorage.getItem('pw-follow-collapsed') === '1'; } catch {}
  setFollowCollapsed(collapsed);
  document.getElementById('followSideToggle')?.addEventListener('click', () => {
    setFollowCollapsed(!document.getElementById('followSide').classList.contains('collapsed'));
  });
  document.querySelectorAll('.section-link[data-view]').forEach((b) => {
    b.addEventListener('click', () => goView({ view: b.dataset.view }));
  });
  document.getElementById('listBackBtn')?.addEventListener('click', () => goView({}));
  window.addEventListener('popstate', loadDirectory);
  window.addEventListener('pw:langchange', renderDirectory); // названия категорий и подписи — заново
  // эфиры начинаются и заканчиваются: обновляем, пока вкладка видна
  setInterval(() => { if (!document.hidden) loadDirectory(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dirData) loadDirectory(); });
  loadDirectory();
}

// ---------- поиск по имени ----------
let searchDebounceTimer = null;

function onStreamerSearch() {
  const q = (document.getElementById('streamerSearchInput')?.value || '').trim();
  if (!q) return;
  hideSuggestions();
  location.href = `/streams/search.html?q=${encodeURIComponent(q)}`;
}

function handleStreamerSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    onStreamerSearch();
  }
}

function handleStreamerSearchInput() {
  const q = document.getElementById('streamerSearchInput')?.value || '';
  clearTimeout(searchDebounceTimer);

  if (q.trim().length < 3) {
    hideSuggestions();
    return;
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await api('/streamers?q=' + encodeURIComponent(q.trim()) + '&limit=5');
      renderSuggestions(results, q.trim());
    } catch (err) {
      console.warn('[handleStreamerSearchInput]', err.message);
    }
  }, 300);
}

function renderSuggestions(streamers, query) {
  const box = document.getElementById('searchSuggestions');
  if (!box) return;

  if (!streamers.length) {
    box.innerHTML = `<div class="suggestion-item" style="cursor:default;color:var(--text-muted);">${t('streams.nothingFound')}</div>`;
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML = '';
  streamers.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'suggestion-item';
    row.innerHTML = `
      ${s.avatarUrl
        ? `<img class="suggestion-avatar" src="${esc(s.avatarUrl)}" decoding="async" alt="" />`
        : `<div class="suggestion-avatar-fallback">${esc(streamerInitial(s.streamerName))}</div>`}
      <span class="suggestion-name">${esc(s.streamerName)}</span>
      ${s.isLive ? `<span class="suggestion-badge">${t('streams.liveBadge')}</span>` : ''}
    `;
    row.onclick = () => (location.href = profileHref(s.streamerName));
    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

function hideSuggestions() {
  document.getElementById('searchSuggestions')?.classList.add('hidden');
}

// небольшая задержка, чтобы клик по подсказке успел сработать раньше blur
function hideSuggestionsSoon() {
  setTimeout(hideSuggestions, 150);
}

async function goToMyProfile() {
  const me = await initMeName();
  if (!me) {
    PW.toast(t('streams.signInFirst'), 'info');
    return;
  }
  if (me.streamerName) {
    location.href = profileHref(me.streamerName);
  } else {
    location.href = '/streamers/edit.html';
  }
}

initMeName();
initStreamsPage();
