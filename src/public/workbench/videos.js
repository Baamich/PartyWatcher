function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmt(d) {
  return new Date(d).toLocaleString('ru-RU');
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
    list.innerHTML = '<p style="color:var(--text-muted)">Записей пока нет — они появятся после эфира.</p>';
    return;
  }

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
      <div class="vod-card-head">${escapeHtml(v.title || 'Без названия')}${statusBadge}</div>
      <div class="vod-meta">${fmt(v.createdAt)} · удалится ${fmt(v.expiresAt)} · ${v.status}</div>
      ${v.url
        ? `<video src="${v.url}" controls preload="metadata"></video>`
        : '<p style="color:var(--text-muted);font-size:13px">Файл ещё пишется…</p>'}
      <div class="vod-actions">
        <input data-title type="text" maxlength="140" value="${escapeHtml(v.title || '')}" placeholder="Название" />
        <button type="button" class="icon-btn" data-save>Сохранить</button>
        <button type="button" class="icon-btn" data-pub ${v.status !== 'ready' ? 'disabled' : ''}>
          ${v.published ? 'Снять с профиля' : 'Опубликовать'}
        </button>
        <button type="button" class="icon-btn" data-del>Удалить</button>
      </div>
      <textarea data-desc maxlength="2000" placeholder="Описание">${escapeHtml(v.description || '')}</textarea>
    `;
    card.querySelector('[data-save]').onclick = async () => {
      await api('/workbench/vods/' + v.id, {
        method: 'PATCH',
        body: {
          title: card.querySelector('[data-title]').value,
          description: card.querySelector('[data-desc]').value,
        },
      });
      loadVods();
    };
    card.querySelector('[data-pub]').onclick = async () => {
      await api('/workbench/vods/' + v.id, {
        method: 'PATCH',
        body: { published: !v.published },
      });
      loadVods();
    };
    card.querySelector('[data-del]').onclick = async () => {
      if (!confirm('Удалить запись навсегда?')) return;
      await api('/workbench/vods/' + v.id, { method: 'DELETE' });
      loadVods();
    };
    list.appendChild(card);
  });
}

loadVods();