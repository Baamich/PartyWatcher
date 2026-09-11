async function checkAuth() {
  try {
    const me = await api('/auth/me');
    document.getElementById('authBox').classList.add('hidden');
    document.getElementById('appBox').classList.remove('hidden');
    document.getElementById('meName').textContent = me.username;
    searchRooms();
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

async function createRoom() {
  try {
    const room = await api('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('roomName').value,
        video: {
          type: document.getElementById('videoType').value,
          url: document.getElementById('videoUrl').value,
        },
      }),
    });
    location.href = `/room.html?code=${room.code}`;
  } catch (err) { alert(err.message); }
}

async function searchRooms() {
  const q = document.getElementById('searchInput').value;
  const rooms = await api('/rooms/search?q=' + encodeURIComponent(q));
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  rooms.forEach((room) => {
    const div = document.createElement('div');
    div.textContent = `${room.name} (${room.code})`;
    div.onclick = () => (location.href = `/room.html?code=${room.code}`);
    list.appendChild(div);
  });
}

checkAuth();