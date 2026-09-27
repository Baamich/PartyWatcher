function getNameFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || '').toLowerCase();
}

function initialLetter(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function renderProfile(streamer) {
  const banner = document.getElementById('banner');
  if (streamer.streamerBannerUrl) {
    banner.style.backgroundImage = `url('${streamer.streamerBannerUrl}')`;
  }

  const avatar = document.getElementById('profileAvatar');
  if (streamer.streamerAvatarUrl) {
    avatar.style.backgroundImage = `url('${streamer.streamerAvatarUrl}')`;
    avatar.textContent = '';
  } else {
    avatar.textContent = initialLetter(streamer.streamerName);
  }

  document.getElementById('liveBadge').classList.toggle('hidden', !streamer.isLive);
  document.getElementById('profileName').textContent = streamer.streamerName;

  const bio = (streamer.streamerBio || '').trim();
  const bioShortEl = document.getElementById('profileBioShort');
  const expandBtn = document.getElementById('bioExpandBtn');

  if (!bio) {
    bioShortEl.textContent = 'Описание пока не заполнено';
    expandBtn.classList.add('hidden');
  } else {
    bioShortEl.textContent = bio;
    expandBtn.classList.toggle('hidden', bio.length <= 120);
  }

  document.getElementById('bioModalName').textContent = streamer.streamerName;
  document.getElementById('bioModalText').textContent = bio || 'Описание пока не заполнено';
}

function openBioModal() {
  document.getElementById('bioModal').classList.remove('hidden');
}

function closeBioModal() {
  document.getElementById('bioModal').classList.add('hidden');
}

async function checkOwnership(nameLower) {
  try {
    const me = await api('/auth/me');
    if (me.streamerName && me.streamerName.toLowerCase() === nameLower) {
      document.getElementById('ownerControls').classList.remove('hidden');
    }
  } catch {
    // не авторизован — просто не показываем управление
  }
}

async function loadVods(nameLower) {
  try {
    const vods = await api('/streamers/' + encodeURIComponent(nameLower) + '/vods');
    const section = document.getElementById('vodSection');
    const grid = document.getElementById('vodGrid');
    if (!vods.length || !section || !grid) return;
    section.classList.remove('hidden');
    grid.innerHTML = '';
    vods.forEach((v) => {
      const card = document.createElement('div');
      card.className = 'vod-card';
      card.innerHTML = `
        <video src="${v.url}" controls preload="metadata"></video>
        <div class="vod-card-body">
          <div class="vod-card-title"></div>
          <div class="vod-card-meta"></div>
        </div>`;
      card.querySelector('.vod-card-title').textContent = v.title || 'Запись';
      card.querySelector('.vod-card-meta').textContent = new Date(v.createdAt).toLocaleString('ru-RU');
      grid.appendChild(card);
    });
  } catch (e) {
    console.warn('[loadVods]', e.message);
  }
}

async function loadProfile() {
  const nameLower = getNameFromUrl();
  if (!nameLower) {
    document.getElementById('notFound').classList.remove('hidden');
    return;
  }

  try {
    const streamer = await api('/streamers/' + encodeURIComponent(nameLower));
    renderProfile(streamer);
    document.getElementById('streamerProfile').classList.remove('hidden');
    checkOwnership(nameLower);
    loadVods(nameLower);
  } catch (err) {
    console.warn('[loadProfile]', err.message);
    document.getElementById('notFound').classList.remove('hidden');
  }
}

document.getElementById('bioModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'bioModal') closeBioModal();
});

loadProfile();