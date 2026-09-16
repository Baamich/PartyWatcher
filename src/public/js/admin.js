let allCommits = [];
let selectedHash = null;

async function loadCommits() {
  const list = document.getElementById('commitList');
  try {
    const data = await api('/admin/commits');
    allCommits = data.commits || [];
    renderCommits(allCommits);
  } catch (err) {
    list.textContent = 'Ошибка загрузки коммитов: ' + err.message;
  }
}

function renderCommits(commits) {
  const list = document.getElementById('commitList');
  if (!commits.length) {
    list.innerHTML = '<div class="commit-empty">Ничего не найдено</div>';
    return;
  }

  list.innerHTML = commits
    .map(
      (c) => `
      <label class="commit-item">
        <input type="radio" name="commit" value="${c.hash}"
          onchange="selectCommit('${c.hash}')"
          ${selectedHash === c.hash ? 'checked' : ''} />
        <span class="commit-hash">${c.short}</span>
        <span class="commit-msg">${escapeHtml(c.message)}</span>
        <span class="commit-meta">${c.author} · ${c.date}</span>
      </label>
    `
    )
    .join('');
}

function selectCommit(hash) {
  selectedHash = hash;
  document.getElementById('revertBtn').disabled = false;
}

function filterCommits() {
  const q = document.getElementById('commitSearch').value.trim().toLowerCase();
  if (!q) return renderCommits(allCommits);
  const filtered = allCommits.filter(
    (c) => c.hash.toLowerCase().includes(q) || c.message.toLowerCase().includes(q)
  );
  renderCommits(filtered);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function runUpdate(hash) {
  const log = document.getElementById('log');
  log.textContent = 'Запуск...\n';
  try {
    await api('/admin/update', {
      method: 'POST',
      body: hash ? { hash } : {},
    });
  } catch (err) {
    log.textContent += 'Ошибка запуска: ' + err.message;
    return;
  }
  pollStatus(log);
}

function revertToCommit() {
  if (!selectedHash) return;
  if (!confirm('Откатить проект на выбранный коммит?')) return;
  runUpdate(selectedHash);
}

function pollStatus(log) {
  const poll = setInterval(async () => {
    const s = await api('/admin/update/status');
    log.textContent = s.log.join('\n');
    if (s.state === 'done' || s.state === 'error') {
      clearInterval(poll);
      log.textContent += s.state === 'done' ? '\n\n✅ Завершено' : '\n\n❌ Ошибка';
    }
  }, 1500);
}

// ---- Support tickets (admin) ----
(function initSupportAdmin() {
  const btn = document.getElementById('supportAdminBtn');
  const badge = document.getElementById('supportBadge');
  const overlay = document.getElementById('supportAdminOverlay');
  const listEl = document.getElementById('supportTicketsList');
  const closeBtn = document.getElementById('supportAdminClose');
  if (!btn || !overlay) return;

  let currentStatus = 'unread';
  let pollTimer = null;

  function setBadge(n) {
    if (!badge) return;
    badge.textContent = String(n ?? 0);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('ru-RU');
    } catch {
      return '';
    }
  }

  async function refreshCount() {
    try {
      const data = await api('/support/count');
      setBadge(data.unreadCount);
    } catch (_) {}
  }

  async function loadTickets() {
    if (!listEl) return;
    try {
      const data = await api('/support?status=' + encodeURIComponent(currentStatus));
      const tickets = data.tickets || [];
      if (!tickets.length) {
        listEl.innerHTML = '<div class="support-empty">Пусто</div>';
        return;
      }
      listEl.innerHTML = tickets
        .map((t) => {
          const showActions = currentStatus === 'unread';
          return `
          <div class="support-card" data-id="${t._id}">
            <div class="support-card-meta">${formatDate(t.createdAt)} · @${escapeHtml(t.username || '—')}</div>
            <div class="support-card-name">${escapeHtml(t.name || 'Без имени')}${t.email ? ' · ' + escapeHtml(t.email) : ''}</div>
            <div class="support-card-desc">${escapeHtml(t.description)}</div>
            ${
              showActions
                ? `<div class="support-card-actions">
                     <button type="button" data-action="accepted" data-id="${t._id}">Принято</button>
                     <button type="button" class="btn-trivial" data-action="trivial" data-id="${t._id}">Пустяк</button>
                   </div>`
                : ''
            }
          </div>`;
        })
        .join('');
    } catch (e) {
      listEl.innerHTML = '<div class="support-empty">Ошибка: ' + escapeHtml(e.message) + '</div>';
    }
  }

  async function setStatus(id, status) {
    try {
      const data = await api('/support/' + id + '/status', {
        method: 'PATCH',
        body: { status },
      });
      if (data.unreadCount != null) setBadge(data.unreadCount);
      await loadTickets();
    } catch (e) {
      alert(e.message || 'Ошибка');
    }
  }

  listEl?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    setStatus(b.dataset.id, b.dataset.action);
  });

  document.querySelectorAll('.support-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.support-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentStatus = tab.dataset.status;
      loadTickets();
    });
  });

  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    loadTickets();
    refreshCount();
  });
  closeBtn?.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  refreshCount();
  pollTimer = setInterval(() => {
    refreshCount();
    if (!overlay.classList.contains('hidden')) loadTickets();
  }, 5000);

  // socket (если доступен на этом origin)
  try {
    if (typeof io === 'function') {
      const socket = io({ withCredentials: true });
      socket.on('support:count', (p) => setBadge(p.unreadCount));
      socket.on('support:new', () => {
        refreshCount();
        if (!overlay.classList.contains('hidden') && currentStatus === 'unread') loadTickets();
      });
      socket.on('support:updated', () => {
        refreshCount();
        if (!overlay.classList.contains('hidden')) loadTickets();
      });
    }
  } catch (_) {}
})();

loadCommits();