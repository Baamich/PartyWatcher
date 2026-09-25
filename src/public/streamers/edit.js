let pendingAvatarBase64; // undefined = не менялось, строка = новое изображение
let pendingBannerBase64;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 МБ на файл (совпадает с лимитом на сервере)

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
    await showEditSection(me.streamerName);
  } else {
    document.getElementById('createNameSection').classList.remove('hidden');
  }
}

async function showEditSection(streamerName) {
  document.getElementById('editProfileSection').classList.remove('hidden');
  document.getElementById('currentStreamerName').textContent = streamerName;

  try {
    const streamer = await api('/streamers/' + encodeURIComponent(streamerName.toLowerCase()));
    document.getElementById('bioInput').value = streamer.streamerBio || '';
    if (streamer.streamerAvatarUrl) setPreview('avatar', streamer.streamerAvatarUrl);
    if (streamer.streamerBannerUrl) setPreview('banner', streamer.streamerBannerUrl);
  } catch (err) {
    console.warn('[showEditSection]', err.message);
  }
}

function setPreview(kind, dataUrl) {
  const el = document.getElementById(kind + 'Preview');
  if (el) el.style.backgroundImage = `url('${dataUrl}')`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

async function onImageSelected(event, kind) {
  const errEl = document.getElementById('editError');
  errEl.classList.add('hidden');

  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    errEl.textContent = 'Нужно выбрать картинку';
    errEl.classList.remove('hidden');
    event.target.value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    errEl.textContent = 'Файл слишком большой (максимум 4 МБ)';
    errEl.classList.remove('hidden');
    event.target.value = '';
    return;
  }

  try {
    const base64 = await readFileAsBase64(file);
    setPreview(kind, base64);
    if (kind === 'avatar') pendingAvatarBase64 = base64;
    else pendingBannerBase64 = base64;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
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
    await showEditSection(result.streamerName);
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

  const body = { streamerBio: document.getElementById('bioInput').value };
  if (pendingAvatarBase64 !== undefined) body.streamerAvatarUrl = pendingAvatarBase64;
  if (pendingBannerBase64 !== undefined) body.streamerBannerUrl = pendingBannerBase64;

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