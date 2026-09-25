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
      ${streamer.avatarUrl
        ? `<img class="streamer-avatar" src="${streamer.avatarUrl}" loading="lazy" />`
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

async function loadStreamers(query = '') {
  try {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());

    const streamers = await api('/streamers' + (params.toString() ? '?' + params.toString() : ''));

    renderStreamersList(
      document.getElementById('streamersGrid'),
      streamers,
      query ? 'Никого не нашли' : 'Стримеров пока нет'
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

function onStreamerSearch() {
  loadStreamers(document.getElementById('streamerSearchInput')?.value || '');
}

function handleStreamerSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    onStreamerSearch();
  }
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