// Главная с комнатами — для всех. Гость видит публичные комнаты (класс pw-guest на <html> показывает подсказки
// .guest-only), а «Мои комнаты», создание и вход по ключу — после входа на /login (оттуда обратно)
async function checkAuth() {
  let me;
  try {
    me = await api('/auth/me');
  } catch (err) {
    window.__pwAuthed = false;
    try { localStorage.removeItem('pw_authed'); } catch {}
    document.documentElement.classList.add('pw-guest');
    loadPublicRooms();
    startAutoRefresh(); // без сокета лобби (он только со входом) — список обновляет таймер
    return;
  }
  window.__pwAuthed = true;
  try {
    // «Просмотр фильма / сериала» — только админу и друзьям (сервер проверяет сам)
    const capOpt = document.querySelector('option[value="player_capture"]');
    if (capOpt) {
      const can = ['friend', 'admin', 'owner'].includes(me.role);
      capOpt.hidden = !can;
      capOpt.classList.toggle('hidden', !can);
    }
    try { localStorage.setItem('pw_authed', '1'); } catch {}

    const adminLink = document.getElementById('adminLink');
    if (adminLink) {
      adminLink.classList.toggle('hidden', me.role !== 'admin' && me.role !== 'owner');
    }

    // Kodik выбран по умолчанию: есть ли поиск по каталогу — спрашиваем сервер
    if (isKodikType()) updateKodikMode();
    initLobbySocket(); // сокет и оба списка — параллельно: каждый запрос к серверу — полсекунды дороги
    await Promise.all([loadMyRooms(), loadPublicRooms()]);
    startAutoRefresh();
  } catch (err) {
    console.error('[checkAuth] после входа', err);
  }
}

// ---- тип видео + приватность — один общий инфо-попап на двоих ----

// тексты подсказок по типу видео — в словаре: index.info.<тип> (с HTML-ссылками)

let privacyPublic = false; // по умолчанию приватная

function lockStatusText() {
  return privacyPublic ? t('index.privacy.public') : t('index.privacy.private');
}

function renderInfoPopup() {
  const type = document.getElementById('videoType').value;
  // у Kodik для админа и друзей есть ещё поиск по названию (kodikSearchEnabled — ответ /kodik/config)
  const extra = type === 'kodik' && kodikSearchEnabled ? t('index.info.kodikSearch') + '<br><br>' : '';
  document.getElementById('infoPopup').innerHTML = `${extra}${t('index.info.' + type)}<hr>${escapeHtml(lockStatusText())}`;
}

function toggleInfoPopup() {
  const popup = document.getElementById('infoPopup');
  const willShow = popup.classList.contains('hidden');
  if (willShow) renderInfoPopup();
  popup.classList.toggle('hidden');
}

function onVideoTypeChange() {
  const popup = document.getElementById('infoPopup');
  if (!popup.classList.contains('hidden')) renderInfoPopup();
  updateKodikMode();
}

function updatePrivacyButton() {
  const btn = document.getElementById('privacyToggle');
  btn.textContent = privacyPublic ? '🔓' : '🔒';
  btn.classList.toggle('lock-public', privacyPublic);
  btn.classList.toggle('lock-private', !privacyPublic);
}

function togglePrivacy() {
  privacyPublic = !privacyPublic;
  updatePrivacyButton();
  const popup = document.getElementById('infoPopup');
  if (!popup.classList.contains('hidden')) renderInfoPopup(); // если попап открыт — сразу обновляем текст про замок
}

// ---- создание / вход в комнату ----

function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ---- Kodik: поиск фильма/сериала (если на сервере есть ключ API) или ссылка на их плеер ----

let kodikSearchEnabled = null; // null — ещё не спрашивали сервер
let kodikResults = null; // виджет выдачи (js/kodik/search.js), общий с комнатой
let kodikPick = null; // { item, tr } — выбранный фильм и озвучка (ведётся виджетом)
let kodikTimer = null;
let kodikSeq = 0;
let kodikInit = null; // один запрос /kodik/config и одна загрузка виджета, даже если режим включили дважды подряд

function isKodikType() {
  return document.getElementById('videoType').value === 'kodik';
}

function isKodikLink(s) {
  return /(kodik|aniqit)[^\/\s]*\/(serial|video|season|seria)\/\d+\//i.test(s);
}

function setUrlPlaceholder(key) {
  const input = document.getElementById('videoUrl');
  input.setAttribute('data-i18n-placeholder', key);
  input.placeholder = t(key);
}

// Kodik с поиском: поле — поиск по названию (значок 🔍, без подсказок прошлых ссылок), а не «ссылка»
function setKodikSearchLook(on) {
  const input = document.getElementById('videoUrl');
  input.classList.toggle('kodik-search', on);
  if (on) input.removeAttribute('list');
  else input.setAttribute('list', 'recentVideoUrls');
}

// название комнаты по выбранному фильму — пока человек не написал своё
function autoRoomName(pick) {
  const el = document.getElementById('roomName');
  if (el.value.trim() && el.dataset.auto !== '1') return;
  el.value = pick ? String(pick.item.title || '').slice(0, 100) : '';
  el.dataset.auto = el.value ? '1' : '';
}
document.getElementById('roomName')?.addEventListener('input', (e) => { e.target.dataset.auto = ''; });

async function updateKodikMode() {
  const box = document.getElementById('kodikResults');
  if (!isKodikType()) {
    setUrlPlaceholder('index.create.url');
    setKodikSearchLook(false);
    box.classList.add('hidden');
    return;
  }
  if (!kodikInit) {
    kodikInit = (async () => {
      try {
        kodikSearchEnabled = !!(await api('/kodik/config')).search;
      } catch {
        kodikInit = null; // не вошёл или сеть — пока только ссылка, спросим в следующий раз
        return;
      }
      if (kodikSearchEnabled) {
        const mod = await import('/js/kodik/search.js?v=1');
        kodikResults = mod.createKodikResults(document.getElementById('kodikResults'), {
          onPickChange: (pick) => { kodikPick = pick; autoRoomName(pick); },
        });
      }
    })();
  }
  await kodikInit;
  if (!isKodikType()) return; // пока ждали ответ, тип уже сменили
  setUrlPlaceholder(kodikSearchEnabled ? 'index.kodik.placeholder' : 'index.kodik.placeholderLink');
  setKodikSearchLook(!!kodikSearchEnabled);
  refreshKodikBox();
}

function onVideoUrlInput() {
  if (!isKodikType()) return;
  clearTimeout(kodikTimer);
  const q = document.getElementById('videoUrl').value.trim();
  if (!kodikSearchEnabled || q.length < 2 || isKodikLink(q)) {
    kodikSeq++; // ответ уже отправленного поиска больше не нужен
    kodikResults?.setItems([]);
    refreshKodikBox();
    return;
  }
  kodikTimer = setTimeout(() => kodikSearch(q), 400);
}

function onVideoUrlKeydown(arg, el, e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = el.value.trim();
  if (isKodikType() && kodikSearchEnabled && q.length >= 2 && !isKodikLink(q) && !kodikPick) {
    clearTimeout(kodikTimer);
    kodikSearch(q);
  } else {
    createRoom();
  }
}

async function kodikSearch(q) {
  const seq = ++kodikSeq;
  const box = document.getElementById('kodikResults');
  box.classList.remove('hidden');
  kodikResults?.searching();
  try {
    const data = await api('/kodik/search?q=' + encodeURIComponent(q));
    if (seq !== kodikSeq) return;
    kodikResults?.setItems(data.items || []);
  } catch (err) {
    if (seq !== kodikSeq) return;
    kodikResults?.error(err.message);
  }
}

// показываем/прячем блок выдачи; саму отрисовку карточек делает виджет
function refreshKodikBox() {
  const box = document.getElementById('kodikResults');
  const q = document.getElementById('videoUrl').value.trim();
  if (!isKodikType() || !kodikSearchEnabled || q.length < 2 || isKodikLink(q)) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  kodikResults?.render();
}

// подписи карточек (год · сериал · озвучки) собраны из t() — при смене языка перерисовываем
window.addEventListener('pw:langchange', () => {
  if (isKodikType() && kodikResults?.hasItems()) kodikResults.render();
});
// браузер мог восстановить выбранный тип при возврате на страницу
document.addEventListener('DOMContentLoaded', () => {
  // гостю /kodik/config недоступен (401) — не спрашиваем; после входа checkAuth вызовет сам
  if (isKodikType() && window.__pwAuthed !== false) updateKodikMode();
});

// гость → страница входа, после неё — на returnTo
function goLogin(returnTo) {
  location.href = '/login?returnTo=' + encodeURIComponent(returnTo || '/');
}

let creatingRoom = false; // двойной клик не должен создать две комнаты (и обойти лимит)
async function createRoom() {
  if (window.__pwAuthed === false) return goLogin('/');
  if (creatingRoom) return;
  creatingRoom = true;
  let leaving = false;
  try {
    const selection = document.getElementById('videoType').value;
    // для фильма из поиска Kodik название комнаты можно не писать — возьмём название фильма
    const name = document.getElementById('roomName').value.trim()
      || (selection === 'kodik' && kodikPick ? String(kodikPick.item.title || '').slice(0, 100) : '');
    if (!name) return PW.toast(t('index.create.noName'), 'info');

    const rawUrl = document.getElementById('videoUrl').value.trim();
    if (!rawUrl) return PW.toast(t('index.create.noUrl'), 'info');

    let type, url;
    const extra = {};

    if (selection === 'youtube_twitch') {
      // один пункт на три сервиса: тип определяем по ссылке
      if (/youtube\.com|youtu\.be/.test(rawUrl)) type = 'youtube';
      else if (/twitch\.tv/.test(rawUrl)) type = 'twitch';
      else if (/(^|[/.])(vk\.com|vk\.ru|vkvideo\.ru)\//i.test(rawUrl) || /^(vk\.com|vk\.ru|vkvideo\.ru)/i.test(rawUrl)) type = 'vk';
      else return PW.toast(t('index.create.unknownYtTwitch'), 'error');
      url = rawUrl;
    } else if (selection === 'drive') {
      const fileId = extractDriveFileId(rawUrl);
      if (!fileId) return PW.toast(t('index.create.badDrive'), 'error');
      type = 'drive';
      url = fileId;
    } else if (selection === 'player_capture') {
      if (!rawUrl.startsWith('http')) return PW.toast(t('index.create.needHttp'), 'error');
      type = 'player_capture';
      url = rawUrl;
    } else if (selection === 'direct') {
      if (!rawUrl.startsWith('http')) return PW.toast(t('index.create.needHttp'), 'error');
      type = 'direct';
      url = rawUrl;
    } else if (selection === 'kodik') {
      type = 'kodik';
      if (kodikPick) {
        url = kodikPick.tr.link;
        extra.title = kodikPick.item.title;
        if (kodikPick.item.poster) extra.poster = kodikPick.item.poster;
      } else if (isKodikLink(rawUrl)) {
        url = rawUrl;
      } else if (kodikSearchEnabled) {
        if (!kodikResults?.hasItems()) kodikSearch(rawUrl);
        return PW.toast(t('index.kodik.pickFirst'), 'info');
      } else {
        return PW.toast(t('index.kodik.needLink'), 'info');
      }
    } else {
      return PW.toast(t('index.create.chooseType'), 'info');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let room;
    try {
      room = await api('/rooms', {
        method: 'POST',
        body: {
          name,
          video: { type, url, ...extra },
          isPublic: privacyPublic,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!room?.code) {
      throw new Error(room?.error || t('index.create.noCode'));
    }
    leaving = true; // уходим в комнату — повторный клик не нужен
    window.PWRecent?.add(rawUrl); // в подсказки поля — только ссылки (не названия для поиска)
    location.href = `/room.html?code=${room.code}`;
  } catch (err) {
    console.error('[createRoom]', err);
    if (err.name === 'AbortError') {
      PW.toast(t('index.create.timeout'), 'error');
    } else {
      PW.toast(err.message || t('index.create.failed'), 'error');
    }
  } finally {
    if (!leaving) creatingRoom = false;
  }
}

async function joinByCode() {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) return;
  if (window.__pwAuthed === false) return goLogin('/room.html?code=' + encodeURIComponent(code));
  try {
    await api('/rooms/' + encodeURIComponent(code));
    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  } catch {
    PW.toast(t('index.join.notFound'), 'error');
  }
}

// ---- отрисовка списков комнат ----

function roomThumbnail(room) {
  if (room.thumbnailUrl) return room.thumbnailUrl;
  if (room.video.type === 'youtube') {
    const idMatch = room.video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (idMatch) return `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
  }
  return null;
}

function occupancyLabel(room) {
  return room.viewerCount > 0 ? room.viewerCount : t('index.card.empty');
}

function deletionLabel(room) {
  if (room.viewerCount > 0) return t('index.card.keptWhileWatching');
  if (!room.emptySince) return '';
  const deadline = new Date(room.emptySince).getTime() + 20 * 60 * 60 * 1000;
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) return t('index.card.deleting');
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return t('index.card.deletesIn', { h, m });
}

async function deleteRoom(code, ev) {
  ev.stopPropagation();
  const ok = await PW.confirm(t('index.delete.text'), {
    title: t('index.delete.title'),
    okText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/rooms/' + code, { method: 'DELETE' });
    loadMyRooms();
  } catch (err) {
    PW.toast(err.message || t('index.delete.failed'), 'error');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Корзина в SVG: выглядит одинаково на любом устройстве
// (эмодзи 🗑️ у некоторых показывается белым и пропадает на светлой теме)
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function renderRoomCard(room, { showDelete }) {
  const thumb = roomThumbnail(room);
  const card = document.createElement('div');
  card.className = 'room-card';
  card.innerHTML = `
    ${showDelete ? `<button type="button" class="delete-btn" title="${t('index.delete.btn')}" aria-label="${t('index.delete.btn')}">${TRASH_SVG}</button>` : ''}
    ${thumb ? `<img class="room-thumb" src="${escapeHtml(thumb)}" loading="lazy" />` : `<div class="room-thumb-placeholder">🎬</div>`}
    <div class="room-info">
      <span class="room-name" title="${escapeHtml(room.name)}">${room.video?.adult ? '<span class="adult-badge">18+</span> ' : ''}${escapeHtml(room.name)}</span>
      <span class="room-occupancy">👤 ${occupancyLabel(room)}</span>
    </div>
    <div class="room-actions">
      <button class="enter-btn">${t('index.join.submit')}</button>
      <div class="countdown">${deletionLabel(room)}</div>
    </div>`;

  card.querySelector('.enter-btn').onclick = () => (location.href = `/room.html?code=${room.code}`);
  if (showDelete) {
    card.querySelector('.delete-btn').onclick = (ev) => deleteRoom(room.code, ev);
  }
  return card;
}

const lastRender = { mine: '', public: '' };

function renderRoomList(list, rooms, opts, cacheKey) {
  const sig = JSON.stringify(rooms);

  // данные не изменились: карточки не трогаем, обновляем только таймеры
  if (lastRender[cacheKey] === sig) {
    rooms.forEach((room, i) => {
      const el = list.children[i]?.querySelector('.countdown');
      if (el) el.textContent = deletionLabel(room);
    });
    return;
  }

  lastRender[cacheKey] = sig;
  list.innerHTML = '';
  rooms.forEach((room) => list.appendChild(renderRoomCard(room, opts)));
}

async function loadMyRooms() {
  if (!window.__pwAuthed) return;
  try {
    const rooms = await api('/rooms/mine');
    const list = document.getElementById('roomList');
    if (!list) return;

    if (!rooms.length) {
      lastRender.mine = '';
      list.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${t('index.mine.empty')}</p>`;
      return;
    }

    renderRoomList(list, rooms, { showDelete: true }, 'mine');
  } catch (err) {
    console.warn('[loadMyRooms]', err.message);
  }
}

// ===== Публичные комнаты: состояние =====
let publicState = {
  page: 1,
  sort: 'newest',
  onlyWithPeople: false,
  query: '',
  totalPages: 1,
};

function onPublicFilterChange() {
  publicState.page = 1;
  publicState.sort = document.getElementById('publicSort')?.value || 'newest';
  publicState.onlyWithPeople = document.getElementById('onlyWithPeople')?.checked || false;
  publicState.query = document.getElementById('publicSearchInput')?.value.trim() || '';
  loadPublicRooms();
}

function handlePublicSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    onPublicFilterChange();
  }
}

async function loadPublicRooms() {
  const list = document.getElementById('publicRoomList');
  const paginationEl = document.getElementById('publicPagination');
  if (!list) return;

  const params = new URLSearchParams({
    page: publicState.page,
    sort: publicState.sort,
    onlyWithPeople: publicState.onlyWithPeople ? '1' : '0',
  });
  if (publicState.query) params.set('q', publicState.query);

  try {
    const data = await api('/rooms/public?' + params.toString());
    const rooms = data.rooms || [];
    publicState.totalPages = data.totalPages || 1;

    if (!rooms.length) {
      lastRender.public = '';
      list.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${publicState.query ? t('index.public.notFound') : t('index.public.empty')}</p>`;
      if (paginationEl) paginationEl.classList.add('hidden');
      return;
    }

    renderRoomList(list, rooms, { showDelete: false }, 'public');
    renderPagination();
  } catch (err) {
    console.warn('[loadPublicRooms]', err.message);
  }
}

function renderPagination() {
  const el = document.getElementById('publicPagination');
  if (!el) return;

  const { page, totalPages } = publicState;

  if (totalPages <= 1) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = '';

  // стрелка влево
  const prev = document.createElement('button');
  prev.textContent = '‹';
  prev.disabled = page <= 1;
  prev.onclick = () => goToPage(page - 1);
  el.appendChild(prev);

  // страницы
  const pages = buildPageNumbers(page, totalPages);
  pages.forEach((p) => {
    if (p === '...') {
      const span = document.createElement('span');
      span.className = 'page-ellipsis';
      span.textContent = '…';
      el.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.textContent = p;
      if (p === page) btn.classList.add('active');
      btn.onclick = () => goToPage(p);
      el.appendChild(btn);
    }
  });

  // стрелка вправо
  const next = document.createElement('button');
  next.textContent = '›';
  next.disabled = page >= totalPages;
  next.onclick = () => goToPage(page + 1);
  el.appendChild(next);
}

function buildPageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages = [];
  pages.push(1);

  if (current > 3) pages.push('...');

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) pages.push('...');

  pages.push(total);
  return pages;
}

function goToPage(page) {
  if (page < 1 || page > publicState.totalPages) return;
  publicState.page = page;
  loadPublicRooms();
  // плавно вверх к списку
  document.getElementById('publicRoomList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let lobbySocket = null;
let refreshTimer = null;

function initLobbySocket() {
  if (lobbySocket) return;

  // socket.io должен быть уже подключён на странице (как в room.html)
  lobbySocket = io({ transports: ['websocket', 'polling'], tryAllTransports: true }); // сразу WebSocket: polling через туннель — лишние круги по полсекунды

  lobbySocket.on('connect', () => {
    lobbySocket.emit('lobby:join');
  });

 lobbySocket.on('rooms:public-updated', () => {
  if (publicState.page === 1 && publicState.sort === 'newest' && !publicState.onlyWithPeople && !publicState.query) {
    loadPublicRooms();
  }
});

  // мгновенное обновление "Мои комнаты"
  lobbySocket.on('rooms:mine-updated', () => {
    loadMyRooms();
  });
}

function startAutoRefresh() {
  if (refreshTimer) return;

  // лёгкий фоновый поллинг только для счётчиков зрителей и таймеров удаления
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    loadMyRooms();
    loadPublicRooms();
  };

  refreshTimer = setInterval(tick, 40000); // раз в 40 секунд достаточно
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (lobbySocket) {
    lobbySocket.emit('lobby:leave');
    lobbySocket.disconnect();
    lobbySocket = null;
  }
}

checkAuth();
