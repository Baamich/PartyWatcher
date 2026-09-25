async function init() {
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    alert('Сначала войди в аккаунт');
    location.href = '/index.html';
    return;
  }

  if (me.streamerName) {
    showEditSection(me);
  } else {
    document.getElementById('createNameSection').classList.remove('hidden');
  }
}

function showEditSection(me) {
  document.getElementById('editProfileSection').classList.remove('hidden');
  document.getElementById('currentStreamerName').textContent = me.streamerName;
}

async function submitStreamerName() {
  const errEl = document.getElementById('createNameError');
  errEl.classList.add('hidden');

  const name = document.getElementById('newStreamerName').value.trim();
  if (!name) {
    errEl.textContent = 'Введите имя';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const result = await api('/streamers', {
      method: 'POST',
      body: { streamerName: name },
    });
    document.getElementById('createNameSection').classList.add('hidden');
    showEditSection({ streamerName: result.streamerName });
  } catch (err) {
    errEl.textContent = err.message || 'Не удалось создать имя';
    errEl.classList.remove('hidden');
  }
}

async function submitProfile() {
  const errEl = document.getElementById('editError');
  const okEl = document.getElementById('editOk');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  const body = {
    streamerBio: document.getElementById('bioInput').value,
    streamerAvatarUrl: document.getElementById('avatarUrlInput').value.trim() || null,
    streamerBannerUrl: document.getElementById('bannerUrlInput').value.trim() || null,
  };

  try {
    await api('/streamers/me', { method: 'PATCH', body });
    okEl.classList.remove('hidden');
    setTimeout(() => okEl.classList.add('hidden'), 1500);
  } catch (err) {
    errEl.textContent = err.message || 'Не удалось сохранить';
    errEl.classList.remove('hidden');
  }
}

async function goToOwnProfile() {
  try {
    const me = await api('/auth/me');
    if (me.streamerName) location.href = `/streamers/${encodeURIComponent(me.streamerName.toLowerCase())}`;
  } catch {
    location.href = '/index.html';
  }
}

init();