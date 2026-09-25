let pendingAvatarBase64;
let pendingBannerBase64;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function showToast(type, message) {
  const el = document.getElementById('saveToast');
  if (!el) return;
  el.textContent = message;
  el.className = `save-toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

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
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('error', 'Нужно выбрать картинку');
    event.target.value = '';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast('error', 'Файл слишком большой (максимум 4 МБ)');
    event.target.value = '';
    return;
  }

  try {
    const base64 = await readFileAsBase64(file);
    setPreview(kind, base64);
    if (kind === 'avatar') pendingAvatarBase64 = base64;
    else pendingBannerBase64 = base64;
  } catch (err) {
    showToast('error', err.message);
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
  const bioEl = document.getElementById('bioInput');
  if (!bioEl) {
    showToast('error', 'Форма не загружена — обнови страницу');
    return;
  }

  const body = { streamerBio: bioEl.value };
  if (pendingAvatarBase64 !== undefined) body.streamerAvatarUrl = pendingAvatarBase64;
  if (pendingBannerBase64 !== undefined) body.streamerBannerUrl = pendingBannerBase64;

  try {
    await api('/streamers/me', { method: 'PATCH', body });
    showToast('success', 'Сохранено');
  } catch (err) {
    showToast('error', err.message || 'Не удалось сохранить');
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