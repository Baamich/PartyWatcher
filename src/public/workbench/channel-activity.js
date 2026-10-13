// Студия → 🛡️ Актив канала: модераторы (назначить, уровень, снять), их права, заблокированные, подписчики
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtDate = (d) => new Date(d).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' });

function emptyNote(box, key) {
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'act-empty';
  p.textContent = t(key);
  box.appendChild(p);
}
function errorNote(box, err) {
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'act-error';
  p.textContent = err.message || t('common.requestFailed');
  box.appendChild(p);
}

// строка списка: значок/аватар, имя, подпись, справа — элементы управления
function row(name, sub, right, badgeLevel) {
  const r = document.createElement('div');
  r.className = 'act-row';
  r.innerHTML = `
    <span class="act-ava">${badgeLevel ? PWBadges.html(badgeLevel) : escapeHtml(String(name).charAt(0).toUpperCase())}</span>
    <span class="act-row-text"><b title="${escapeHtml(name)}">${escapeHtml(name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>`;
  const ctl = document.createElement('span');
  ctl.className = 'act-row-ctl';
  right.forEach((el) => ctl.appendChild(el));
  r.appendChild(ctl);
  return r;
}

// ---------- модераторы и права ----------
let modsData = null;

function renderMods() {
  const box = document.getElementById('modsList');
  if (!modsData) return;
  document.getElementById('modsCount').textContent = `${modsData.mods.length}/${modsData.max}`;
  if (!modsData.mods.length) return emptyNote(box, 'activity.mods.empty');
  box.innerHTML = '';
  for (const m of modsData.mods) {
    const sel = document.createElement('select');
    sel.className = 'act-level';
    for (const lv of ['mod', 'senior']) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = t(lv === 'mod' ? 'activity.mods.levelMod' : 'activity.mods.levelSenior');
      sel.appendChild(o);
    }
    sel.value = m.level;
    sel.addEventListener('change', async () => {
      try {
        await api('/workbench/mods/' + m.userId, { method: 'PATCH', body: { level: sel.value } });
        m.level = sel.value;
        renderMods();
      } catch (err) {
        PW.toast(err.message, 'error');
        sel.value = m.level;
      }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn act-del';
    del.textContent = '✕';
    del.title = t('activity.mods.remove');
    del.addEventListener('click', async () => {
      const ok = await PW.confirm(t('activity.mods.removeConfirm', { name: m.username }), { danger: true, okText: t('activity.mods.remove') });
      if (!ok) return;
      try {
        await api('/workbench/mods/' + m.userId, { method: 'DELETE' });
        modsData.mods = modsData.mods.filter((x) => x.userId !== m.userId);
        renderMods();
      } catch (err) {
        PW.toast(err.message, 'error');
      }
    });
    box.appendChild(row(m.username, t('activity.mods.since', { date: fmtDate(m.addedAt) }), [sel, del], m.level));
  }
}

let permsSaveTimer = null;
function savePerms() {
  clearTimeout(permsSaveTimer);
  permsSaveTimer = setTimeout(async () => {
    try {
      const r = await api('/workbench/mod-perms', { method: 'PUT', body: modsData.perms });
      modsData.perms = r.perms;
      PW.toast(t('common.saved'), 'success');
    } catch (err) {
      PW.toast(err.message, 'error');
    }
    renderPerms();
  }, 300);
}

function renderPerms() {
  const box = document.getElementById('permsTable');
  if (!modsData) return;
  const { chat, stream } = modsData.catalog;
  const table = document.createElement('table');
  table.className = 'act-perm-table';
  table.innerHTML = `<thead><tr><th></th>
    <th>${PWBadges.html('mod')}<span>${escapeHtml(t('activity.mods.levelMod'))}</span></th>
    <th>${PWBadges.html('senior')}<span>${escapeHtml(t('activity.mods.levelSenior'))}</span></th></tr></thead>`;
  const tbody = document.createElement('tbody');
  const group = (key) => {
    const tr = document.createElement('tr');
    tr.className = 'act-perm-group';
    tr.innerHTML = `<td colspan="3">${escapeHtml(t(key))}</td>`;
    tbody.appendChild(tr);
  };
  const line = (perm, streamOnly) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = t('activity.perm.' + perm);
    tr.appendChild(name);
    for (const lv of ['mod', 'senior']) {
      const td = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      if (lv === 'mod' && streamOnly) {
        // управление эфиром — только высшему: галочку у обычного модератора не дать
        cb.disabled = true;
        td.title = t('activity.perms.seniorOnly');
        td.className = 'act-locked';
      } else {
        cb.checked = modsData.perms[lv].includes(perm);
        cb.addEventListener('change', () => {
          const set = new Set(modsData.perms[lv]);
          if (cb.checked) set.add(perm); else set.delete(perm);
          modsData.perms[lv] = [...set];
          savePerms();
        });
      }
      td.appendChild(cb);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  };
  group('activity.perms.chat');
  chat.forEach((p) => line(p, false));
  group('activity.perms.stream');
  stream.forEach((p) => line(p, true));
  table.appendChild(tbody);
  box.replaceChildren(table);
}

async function loadMods() {
  try {
    modsData = await api('/workbench/mods');
    renderMods();
    renderPerms();
  } catch (err) {
    errorNote(document.getElementById('modsList'), err);
  }
}

document.getElementById('modAddForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('modAddName');
  const username = input.value.trim();
  if (!username) return;
  try {
    const m = await api('/workbench/mods', { method: 'POST', body: { username, level: document.getElementById('modAddLevel').value } });
    modsData.mods = modsData.mods.filter((x) => x.userId !== m.userId).concat({ ...m, addedAt: new Date().toISOString() });
    input.value = '';
    renderMods();
    PW.toast(t('activity.mods.added', { name: m.username }), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});

// ---------- заблокированные ----------
async function loadBans() {
  const box = document.getElementById('bansList');
  try {
    const bans = await api('/workbench/bans');
    document.getElementById('bansCount').textContent = bans.length ? String(bans.length) : '';
    if (!bans.length) return emptyNote(box, 'activity.noBans');
    box.innerHTML = '';
    for (const b of bans) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-btn';
      btn.textContent = t('activity.unban');
      const r = row(b.username, b.bannedAt ? fmtDate(b.bannedAt) : '', [btn]);
      btn.addEventListener('click', async () => {
        try {
          await api('/workbench/bans/' + encodeURIComponent(b.userId), { method: 'DELETE' });
          r.remove();
          if (!box.children.length) emptyNote(box, 'activity.noBans');
        } catch (err) {
          PW.toast(err.message || t('activity.unbanFailed'), 'error');
        }
      });
      box.appendChild(r);
    }
  } catch (err) {
    errorNote(box, err);
  }
}

// ---------- подписчики: число и последние 100 ----------
let followersData = null;

function renderFollowers() {
  const box = document.getElementById('followersBox');
  if (!box || !followersData) return;
  document.getElementById('subsCount').textContent = followersData.count ? t('activity.subsCount', { n: followersData.count }) : '';
  if (!followersData.list.length) return emptyNote(box, 'activity.noSubs');
  box.innerHTML = '';
  for (const f of followersData.list) box.appendChild(row(f.username, fmtDate(f.at), []));
}

async function loadFollowers() {
  try {
    followersData = await api('/workbench/followers');
    renderFollowers();
  } catch (err) {
    errorNote(document.getElementById('followersBox'), err);
  }
}

window.addEventListener('pw:langchange', () => { renderMods(); renderPerms(); renderFollowers(); loadBans(); });

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

loadMods();
loadBans();
loadFollowers();
