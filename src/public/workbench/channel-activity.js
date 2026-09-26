function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function unbanUser(userId, row) {
  try {
    await api('/workbench/bans/' + encodeURIComponent(userId), { method: 'DELETE' });
    row.remove();
  } catch (err) {
    alert(err.message || 'Не удалось разблокировать');
  }
}

async function loadBans() {
  const box = document.getElementById('bansList');
  try {
    const bans = await api('/workbench/bans');
    if (!bans.length) {
      box.innerHTML = '<p style="color:var(--text-muted); font-size:14px;">Заблокированных нет</p>';
      return;
    }
    box.innerHTML = '';
    bans.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      row.innerHTML = `<span>${escapeHtml(b.username)}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Разблокировать';
      btn.onclick = () => unbanUser(b.userId, row);
      row.appendChild(btn);
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<p style="color:var(--danger); font-size:14px;">${err.message}</p>`;
  }
}

loadBans();