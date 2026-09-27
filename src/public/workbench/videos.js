let editVodId = null;
let delVodId = null;
let pollTimer = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmt(d) {
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDay(d) {
  return new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    if (me.streamerName) {
      location.href = '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase());
    } else {
      location.href = '/streamers/edit.html';
    }
  } catch {
    location.href = '/index.html';
  }
}

function openEditVod(v) {
  editVodId = v.id;
  document.getElementById('editVodTitle').value = v.title || '';
  document.getElementById('editVodDesc').value = v.description || '';
  document.getElementById('editVodModal').classList.remove('hidden');
}

function closeEditVod() {
  editVodId = null;
  document.getElementById('editVodModal').classList.add('hidden');
}

async function saveEditVod() {
  if (!editVodId) return;
  await api('/workbench/vods/' + editVodId, {
    method: 'PATCH',
    body: {
      title: document.getElementById('editVodTitle').value,
      description: document.getElementById('editVodDesc').value,
    },
  });
  closeEditVod();
  loadVods();
}

function openDelVod(id) {
  delVodId = id;
  document.getElementById('delVodModal').classList.remove('hidden');
}

function closeDelVod() {
  delVodId = null;
  document.getElementById('delVodModal').classList.add('hidden');
}

async function confirmDelVod() {
  if (!delVodId) return;
  await api('/workbench/vods/' + delVodId, { method: 'DELETE' });
  closeDelVod();
  loadVods();
}

async function loadVods() {
  const list = document.getElementById('vodList');
  let vods;
  try {
    vods = await api('/workbench/vods');
  } catch (e) {
    list.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    return;
  }

  if (!vods.length) {
    list.innerHTML = '<p class="wb-subpage-hint">Записей пока нет — они появятся после эфира.</p>';
    return;
  }

  const hasRecording = vods.some((v) => v.status === 'recording');
  list.innerHTML = '';

  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    const statusBadge =
      v.status === 'recording'
        ? '<span class="badge-rec">идёт запись</span>'
        : v.published
          ? '<span class="badge-pub">на профиле</span>'
          : '';

    card.innerHTML = `
      <div class="vod-card-top">
        <div class="vod-card-head">Запись стрима ${escapeHtml(fmtDay(v.createdAt))}${statusBadge}</div>
        <div class="vod-meta">${escapeHtml(fmt(v.createdAt))} — ${escapeHtml(fmt(v.expiresAt))}
          <span class="vod-meta-note">(после срока удалится, в том числе с профиля)</span>
        </div>
      </div>
      <div class="vod-card-body">
        <div class="vod-main">
          <div class="vod-media">
            ${v.url
              ? `<video src="${v.url}" controls preload="metadata"></video>`
              : '<div class="vod-pending">Файл ещё пишется…</div>'}
          </div>
          <div class="vod-meta-fields">
            <div class="vod-field">
              <span class="vod-field-label">Название</span>
              <span class="vod-field-val">${escapeHtml(v.title || '—')}</span>
            </div>
            <div class="vod-field">
              <span class="vod-field-label">Описание</span>
              <span class="vod-field-val">${escapeHtml(v.description || '—')}</span>
            </div>
          </div>
        </div>
        <div class="vod-side-actions">
          <button type="button" class="icon-btn" data-pub ${v.status !== 'ready' ? 'disabled' : ''}>
            ${v.published ? 'Снять с профиля' : 'Опубликовать'}
          </button>
          <button type="button" class="icon-btn" data-edit>Редактировать</button>
          <button type="button" class="icon-btn vod-btn-danger" data-del>Удалить</button>
        </div>
      </div>
    `;

    card.querySelector('[data-pub]').onclick = async () => {
      await api('/workbench/vods/' + v.id, {
        method: 'PATCH',
        body: { published: !v.published },
      });
      loadVods();
    };
    card.querySelector('[data-edit]').onclick = () => openEditVod(v);
    card.querySelector('[data-del]').onclick = () => openDelVod(v.id);
    list.appendChild(card);
  });

  // автообновление, пока есть «идёт запись»
  clearInterval(pollTimer);
  if (hasRecording) {
    pollTimer = setInterval(loadVods, 5000);
  }
}

document.getElementById('editVodModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'editVodModal') closeEditVod();
});
document.getElementById('delVodModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'delVodModal') closeDelVod();
});

async function init() {
  try {
    await api('/auth/me');
  } catch {
    location.href = '/index.html';
    return;
  }
  loadVods();
}

init();