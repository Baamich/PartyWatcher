let allCommits = [];
let selectedHash = null;

async function loadCommits() {
  const list = document.getElementById('commitList');
  try {
    const data = await api('/admin/commits');
    allCommits = data.commits || [];
    renderCommits(allCommits);
  } catch (err) {
    list.textContent = t('admin.commits.loadFailed') + ' ' + err.message;
  }
}

function renderCommits(commits) {
  const list = document.getElementById('commitList');
  if (!commits.length) {
    list.innerHTML = `<div class="commit-empty">${t('admin.commits.empty')}</div>`;
    return;
  }

  list.innerHTML = commits
    .map(
      (c) => `
      <label class="commit-item">
        <input type="radio" name="commit" value="${escapeHtml(c.hash)}"
          ${selectedHash === c.hash ? 'checked' : ''} />
        <span class="commit-hash">${escapeHtml(c.short)}</span>
        <span class="commit-msg">${escapeHtml(c.message)}</span>
        <span class="commit-meta">${escapeHtml(c.author)} · ${escapeHtml(c.date)}</span>
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
  log.textContent = t('admin.update.starting') + '\n';
  try {
    await api('/admin/update', {
      method: 'POST',
      body: hash ? { hash } : {},
    });
  } catch (err) {
    log.textContent += t('admin.update.startFailed') + ' ' + err.message;
    return;
  }
  pollStatus(log);
}

async function revertToCommit() {
  if (!selectedHash) return;
  const ok = await PW.confirm(t('admin.revert.text'), {
    title: t('admin.revert.title'),
    okText: t('admin.revert.ok'),
    danger: true,
  });
  if (!ok) return;
  runUpdate(selectedHash);
}

function pollStatus(log) {
  const poll = setInterval(async () => {
    const s = await api('/admin/update/status');
    log.textContent = s.log.join('\n');
    if (s.state === 'done' || s.state === 'error') {
      clearInterval(poll);
      log.textContent += s.state === 'done' ? '\n\n✅ ' + t('admin.update.done') : '\n\n❌ ' + t('admin.update.error');
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
  const searchEl = document.getElementById('supportSearch');
  const viewModal = document.getElementById('ticketViewModal');
  const replyModal = document.getElementById('replyModal');
  if (!btn || !overlay) return;

  let currentStatus = 'unread';
  let currentQuery = '';
  let openTicket = null; // { ticket, reply } — что открыто в окне просмотра
  let searchTimer = null;

  function setBadge(n) {
    if (!badge) return;
    badge.textContent = String(n ?? 0);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(I18N.locale);
    } catch {
      return '';
    }
  }

  // кнопки действий: просмотр, ответ (только при почте) и перенос в любой другой статус — в любой момент
  function actionsHtml(tk, withView) {
    const id = escapeHtml(tk._id);
    const noMail = !tk.email;
    let html = '';
    if (withView) html += `<button type="button" class="btn-trivial" data-act="view" data-id="${id}">${t('admin.support.view')}</button>`;
    html += `<button type="button" data-act="reply" data-id="${id}"${noMail ? ' disabled' : ''} title="${escapeHtml(noMail ? t('admin.support.noEmailHint') : t('admin.support.reply'))}">${t('admin.support.reply')}</button>`;
    if (tk.status !== 'accepted') html += `<button type="button" data-act="accepted" data-id="${id}">${t('admin.support.accept')}</button>`;
    if (tk.status !== 'trivial') html += `<button type="button" class="btn-trivial" data-act="trivial" data-id="${id}">${t('admin.support.trivial')}</button>`;
    if (tk.status !== 'unread') html += `<button type="button" class="btn-trivial" data-act="unread" data-id="${id}">${t('admin.support.toUnread')}</button>`;
    return html;
  }

  function metaHtml(tk) {
    const src = tk.source === 'email' ? t('admin.support.fromEmail') : t('admin.support.fromSite');
    const fresh = tk.hasNewReply ? ` <span class="support-new">${t('admin.support.newReply')}</span>` : '';
    return `<b class="support-num">#${escapeHtml(tk.number ?? '—')}</b> · ${src} · ${formatDate(tk.createdAt)} · @${escapeHtml(tk.username || '—')}${fresh}`;
  }

  function cardHtml(tk) {
    return `
      <div class="support-card${tk.hasNewReply ? ' support-card--fresh' : ''}" data-id="${escapeHtml(tk._id)}">
        <div class="support-card-meta">${metaHtml(tk)}</div>
        <div class="support-card-name">${escapeHtml(tk.name || t('admin.support.noName'))}${tk.email ? ' · ' + escapeHtml(tk.email) : ' · ' + t('admin.support.noEmail')}</div>
        ${tk.subject ? `<div class="support-card-subject">${escapeHtml(tk.subject)}</div>` : ''}
        <div class="support-card-desc">${escapeHtml(tk.description)}</div>
        ${tk.messagesCount ? `<div class="support-card-meta">${t('admin.support.messages', { n: tk.messagesCount })}</div>` : ''}
        <div class="support-card-actions">${actionsHtml(tk, true)}</div>
      </div>`;
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
      const qs = currentQuery ? 'q=' + encodeURIComponent(currentQuery) : 'status=' + encodeURIComponent(currentStatus);
      const data = await api('/support?' + qs);
      const tickets = data.tickets || [];
      if (!tickets.length) {
        listEl.innerHTML = `<div class="support-empty">${currentQuery ? t('admin.support.notFound') : t('admin.support.empty')}</div>`;
        return;
      }
      listEl.innerHTML = tickets.map(cardHtml).join('');
    } catch (e) {
      listEl.innerHTML = '<div class="support-empty">' + escapeHtml(t('admin.error') + ' ' + e.message) + '</div>';
    }
  }

  // ---- просмотр обращения ----
  function messageHtml(m) {
    const support = m.from === 'support';
    let body;
    if (m.kind === 'accepted' || m.kind === 'trivial') {
      const label = m.kind === 'accepted' ? t('admin.support.accept') : t('admin.support.trivial');
      body = `<i>${escapeHtml(t('admin.thread.statusMail', { status: label }))}</i>`;
    } else {
      body = escapeHtml(m.text);
    }
    const mail = support ? (m.emailed ? ' · ✉️ ' + t('admin.thread.emailed') : ' · ' + t('admin.thread.notEmailed')) : '';
    const who = support ? t('admin.thread.support', { name: m.author || '—' }) : t('admin.thread.user');
    return `
      <div class="ticket-msg ${support ? 'ticket-msg--support' : 'ticket-msg--user'}">
        <div class="ticket-msg-head">${escapeHtml(who)} · ${formatDate(m.at)}${escapeHtml(mail)}</div>
        <div class="ticket-msg-text">${body}</div>
      </div>`;
  }

  function renderView() {
    const { ticket: tk } = openTicket;
    document.getElementById('ticketViewTitle').textContent =
      t('admin.thread.title', { n: tk.number ?? '—' }) + (tk.subject ? ' — ' + tk.subject : '');
    document.getElementById('ticketViewMeta').innerHTML =
      metaHtml(tk) + '<br>' + escapeHtml(tk.name || t('admin.support.noName')) + ' · ' +
      (tk.email ? escapeHtml(tk.email) : t('admin.support.noEmail')) + ' · ' +
      escapeHtml(t('admin.thread.lang', { lang: (tk.lang || 'ru').toUpperCase() }));
    const first = { from: 'user', kind: 'user', text: tk.description, at: tk.createdAt };
    document.getElementById('ticketViewThread').innerHTML = [first, ...(tk.messages || [])].map(messageHtml).join('');
    document.getElementById('ticketViewActions').innerHTML = actionsHtml(tk, false);
  }

  async function openView(id) {
    try {
      openTicket = await api('/support/' + encodeURIComponent(id));
      renderView();
      viewModal.classList.remove('hidden');
      refreshCount();
    } catch (e) {
      PW.toast(e.message || t('admin.error'), 'error');
    }
  }

  // ---- ответ ----
  async function openReply(id) {
    try {
      if (!openTicket || openTicket.ticket._id !== id) openTicket = await api('/support/' + encodeURIComponent(id));
      const { ticket: tk, reply } = openTicket;
      if (!reply) return PW.toast(t('admin.support.noEmailHint'), 'error');
      document.getElementById('replyTitle').textContent = t('admin.reply.title', { n: tk.number ?? '—' });
      document.getElementById('replyTo').value = tk.email;
      document.getElementById('replySubject').value = reply.subject;
      document.getElementById('replyFooter').textContent = reply.footer;
      replyModal.classList.remove('hidden');
      document.getElementById('replyText').focus();
    } catch (e) {
      PW.toast(e.message || t('admin.error'), 'error');
    }
  }

  async function sendReply() {
    const sendBtn = document.getElementById('replySendBtn');
    const textEl = document.getElementById('replyText');
    const text = textEl.value.trim();
    if (!text) return PW.toast(t('admin.reply.empty'), 'error');
    const id = openTicket.ticket._id;
    sendBtn.disabled = true;
    try {
      const data = await api('/support/' + encodeURIComponent(id) + '/reply', { method: 'POST', body: { text } });
      if (data.unreadCount != null) setBadge(data.unreadCount);
      textEl.value = '';
      replyModal.classList.add('hidden');
      PW.toast(t('admin.reply.sent'), 'success');
      if (!viewModal.classList.contains('hidden')) await openView(id);
      await loadTickets();
    } catch (e) {
      PW.toast(e.message || t('admin.error'), 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  // ---- статус ----
  async function setStatus(id, status) {
    try {
      const data = await api('/support/' + encodeURIComponent(id) + '/status', { method: 'PATCH', body: { status } });
      if (data.unreadCount != null) setBadge(data.unreadCount);
      if (status === 'unread') PW.toast(t('admin.support.saved'), 'info');
      else if (data.emailed) PW.toast(t('admin.support.mailSent'), 'success');
      else if (data.mailAlready) PW.toast(t('admin.support.mailAlready'), 'info');
      else if (data.hadEmail) PW.toast(t('admin.support.mailNotSent'), 'error');
      else PW.toast(t('admin.support.savedNoMail'), 'info');
      if (!viewModal.classList.contains('hidden') && openTicket?.ticket._id === id) await openView(id);
      await loadTickets();
    } catch (e) {
      PW.toast(e.message || t('admin.error'), 'error');
    }
  }

  function onAction(e) {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const { act, id } = b.dataset;
    if (act === 'view') openView(id);
    else if (act === 'reply') openReply(id);
    else setStatus(id, act);
  }

  listEl?.addEventListener('click', onAction);
  document.getElementById('ticketViewActions')?.addEventListener('click', onAction);
  document.getElementById('replySendBtn')?.addEventListener('click', sendReply);

  // закрытие окон: крестик/«Отмена» с data-close и клик по фону
  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => document.getElementById(el.dataset.close)?.classList.add('hidden'));
  });
  [viewModal, replyModal].forEach((m) => m?.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

  document.querySelectorAll('.support-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.support-tab').forEach((x) => x.classList.remove('active'));
      tab.classList.add('active');
      currentStatus = tab.dataset.status;
      currentQuery = '';
      if (searchEl) searchEl.value = '';
      loadTickets();
    });
  });

  // поиск по номеру: «123» или «#123»; пустое поле — снова вкладка
  searchEl?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentQuery = searchEl.value.trim().replace(/^#/, '').replace(/\D/g, '');
      document.querySelectorAll('.support-tab').forEach((x) => x.classList.toggle('active', !currentQuery && x.dataset.status === currentStatus));
      loadTickets();
    }, 300);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!replyModal.classList.contains('hidden')) replyModal.classList.add('hidden');
    else if (!viewModal.classList.contains('hidden')) viewModal.classList.add('hidden');
  });

  refreshCount();
  // список не перерисовываем, пока открыто окно просмотра/ответа — иначе пропадёт выделение и ввод
  setInterval(() => {
    refreshCount();
    const busy = !viewModal.classList.contains('hidden') || !replyModal.classList.contains('hidden');
    if (!overlay.classList.contains('hidden') && !busy) loadTickets();
  }, 5000);

  // socket (если доступен на этом origin)
  try {
    if (typeof io === 'function') {
      const socket = io({ withCredentials: true });
      socket.on('support:count', (p) => setBadge(p.unreadCount));
      socket.on('support:new', () => {
        refreshCount();
        if (!overlay.classList.contains('hidden') && currentStatus === 'unread' && !currentQuery) loadTickets();
      });
      socket.on('support:updated', () => {
        refreshCount();
        if (!overlay.classList.contains('hidden')) loadTickets();
      });
    }
  } catch (_) {}
})();

document.getElementById('commitList').addEventListener('change', (e) => {
  if (e.target.name === 'commit') selectCommit(e.target.value);
});

loadCommits();