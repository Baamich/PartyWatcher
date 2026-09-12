async function checkAuth() {
  try {
    const me = await api('/auth/me');
    document.getElementById('authBox').classList.add('hidden');
    document.getElementById('appBox').classList.remove('hidden');
    document.getElementById('meName').textContent = me.username;

    const adminLink = document.getElementById('adminLink');
    adminLink.classList.toggle('hidden', me.role !== 'admin');

    loadMyRooms();
    startAutoRefresh();
  } catch {
    document.getElementById('authBox').classList.remove('hidden');
    document.getElementById('appBox').classList.add('hidden');
    stopAutoRefresh();
  }
}

async function login() {
  try {
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        login: document.getElementById('loginInput').value,
        password: document.getElementById('passwordInput').value,
      }),
    });
    checkAuth();
  } catch (err) { alert(err.message); }
}

async function register() {
  try {
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('regUsername').value,
        email: document.getElementById('regEmail').value,
        password: document.getElementById('regPassword').value,
      }),
    });
    checkAuth();
  } catch (err) { alert(err.message); }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  stopAutoRefresh();
  checkAuth();
}

// ---- выбор типа видео + инфо-подсказка ----

const infoTexts = {
  youtube_twitch: 'Вставь ссылку на видео с YouTube (youtube.com/watch?v=... или youtu.be/...) или на запись (VOD) с Twitch (twitch.tv/videos/1234567890 — именно запись, не текущий эфир). Тип определится автоматически по ссылке.',
  drive: 'На Google Диске: правой кнопкой по видео → "Открыть доступ" → "Все, у кого есть ссылка" → скопируй ссылку и вставь сюда. Без этого сервер не сможет прочитать файл.',
};

function updateInfoText() {
  const type = document.getElementById('videoType').value;
  document.getElementById('infoPopup').textContent = infoTexts[type];
}

function toggleInfoPopup() {
  updateInfoText();
  document.getElementById('infoPopup').classList.toggle('hidden');
}

function onVideoTypeChange() {
  const popup = document.getElementById('infoPopup');
  if (!popup.classList.contains('hidden')) updateInfoText();
}

function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function parseVkVideo(input) {
  const trimmed = input.trim();

  // 1) уже готовый embed (вставили весь HTML-код "Поделиться → Код для вставки" или просто ссылку video_ext.php)
  //    вытаскиваем oid/id/hash напрямую — это самый надёжный вариант
  const extMatch = trimmed.match(/video_ext\.php\?([^"'\s]+)/);
  if (extMatch) {
    const params = new URLSearchParams(extMatch[1]);
    const oid = params.get('oid');
    const id = params.get('id');
    const hash = params.get('hash');
    if (oid && id) {
      return `https://vk.com/video_ext.php?oid=${oid}&id=${id}${hash ? `&hash=${hash}` : ''}&hd=2`;
    }
  }

  // 2) обычная ссылка на страницу: vk.com / vkvideo.ru / vk.ru / m.vk.com,
  //    video-OID_ID (паблики/группы, OID отрицательный) или video OID_ID (личная страница), плюс clip-OID_ID
  const pageMatch = trimmed.match(/(?:vk\.com|vkvideo\.ru|vk\.ru|m\.vk\.com)\/(?:video|clip)(-?\d+)_(\d+)/);
  if (pageMatch) {
    const [, oid, id] = pageMatch;
    return `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2`;
  }

  return null;
}

async function createRoom() {
  try {
    const selection = document.getElementById('videoType').value;
    const rawUrl = document.getElementById('videoUrl').value.trim();
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
    }

    const room = await api('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('roomName').value, video: { type, url } }),
    });
    location.href = `/room.html?code=${room.code}`;
  } catch (err) { alert(err.message); }
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
  const m = Math.floor((msLeft % 3600000) / 60000);
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

async function loadMyRooms() {
  const q = document.getElementById('searchInput')?.value || '';
  const rooms = await api('/rooms/search?q=' + encodeURIComponent(q));
  const list = document.getElementById('roomList');
  list.innerHTML = '';

  rooms.forEach((room) => {
    const thumb = roomThumbnail(room);
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <button class="delete-btn" title="Удалить комнату">🗑️</button>
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
    card.querySelector('.delete-btn').onclick = (ev) => deleteRoom(room.code, ev);
    list.appendChild(card);
  });
}

let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(loadMyRooms, 5000);
}
function stopAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

checkAuth();