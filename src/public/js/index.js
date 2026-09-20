async function checkAuth() {
  const authBox = document.getElementById('authBox');
  const appBox = document.getElementById('appBox');

  try {
    const me = await api('/auth/me');

    if (authBox) authBox.classList.add('hidden');
    if (appBox) appBox.classList.remove('hidden');

    const meName = document.getElementById('meName');
    if (meName) meName.textContent = me.username || '';

    const adminLink = document.getElementById('adminLink');
    if (adminLink) {
      adminLink.classList.toggle('hidden', me.role !== 'admin');
    }

    await loadMyRooms();
    await loadPublicRooms();
    initLobbySocket();
    startAutoRefresh();
  } catch (err) {
    console.warn('[checkAuth] не авторизован:', err?.message || err);
    if (authBox) authBox.classList.remove('hidden');
    if (appBox) appBox.classList.add('hidden');
    stopAutoRefresh();
    showLoginPanel();
  }
}

function showLoginPanel() {
  document.getElementById('loginPanel').classList.remove('hidden');
  document.getElementById('registerPanel').classList.add('hidden');
  hideAuthError('loginError');
}

function showRegisterPanel() {
  document.getElementById('registerPanel').classList.remove('hidden');
  document.getElementById('loginPanel').classList.add('hidden');
  hideAuthError('registerError');
  validateRegisterForm();
}

function showAuthError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAuthError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
}

function isValidEmail(email) {
  // практичная проверка: есть @, домен с точкой, без пробелов
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function getEmailError(email) {
  const v = String(email).trim();
  if (!v) return 'Введите почту';
  if (v.includes(' ')) return 'Почта не должна содержать пробелы';
  if (!v.includes('@')) return 'В почте должен быть символ @';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Некорректный формат почты';
  return null;
}

function updateEmailStatus() {
  const input = document.getElementById('regEmail');
  const status = document.getElementById('emailStatus');
  const hint = document.getElementById('emailHint');
  if (!input || !status || !hint) return;

  const err = getEmailError(input.value);
  if (!input.value.trim()) {
    status.textContent = '';
    status.className = 'field-status';
    status.title = '';
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }

  if (err) {
    status.textContent = '!';
    status.className = 'field-status bad';
    status.title = 'Нажми, чтобы увидеть ошибку';
    status.onclick = () => {
      hint.textContent = err;
      hint.classList.remove('hidden');
    };
  } else {
    status.textContent = '✓';
    status.className = 'field-status ok';
    status.title = 'Почта корректна';
    status.onclick = null;
    hint.classList.add('hidden');
    hint.textContent = '';
  }
}

function getPasswordChecks(password) {
  const p = String(password || '');
  return {
    length: p.length >= 8,
    upper: /^[A-Z]/.test(p),
    letter: /[A-Za-z]/.test(p),
    digit: /\d/.test(p),
  };
}

function updatePasswordRules() {
  const password = document.getElementById('regPassword')?.value || '';
  const confirm = document.getElementById('regPasswordConfirm')?.value || '';
  const checks = getPasswordChecks(password);
  const match = password.length > 0 && password === confirm;

  const map = [
    ['ruleLength', checks.length],
    ['ruleUpper', checks.upper],
    ['ruleLetter', checks.letter],
    ['ruleDigit', checks.digit],
    ['ruleMatch', match],
  ];

  map.forEach(([id, ok]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('rule-ok', ok);
    el.classList.toggle('rule-bad', !ok);
  });

  return checks.length && checks.upper && checks.letter && checks.digit && match;
}

function validateRegisterForm() {
  const username = document.getElementById('regUsername')?.value.trim() || '';
  const emailOk = !getEmailError(document.getElementById('regEmail')?.value || '');
  const passwordOk = updatePasswordRules();
  const btn = document.getElementById('registerBtn');
  if (btn) btn.disabled = !(username && emailOk && passwordOk);
}

async function login() {
  hideAuthError('loginError');
  const loginVal = document.getElementById('loginInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!loginVal || !password) {
    showAuthError('loginError', 'Введите логин и пароль');
    return;
  }
  try {
    await api('/auth/login', {
      method: 'POST',
      body: {
        login: loginVal,
        password,
      },
    });
    await checkAuth();
  } catch (err) {
    showAuthError('loginError', err.message || 'Не удалось войти');
  }
}

async function register() {
  hideAuthError('registerError');
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;

  if (!username) {
    showAuthError('registerError', 'Введите логин');
    return;
  }
  const emailErr = getEmailError(email);
  if (emailErr) {
    showAuthError('registerError', emailErr);
    updateEmailStatus();
    return;
  }
  if (!updatePasswordRules()) {
    if (password !== confirm) {
      showAuthError('registerError', 'Пароли не совпадают');
    } else {
      showAuthError('registerError', 'Пароль не соответствует требованиям');
    }
    return;
  }

  try {
    await api('/auth/register', {
      method: 'POST',
      body: { username, email, password },
    });
    await checkAuth();
  } catch (err) {
    showAuthError('registerError', err.message || 'Не удалось зарегистрироваться');
  }
}

document.getElementById('regEmail')?.addEventListener('blur', updateEmailStatus);
document.getElementById('regEmail')?.addEventListener('input', () => {
  document.getElementById('emailHint')?.classList.add('hidden');
  validateRegisterForm();
});
document.getElementById('regPassword')?.addEventListener('input', validateRegisterForm);
document.getElementById('regPasswordConfirm')?.addEventListener('input', validateRegisterForm);
document.getElementById('regUsername')?.addEventListener('input', validateRegisterForm);

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  stopAutoRefresh();
  checkAuth();
}

// ---- тип видео + приватность — один общий инфо-попап на двоих ----

const infoTexts = {
  youtube_twitch: 'Вставь ссылку на видео с YouTube (youtube.com/watch?v=... или youtu.be/...) или на запись (VOD) с Twitch (twitch.tv/videos/1234567890 — именно запись, не текущий эфир). <br>Тип определится автоматически по ссылке.',
  drive: '(не тестировалось)<br>На Google Диске: правой кнопкой по видео → "Открыть доступ" → "Все, у кого есть ссылка" → скопируй ссылку и вставь сюда. Без этого сервер не сможет прочитать файл.',
  player_capture: 'Вставь ссылку на страницу с фильмом/сериалом. Оптимизировано для:<br>• Kinogo(<a href="https://kinogo2026.com" target="_blank" rel="noopener">https://kinogo2026.com</a>), (<a href="https://kinogomy.net" target="_blank" rel="noopener">https://kinogomy.net</a>),<br>• Rezka (<a href="https://rezka-ua.tv" target="_blank" rel="noopener">https://rezka-ua.tv</a>) и их возможные другие домены (могут быть нюансы, но должно работать фильм/сериал). <br>Другие сайты тоже могут сработать, но не гарантировано. <br>⚠️ my.mail.ru не поддерживается (его нельзя перехватить<br> rezka.ag требуется личный прокси). <br>Для некоторых сайтов будет доступен выбор сезона/серии/озвучки.',
  direct: 'Вставь ГОТОВУЮ прямую ссылку на видео — сюда НЕ подходит адрес обычной страницы сайта (например, страницы просмотра на my.mail.ru), только:<br>• ссылка на сам видеофайл: .mp4, .m3u8<br>• ссылка на embed-плеер, который сайт САМ разрешает встраивать (не все сайты это позволяют по тиму my.mail.ru.<br>Такую ссылку обычно нужно искать в исходном коде страницы — сервер её не ищет сам, в отличие от "Захвата плеера".',

};

let privacyPublic = false; // по умолчанию приватная

function lockStatusText() {
  return privacyPublic
    ? '🔓 Открытая — комната появится в разделе "Публичные комнаты" у всех пользователей.'
    : '🔒 Закрытая — комнату никто не увидит в списках, войти можно только по ключу.';
}

function renderInfoPopup() {
  const type = document.getElementById('videoType').value;
  document.getElementById('infoPopup').innerHTML = `${infoTexts[type]}<hr>${lockStatusText()}`;
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

async function createRoom() {
  try {
    const name = document.getElementById('roomName').value.trim();
    if (!name) return alert('Введи название комнаты');

    const selection = document.getElementById('videoType').value;
    const rawUrl = document.getElementById('videoUrl').value.trim();
    if (!rawUrl) return alert('Вставь ссылку на видео');

    let type, url;

    if (selection === 'youtube_twitch') {
      if (/youtube\.com|youtu\.be/.test(rawUrl)) type = 'youtube';
      else if (/twitch\.tv/.test(rawUrl)) type = 'twitch';
      else return alert('Не могу определить YouTube это или Twitch — проверь ссылку');
      url = rawUrl;
    } else if (selection === 'drive') {
      const fileId = extractDriveFileId(rawUrl);
      if (!fileId) return alert('Не удалось распознать ссылку на файл Google Диска');
      type = 'drive';
      url = fileId;
    } else if (selection === 'player_capture') {
      if (!rawUrl.startsWith('http')) return alert('Нужна полная ссылка (начинается с http)');
      type = 'player_capture';
      url = rawUrl;
    } else if (selection === 'direct') {
      if (!rawUrl.startsWith('http')) return alert('Нужна полная ссылка (начинается с http)');
      type = 'direct';
      url = rawUrl;
    } else {
      return alert('Выбери тип видео');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let room;
    try {
      room = await api('/rooms', {
        method: 'POST',
        body: {
          name,
          video: { type, url },
          isPublic: privacyPublic,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!room?.code) {
      throw new Error(room?.error || 'Сервер не вернул код комнаты');
    }
    location.href = `/room.html?code=${room.code}`;
  } catch (err) {
    console.error('[createRoom]', err);
    if (err.name === 'AbortError') {
      alert('Сервер не ответил за 15 секунд. Проверь логи pm2 / MongoDB.');
    } else {
      alert(err.message || 'Не удалось создать комнату');
    }
  }
}

async function joinByCode() {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) return;
  try {
    await api('/rooms/' + code);
    location.href = `/room.html?code=${code}`;
  } catch {
    alert('Комната не найдена или уже удалена');
  }
}

// ---- отрисовка списков комнат ----

function roomThumbnail(room) {
  if (room.video.type === 'youtube') {
    const idMatch = room.video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (idMatch) return `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
  }
  return null;
}

function occupancyLabel(room) {
  return room.viewerCount > 0 ? room.viewerCount : 'пусто';
}

function deletionLabel(room) {
  if (room.viewerCount > 0) return 'не удалится, пока кто-то смотрит';
  if (!room.emptySince) return '';
  const deadline = new Date(room.emptySince).getTime() + 20 * 60 * 60 * 1000;
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) return 'удаляется...';
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 15000);
  return `удалится через ${h}ч ${m}м`;
}

async function deleteRoom(code, ev) {
  ev.stopPropagation();
  if (!confirm('Удалить комнату?')) return;
  try {
    await api('/rooms/' + code, { method: 'DELETE' });
    loadMyRooms();
  } catch (err) { alert(err.message); }
}

function renderRoomCard(room, { showDelete }) {
  const thumb = roomThumbnail(room);
  const card = document.createElement('div');
  card.className = 'room-card';
  card.innerHTML = `
    ${showDelete ? '<button class="delete-btn" title="Удалить комнату">🗑️</button>' : ''}
    ${thumb ? `<img class="room-thumb" src="${thumb}" />` : `<div class="room-thumb-placeholder">🎬</div>`}
    <div class="room-info">
      <span class="room-name">${room.name}</span>
      <span class="room-occupancy">👤 ${occupancyLabel(room)}</span>
    </div>
    <div class="room-actions">
      <button class="enter-btn">Войти</button>
      <div class="countdown">${deletionLabel(room)}</div>
    </div>`;

  card.querySelector('.enter-btn').onclick = () => (location.href = `/room.html?code=${room.code}`);
  if (showDelete) {
    card.querySelector('.delete-btn').onclick = (ev) => deleteRoom(room.code, ev);
  }
  return card;
}

async function loadMyRooms() {
  const input = document.getElementById('searchInput');
  const q = input?.value?.trim() || '';

  try {
    const rooms = await api('/rooms/search?q=' + encodeURIComponent(q));
    const list = document.getElementById('roomList');
    if (!list) return;

    list.innerHTML = '';
    rooms.forEach((room) => list.appendChild(renderRoomCard(room, { showDelete: true })));
  } catch (err) {
    console.warn('[loadMyRooms]', err.message);
  }
}

// ===== Публичные комнаты: состояние =====
let publicState = {
  page: 1,
  sort: 'newest',
  onlyWithPeople: false,
  totalPages: 1,
};

function onPublicFilterChange() {
  publicState.page = 1;
  publicState.sort = document.getElementById('publicSort')?.value || 'newest';
  publicState.onlyWithPeople = document.getElementById('onlyWithPeople')?.checked || false;
  loadPublicRooms();
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
  try {
    const data = await api('/rooms/public?' + params.toString());
    const rooms = data.rooms || [];
    publicState.totalPages = data.totalPages || 1;

    list.innerHTML = '';

    if (!rooms.length) {
      list.innerHTML = '<p style="color:var(--text-muted); font-size:14px;">Публичных комнат пока нет</p>';
      if (paginationEl) paginationEl.classList.add('hidden');
      return;
    }

    rooms.forEach((room) => list.appendChild(renderRoomCard(room, { showDelete: false })));
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
  lobbySocket = io();

  lobbySocket.on('connect', () => {
    lobbySocket.emit('lobby:join');
  });

 lobbySocket.on('rooms:public-updated', () => {
  if (publicState.page === 1 && publicState.sort === 'newest' && !publicState.onlyWithPeople) {
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


// ---- Служба поддержки ----
(function initSupport() {
  const fab = document.getElementById('supportFab');
  const modal = document.getElementById('supportModal');
  const closeBtn = document.getElementById('supportModalClose');
  const sendBtn = document.getElementById('supportSendBtn');
  if (!fab || !modal) return;

  function openSupport() {
    modal.classList.remove('hidden');
    document.getElementById('supportError')?.classList.add('hidden');
    document.getElementById('supportOk')?.classList.add('hidden');
  }
  function closeSupport() {
    modal.classList.add('hidden');
  }

  fab.addEventListener('click', openSupport);
  closeBtn?.addEventListener('click', closeSupport);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSupport();
  });

  sendBtn?.addEventListener('click', async () => {
    const name = (document.getElementById('supportName')?.value || '').trim().slice(0, 12);
    const email = (document.getElementById('supportEmail')?.value || '').trim().slice(0, 26);
    const description = (document.getElementById('supportDesc')?.value || '').trim().slice(0, 1000);
    const errEl = document.getElementById('supportError');
    const okEl = document.getElementById('supportOk');
    errEl?.classList.add('hidden');
    okEl?.classList.add('hidden');

    if (!description || description.length < 5) {
      if (errEl) {
        errEl.textContent = 'Опишите проблему (минимум 5 символов)';
        errEl.classList.remove('hidden');
      }
      return;
    }

    sendBtn.disabled = true;
    try {
      await api('/support', {
        method: 'POST',
        body: { name, email, description },
      });
      if (okEl) okEl.classList.remove('hidden');
      const desc = document.getElementById('supportDesc');
      if (desc) desc.value = '';
      setTimeout(closeSupport, 1200);
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message || 'Не удалось отправить';
        errEl.classList.remove('hidden');
      }
    } finally {
      sendBtn.disabled = false;
    }
  });
})();
checkAuth();