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

function vodStatusLabel(v) {
  if (v.status === 'recording') return '<span class="badge-rec">идёт запись</span>';
  if (v.status === 'processing') return '<span class="badge-rec">сжимается…</span>';
  if (v.published) return '<span class="badge-pub">на профиле</span>';
  return '';
}

function buildVodCard(v) {
  const card = document.createElement('div');
  card.className = 'vod-card';
  card.dataset.id = v.id;
  card.dataset.status = v.status;

  card.innerHTML = `
    <div class="vod-card-top">
      <div class="vod-card-head">Запись стрима ${escapeHtml(fmtDay(v.createdAt))}<span class="vod-status-slot">${vodStatusLabel(v)}</span></div>
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
    loadVods({ silent: false });
  };
  card.querySelector('[data-edit]').onclick = () => openEditVod(v);
  card.querySelector('[data-del]').onclick = () => openDelVod(v.id);
  return card;
}

/** Тихо обновить одну карточку, если status/url изменились — без сброса остальных video */
function patchVodCard(card, v) {
  const prev = card.dataset.status;
  if (prev === v.status && (v.status !== 'ready' || card.querySelector('video'))) {
    // только бейдж published мог смениться — обновим кнопку
    const pubBtn = card.querySelector('[data-pub]');
    if (pubBtn && v.status === 'ready') {
      pubBtn.disabled = false;
      pubBtn.textContent = v.published ? 'Снять с профиля' : 'Опубликовать';
    }
    return;
  }

  card.dataset.status = v.status;
  const slot = card.querySelector('.vod-status-slot');
  if (slot) slot.innerHTML = vodStatusLabel(v);

  const media = card.querySelector('.vod-media');
  if (media && v.url && !card.querySelector('video')) {
    media.innerHTML = `<video src="${v.url}" controls preload="metadata"></video>`;
  }

  const pubBtn = card.querySelector('[data-pub]');
  if (pubBtn) {
    pubBtn.disabled = v.status !== 'ready';
    if (v.status === 'ready') {
      pubBtn.textContent = v.published ? 'Снять с профиля' : 'Опубликовать';
    }
  }
}

async function loadVods({ silent = false } = {}) {
  const list = document.getElementById('vodList');
  let vods;
  try {
    vods = await api('/workbench/vods');
  } catch (e) {
    if (!silent) list.innerHTML = `<p style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    return;
  }

  if (!vods.length) {
    if (!silent) list.innerHTML = '<p class="wb-subpage-hint">Записей пока нет — они появятся после эфира.</p>';
    return;
  }

  const hasBusy = vods.some((v) => v.status === 'recording' || v.status === 'processing');

  if (!silent || !list.querySelector('.vod-card')) {
    // первая отрисовка
    list.innerHTML = '';
    vods.forEach((v) => list.appendChild(buildVodCard(v)));
  } else {
    // тихий апдейт: патчим существующие, добавляем новые в начало
    const existing = new Map();
    list.querySelectorAll('.vod-card[data-id]').forEach((el) => {
      existing.set(el.dataset.id, el);
    });

    const seen = new Set();
    vods.forEach((v) => {
      const id = String(v.id);
      seen.add(id);
      const card = existing.get(id);
      if (card) {
        patchVodCard(card, v);
      } else {
        list.insertBefore(buildVodCard(v), list.firstChild);
      }
    });

    // удалить карточки, которых больше нет
    existing.forEach((el, id) => {
      if (!seen.has(id)) el.remove();
    });
  }

  clearInterval(pollTimer);
  if (hasBusy) {
    pollTimer = setInterval(() => loadVods({ silent: true }), 5000);
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