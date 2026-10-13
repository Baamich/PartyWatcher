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

// ---------- поиск человека при назначении ----------
// от 2 символов — аккаунты, у которых логин или имя стримера начинается с введённого; выбор подставляет логин
// (назначает сервер по логину) и показывает над списком, кого именно назначаешь
const modFind = { items: [], sel: -1, timer: null, token: 0, picked: null };

function findAvaHtml(u) {
  const letter = escapeHtml(String(u.streamerName || u.username).charAt(0).toUpperCase());
  return `<span class="act-find-ava">${u.avatarUrl ? `<img src="${escapeHtml(u.avatarUrl)}" alt="" loading="lazy" />` : letter}</span>`;
}
// подсветить начало, которое совпало с запросом
function markStart(text, q) {
  const s = String(text || '');
  if (q && s.toLowerCase().startsWith(q)) return `<mark>${escapeHtml(s.slice(0, q.length))}</mark>${escapeHtml(s.slice(q.length))}`;
  return escapeHtml(s);
}
// «Имя стримера» и «@логин» (если они разные) — чтобы было видно, кого назначаешь
function findTextHtml(u, q) {
  const title = u.streamerName || u.username;
  const showLogin = !u.streamerName || u.streamerName.toLowerCase() !== u.username.toLowerCase();
  return `<span class="act-find-text"><b>${markStart(title, q)}</b>${showLogin && u.streamerName ? `<small>@${markStart(u.username, q)}</small>` : `<small>${escapeHtml(t(u.streamerName ? 'activity.mods.findStreamer' : 'activity.mods.findViewer'))}</small>`}</span>`;
}
function findTagHtml(u) {
  if (u.level) return `<span class="act-find-tag">${escapeHtml(t(u.level === 'senior' ? 'activity.mods.findSenior' : 'activity.mods.findMod'))}</span>`;
  if (u.follower) return `<span class="act-find-tag fol">❤ ${escapeHtml(t('activity.mods.findFollower'))}</span>`;
  return '';
}

function closeFind() {
  const list = document.getElementById('modFindList');
  list.hidden = true;
  document.getElementById('modAddName').setAttribute('aria-expanded', 'false');
  modFind.items = [];
  modFind.sel = -1;
}

function drawFind(q) {
  const list = document.getElementById('modFindList');
  list.innerHTML = '';
  if (!modFind.items.length) {
    const p = document.createElement('p');
    p.className = 'act-find-empty';
    p.textContent = t('activity.mods.findEmpty');
    list.appendChild(p);
  }
  modFind.items.forEach((u, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('role', 'option');
    b.className = 'act-find-row' + (i === modFind.sel ? ' on' : '');
    b.innerHTML = findAvaHtml(u) + findTextHtml(u, q) + findTagHtml(u);
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickFind(u); }); // mousedown — поле не теряет фокус
    list.appendChild(b);
  });
  list.hidden = false;
  document.getElementById('modAddName').setAttribute('aria-expanded', 'true');
  list.querySelector('.act-find-row.on')?.scrollIntoView({ block: 'nearest' });
}

function renderPicked() {
  const box = document.getElementById('modPicked');
  const u = modFind.picked;
  box.hidden = !u;
  if (!u) return;
  box.innerHTML = `<span class="act-picked-lbl">${escapeHtml(t('activity.mods.picked'))}</span>${findAvaHtml(u)}${findTextHtml(u, '')}${findTagHtml(u)}
    <button type="button" class="act-picked-x" title="${escapeHtml(t('common.close'))}">×</button>`;
  box.querySelector('.act-picked-x').addEventListener('click', () => {
    modFind.picked = null;
    const input = document.getElementById('modAddName');
    input.value = '';
    renderPicked();
    input.focus();
  });
}

function pickFind(u) {
  modFind.picked = u;
  document.getElementById('modAddName').value = u.username;
  closeFind();
  renderPicked();
  document.getElementById('modAddLevel').focus();
}

async function runFind() {
  const input = document.getElementById('modAddName');
  const q = input.value.trim().replace(/^@/, '').toLowerCase();
  if (q.length < 2) return closeFind();
  const tk = ++modFind.token;
  try {
    const r = await api('/workbench/mods/search?q=' + encodeURIComponent(q));
    if (tk !== modFind.token || document.activeElement !== input) return; // за это время уже ввели другое
    modFind.items = r.users || [];
    modFind.sel = modFind.items.length ? 0 : -1;
    drawFind(q);
  } catch (_) {
    closeFind();
  }
}

(function initModFind() {
  const input = document.getElementById('modAddName');
  if (!input) return;
  input.addEventListener('input', () => {
    // правка поля вручную — выбранный человек больше не тот
    if (modFind.picked && input.value.trim().toLowerCase() !== modFind.picked.username.toLowerCase()) {
      modFind.picked = null;
      renderPicked();
    }
    clearTimeout(modFind.timer);
    modFind.timer = setTimeout(runFind, 200);
  });
  input.addEventListener('focus', () => { if (!modFind.picked && input.value.trim().length >= 2) runFind(); });
  input.addEventListener('blur', () => setTimeout(closeFind, 120));
  input.addEventListener('keydown', (e) => {
    const list = document.getElementById('modFindList');
    if (list.hidden || !modFind.items.length) return;
    const q = input.value.trim().replace(/^@/, '').toLowerCase();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      modFind.sel = (modFind.sel + (e.key === 'ArrowDown' ? 1 : -1) + modFind.items.length) % modFind.items.length;
      drawFind(q);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (modFind.sel < 0) return;
      e.preventDefault(); // Enter выбирает из списка, а не отправляет форму
      pickFind(modFind.items[modFind.sel]);
    } else if (e.key === 'Escape') {
      closeFind();
    }
  });
  window.addEventListener('pw:langchange', renderPicked);
})();

document.getElementById('modAddForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('modAddName');
  const username = input.value.trim().replace(/^@/, '');
  if (!username) return;
  closeFind();
  try {
    const m = await api('/workbench/mods', { method: 'POST', body: { username, level: document.getElementById('modAddLevel').value } });
    modsData.mods = modsData.mods.filter((x) => x.userId !== m.userId).concat({ ...m, addedAt: new Date().toISOString() });
    input.value = '';
    modFind.picked = null;
    renderPicked();
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
