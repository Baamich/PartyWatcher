async function checkAuth() {
  try {
    const me = await api('/auth/me');
    document.getElementById('authBox').classList.add('hidden');
    document.getElementById('appBox').classList.remove('hidden');
    document.getElementById('meName').textContent = me.username;

    const adminLink = document.getElementById('adminLink');
    adminLink.classList.toggle('hidden', me.role !== 'admin');

    loadMyRooms();
  } catch {
    document.getElementById('authBox').classList.remove('hidden');
    document.getElementById('appBox').classList.add('hidden');
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
  checkAuth();
}

function onVideoTypeChange() {
  const type = document.getElementById('videoType').value;
  const urlInput = document.getElementById('videoUrl');
  const fileInput = document.getElementById('videoFile');

  if (type === 'upload') {
    urlInput.classList.add('hidden');
    fileInput.classList.remove('hidden');
  } else {
    urlInput.classList.remove('hidden');
    fileInput.classList.add('hidden');
  }
}

async function createRoom() {
  try {
    const type = document.getElementById('videoType').value;
    let url = document.getElementById('videoUrl').value;

    if (type === 'upload') {
      const fileInput = document.getElementById('videoFile');
      if (!fileInput.files[0]) return alert('Выбери файл');

      const formData = new FormData();
      formData.append('video', fileInput.files[0]);

      const res = await fetch('/api/videos/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      url = data.url;
    }

    const room = await api('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('roomName').value,
        video: { type, url },
      }),
    });
    location.href = `/room.html?code=${room.code}`;
  } catch (err) { alert(err.message); }
}

async function joinByCode() {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) return;
  try {
    await api('/rooms/' + code); // проверяем, что существует
    location.href = `/room.html?code=${code}`;
  } catch (err) { alert('Комната не найдена или уже удалена'); }
}

function roomThumbnail(room) {
  if (room.video.type === 'youtube') {
    const idMatch = room.video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (idMatch) return `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
  }
  return null; // для direct/upload превью нет — показываем иконку
}

function timeLeftLabel(room) {
  if (!room.emptySince) return 'активна';
  const deadline = new Date(room.emptySince).getTime() + 20 * 60 * 60 * 1000;
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) return 'удаляется...';
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return `удалится через ${h}ч ${m}м`;
}

async function loadMyRooms() {
  const q = document.getElementById('searchInput')?.value || '';
  const rooms = await api('/rooms/search?q=' + encodeURIComponent(q));
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  rooms.forEach((room) => {
    const thumb = roomThumbnail(room);
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; gap:8px; align-items:center; cursor:pointer;';
    div.innerHTML = `
      ${thumb ? `<img src="${thumb}" width="80" />` : `<span style="font-size:32px;">🎬</span>`}
      <div>
        <div><b>${room.name}</b> (${room.code})</div>
        <div style="font-size:12px;color:#888;">${timeLeftLabel(room)}</div>
      </div>`;
    div.onclick = () => (location.href = `/room.html?code=${room.code}`);
    list.appendChild(div);
  });
}

checkAuth();