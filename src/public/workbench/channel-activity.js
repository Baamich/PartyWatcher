function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function unbanUser(userId, row) {
  try {
    await api('/workbench/bans/' + encodeURIComponent(userId), { method: 'DELETE' });
    row.remove();
  } catch (err) {
    PW.toast(err.message || t('activity.unbanFailed'), 'error');
  }
}

async function loadBans() {
  const box = document.getElementById('bansList');
  try {
    const bans = await api('/workbench/bans');
    if (!bans.length) {
      box.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${t('activity.noBans')}</p>`;
      return;
    }
    box.innerHTML = '';
    box.className = 'ban-list';
    bans.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'ban-row';

      const name = document.createElement('span');
      name.className = 'ban-name';
      name.textContent = b.username;
      name.title = b.username;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-btn';
      btn.textContent = t('activity.unban');
      btn.onclick = () => unbanUser(b.userId, row);

      row.append(name, btn);
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<p style="color:var(--danger); font-size:14px;">${escapeHtml(err.message)}</p>`;
  }
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
    location.href = '/';
  }
}

loadBans();