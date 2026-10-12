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

// подписчики: общее число и последние 100 (дата — на языке страницы, поэтому перерисовка при смене языка)
let followersData = null;

function renderFollowers() {
  const box = document.getElementById('followersBox');
  if (!box || !followersData) return;
  box.innerHTML = '';
  const head = document.createElement('p');
  head.style.cssText = 'color:var(--text-muted); font-size:14px;';
  head.textContent = followersData.count ? t('activity.subsCount', { n: followersData.count }) : t('activity.noSubs');
  box.appendChild(head);
  if (!followersData.list.length) return;

  const list = document.createElement('div');
  list.className = 'ban-list';
  list.setAttribute('data-no-i18n', '');
  for (const f of followersData.list) {
    const row = document.createElement('div');
    row.className = 'ban-row';
    const name = document.createElement('span');
    name.className = 'ban-name';
    name.textContent = f.username;
    name.title = f.username;
    const at = document.createElement('span');
    at.style.cssText = 'color:var(--text-muted); font-size:12px; white-space:nowrap;';
    at.textContent = new Date(f.at).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' });
    row.append(name, at);
    list.appendChild(row);
  }
  box.appendChild(list);
}

async function loadFollowers() {
  const box = document.getElementById('followersBox');
  try {
    followersData = await api('/workbench/followers');
    renderFollowers();
  } catch (err) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--danger); font-size:14px;';
    p.textContent = err.message || t('activity.subsFailed');
    box.appendChild(p);
  }
}

window.addEventListener('pw:langchange', renderFollowers);

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
loadFollowers();
