// страницы документации лежат в src/locales/<язык>/docs/*.html (по языку посетителя)
// страницы документации лежат отдельно на каждом языке; язык может смениться без перезагрузки
const docsBase = () => `/locales/${I18N.lang}/docs/`;
const DOCS_HOME = 'intro';

// ---- оглавление: сюда добавляются новые главы и страницы ----
// названия глав и страниц — в словаре: docs.ch.<глава>, docs.page.<страница>.title / .desc
const DOCS_CHAPTERS = [
  ['stream', ['stream-obs']],
  ['chat', ['chat-obs', 'chat-code', 'chat-style', 'chat-reference', 'chat-security']],
  ['constructor', ['constructor-chat', 'constructor-commands']],
  ['editor', ['editor-standard', 'editor-pro']],
  ['presets', ['presets-styles', 'presets-commands']],
].map(([id, pages]) => ({
  id,
  title: t('docs.ch.' + id),
  pages: pages.map((pid) => ({ id: pid, title: t(`docs.page.${pid}.title`), desc: t(`docs.page.${pid}.desc`) })),
}));

let myStreamerNameLower = null;
let loadToken = 0;
const openChapters = new Set();

const contentEl = document.getElementById('docsContent');
contentEl?.setAttribute('data-no-i18n', ''); // текст страницы — целиком из файла нужного языка
const tocEl = document.getElementById('docsToc');
const pagerEl = document.getElementById('docsPager');

// плоский список страниц; номера (1.1, 2.3 ...) считаются по порядку
const FLAT_PAGES = [];
DOCS_CHAPTERS.forEach((ch, ci) => {
  ch.num = ci + 1;
  ch.pages.forEach((pg, pi) => {
    pg.num = `${ci + 1}.${pi + 1}`;
    pg.chapterId = ch.id;
    FLAT_PAGES.push(pg);
  });
});

const CHEVRON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function findPage(id) {
  return FLAT_PAGES.find((p) => p.id === id) || null;
}

function getHashId() {
  return decodeURIComponent(location.hash.replace(/^#/, '')) || DOCS_HOME;
}

function goTo(id) {
  if (getHashId() === id) loadPage(id);
  else location.hash = '#' + id;
}

// ---------- список глав (справа) ----------

function renderToc() {
  let html = `<div class="docs-toc-title">${t('docs.title')}</div>`;
  html += `<a class="docs-toc-home" data-page="${DOCS_HOME}" href="#${DOCS_HOME}">🏠 ${t('docs.about')}</a>`;

  DOCS_CHAPTERS.forEach((ch) => {
    html += `
      <div class="docs-ch" data-chapter="${ch.id}">
        <button type="button" class="docs-ch-head" data-chapter="${ch.id}" aria-expanded="false">
          ${CHEVRON}<span>${t('docs.chapter', { n: ch.num })} ${ch.title}</span>
        </button>
        <div class="docs-ch-pages">
          <div class="docs-ch-pages-inner">
            ${ch.pages
              .map(
                (pg) => `
              <a class="docs-pg" data-page="${pg.id}" href="#${pg.id}">
                <b>${pg.num}</b>${pg.title}<small>${pg.desc}</small>
              </a>`
              )
              .join('')}
          </div>
        </div>
      </div>`;
  });

  tocEl.innerHTML = html;
}

function updateTocState(currentId) {
  tocEl.querySelectorAll('.docs-ch').forEach((el) => {
    const open = openChapters.has(el.dataset.chapter);
    el.classList.toggle('open', open);
    el.querySelector('.docs-ch-head').setAttribute('aria-expanded', String(open));
  });
  tocEl.querySelectorAll('.docs-pg').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === currentId);
  });
  tocEl.querySelector('.docs-toc-home')?.classList.toggle('active', currentId === DOCS_HOME);
}

tocEl.addEventListener('click', (e) => {
  const head = e.target.closest('.docs-ch-head');
  if (!head) return;

  const chapterId = head.dataset.chapter;
  const chapter = DOCS_CHAPTERS.find((c) => c.id === chapterId);
  const cur = findPage(getHashId());

  if (cur && cur.chapterId === chapterId) {
    // мы уже в этой главе — просто сворачиваем/разворачиваем
    if (openChapters.has(chapterId)) openChapters.delete(chapterId);
    else openChapters.add(chapterId);
    updateTocState(getHashId());
  } else {
    // другая глава — открываем и сразу показываем её первую страницу
    openChapters.add(chapterId);
    goTo(chapter.pages[0].id);
  }
});

// ---------- листание «назад / дальше» ----------

function renderPager(id) {
  const idx = FLAT_PAGES.findIndex((p) => p.id === id);
  let prev = null;
  let next = null;

  if (id === DOCS_HOME) {
    next = FLAT_PAGES[0] || null;
  } else if (idx >= 0) {
    prev = FLAT_PAGES[idx - 1] || null;
    next = FLAT_PAGES[idx + 1] || null;
  }

  const link = (pg, dir) =>
    pg
      ? `<a class="docs-pager-link ${dir}" href="#${pg.id}">
           <small>${dir === 'prev' ? t('docs.prev') : t('docs.next')}</small>
           <span>${pg.num} ${pg.title}</span>
         </a>`
      : '<span></span>';

  pagerEl.innerHTML = link(prev, 'prev') + link(next, 'next');
}

// ---------- кнопка «Копировать» у блоков кода ----------

function enhanceCode(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const text = (pre.querySelector('code') || pre).textContent;

    // оборачиваем блок кода, чтобы кнопка стояла на месте, даже когда код прокручивают вбок
    const wrap = document.createElement('div');
    wrap.className = 'docs-code';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'docs-copy';
    btn.textContent = t('docs.copy');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = t('docs.copied');
      } catch (_) {
        btn.textContent = t('docs.copyFailed');
      }
      setTimeout(() => { btn.textContent = t('docs.copy'); }, 1500);
    });
    wrap.appendChild(btn);
  });
}

// ---------- загрузка страницы в то же окно ----------

async function loadPage(id) {
  const page = id === DOCS_HOME ? { num: '', title: t('docs.about') } : findPage(id);
  if (!page) {
    location.replace('#' + DOCS_HOME);
    return;
  }

  const token = ++loadToken;
  contentEl.setAttribute('aria-busy', 'true');

  // открываем главу этой страницы (а свернуть текущую главу вручную теперь можно)
  if (page.chapterId) openChapters.add(page.chapterId);

  updateTocState(id);
  renderPager(id);

  try {
    const res = await fetch(`${docsBase()}${id}.html`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    if (token !== loadToken) return; // успели кликнуть дальше — этот ответ уже не нужен
    contentEl.innerHTML = html;

    // номер (2.1, 2.3 ...) подставляется сам: в файлах страниц пишем просто <h1>Название</h1>
    const h1 = contentEl.querySelector('h1');
    if (h1 && page.num) h1.textContent = `${page.num} ${h1.textContent}`;

    enhanceCode(contentEl);
    document.title = `PartyWatcher — ${page.num ? page.num + ' ' : ''}${page.title}`;
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (token !== loadToken) return;
    contentEl.innerHTML =
      `<h1>${t('docs.loadFailed')}</h1>` +
      `<p class="docs-lead">${t('docs.checkFile')} <code>${docsBase()}${id}.html</code></p>`;
  } finally {
    if (token === loadToken) contentEl.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', () => loadPage(getHashId()));
window.addEventListener('pw:langchange', () => loadPage(getHashId())); // та же страница на новом языке

// ---------- кнопка «← Профиль» ----------

function goToMyStreamerProfile() {
  if (myStreamerNameLower) location.href = `/streamers/${encodeURIComponent(myStreamerNameLower)}`;
}

async function initAuth() {
  try {
    const me = await api('/auth/me');
    if (!me.streamerName) {
      location.href = '/streamers/edit.html';
      return;
    }
    myStreamerNameLower = me.streamerName.toLowerCase();
  } catch {
    location.href = '/';
  }
}

// ---------- увеличение картинок по клику ----------

const lightbox = document.createElement('div');
lightbox.className = 'docs-lightbox hidden';
lightbox.innerHTML = '<img alt="">';
document.body.appendChild(lightbox);
const lightboxImg = lightbox.querySelector('img');

function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxImg.removeAttribute('src');
}

contentEl.addEventListener('click', (e) => {
  const img = e.target.closest('.docs-figure img');
  if (!img) return;
  lightboxImg.src = img.currentSrc || img.src;
  lightboxImg.alt = img.alt;
  lightbox.classList.remove('hidden');
});
lightbox.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

renderToc();
loadPage(getHashId());
initAuth();