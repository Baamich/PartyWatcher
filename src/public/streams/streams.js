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

function renderStreamerCard(streamer) {
  const card = document.createElement('div');
  card.className = 'streamer-card';
  card.innerHTML = `
    <div class="streamer-avatar-wrap">
      ${streamer.streamerAvatarUrl
        ? `<img class="streamer-avatar" src="${esc(streamer.streamerAvatarUrl)}" loading="lazy" />`
        : `<div class="streamer-avatar-fallback">${esc(streamerInitial(streamer.streamerName))}</div>`}
      ${streamer.isLive ? `<span class="live-badge">${t('streams.liveBadge')}</span>` : ''}
    </div>
    <div class="streamer-name" title="${esc(streamer.streamerName)}">${esc(streamer.streamerName)}</div>
    <div class="streamer-meta">${streamer.isLive ? t('streams.live') : t('streams.offline')}</div>
  `;
  card.onclick = () => (location.href = `/streamers/${encodeURIComponent(streamer.streamerName.toLowerCase())}`);
  return card;
}

function renderStreamersList(container, streamers, emptyText) {
  if (!container) return;
  container.innerHTML = '';
  if (!streamers.length) {
    // emptyText может содержать поисковый запрос из адреса страницы — вставляем только как текст
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-muted); font-size:14px;';
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }
  streamers.forEach((s) => container.appendChild(renderStreamerCard(s)));
}

async function loadStreamers() {
  try {
    const streamers = await api('/streamers');

    renderStreamersList(
      document.getElementById('streamersGrid'),
      streamers,
      t('streams.noStreamers')
    );

    // будет потом считываться по итогу окончания стрима (сортировка по накопленным часам эфира)
    const active = streamers.filter((s) => s.isLive);
    renderStreamersList(
      document.getElementById('activeStreamersRow'),
      active,
      t('streams.nobodyLive')
    );
  } catch (err) {
    console.warn('[loadStreamers]', err.message);
  }
}

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
      // "Все стримеры" сюда больше не трогаем — это только автодополнение
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
      ${s.streamerAvatarUrl
        ? `<img class="suggestion-avatar" src="${esc(s.streamerAvatarUrl)}" />`
        : `<div class="suggestion-avatar-fallback">${esc(streamerInitial(s.streamerName))}</div>`}
      <span class="suggestion-name">${esc(s.streamerName)}</span>
      ${s.isLive ? `<span class="suggestion-badge">${t('streams.liveBadge')}</span>` : ''}
    `;
    row.onclick = () => (location.href = `/streamers/${encodeURIComponent(s.streamerName.toLowerCase())}`);
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
    location.href = `/streamers/${encodeURIComponent(me.streamerName.toLowerCase())}`;
  } else {
    location.href = '/streamers/edit.html';
  }
}

initMeName();
loadStreamers();