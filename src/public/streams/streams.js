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

function renderStreamerCard(streamer) {
  const card = document.createElement('div');
  card.className = 'streamer-card';
  card.innerHTML = `
    <div class="streamer-avatar-wrap">
      ${streamer.streamerAvatarUrl
        ? `<img class="streamer-avatar" src="${streamer.streamerAvatarUrl}" loading="lazy" />`
        : `<div class="streamer-avatar-fallback">${streamerInitial(streamer.streamerName)}</div>`}
      ${streamer.isLive ? '<span class="live-badge">В ЭФИРЕ</span>' : ''}
    </div>
    <div class="streamer-name" title="${streamer.streamerName}">${streamer.streamerName}</div>
    <div class="streamer-meta">${streamer.isLive ? 'в эфире' : 'офлайн'}</div>
  `;
  card.onclick = () => (location.href = `/streamers/${encodeURIComponent(streamer.streamerName.toLowerCase())}`);
  return card;
}

function renderStreamersList(container, streamers, emptyText) {
  if (!container) return;
  container.innerHTML = '';
  if (!streamers.length) {
    container.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${emptyText}</p>`;
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
      'Стримеров пока нет'
    );

    // будет потом считываться по итогу окончания стрима (сортировка по накопленным часам эфира)
    const active = streamers.filter((s) => s.isLive);
    renderStreamersList(
      document.getElementById('activeStreamersRow'),
      active,
      'Сейчас никто не стримит'
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
    box.innerHTML = `<div class="suggestion-item" style="cursor:default;color:var(--text-muted);">Ничего не найдено</div>`;
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML = '';
  streamers.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'suggestion-item';
    row.innerHTML = `
      ${s.streamerAvatarUrl
        ? `<img class="suggestion-avatar" src="${s.streamerAvatarUrl}" />`
        : `<div class="suggestion-avatar-fallback">${streamerInitial(s.streamerName)}</div>`}
      <span class="suggestion-name">${s.streamerName}</span>
      ${s.isLive ? '<span class="suggestion-badge">В ЭФИРЕ</span>' : ''}
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
    alert('Сначала войди в аккаунт');
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