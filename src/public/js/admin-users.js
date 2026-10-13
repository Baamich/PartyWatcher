// Админка → 👥 Аккаунты (список: новые сверху, сортировка, поиск по логину/почте/каналу/IP, фильтр),
// карточка аккаунта (IP и устройства, с которых заходил) и действия: заблокировать на срок, забанить навсегда,
// бан IP, бан устройства (браузер + отпечаток железа). 🛡️ Баны — список банов IP/устройств со снятием
(function () {
  const $ = (id) => document.getElementById(id);
  const usersModal = $('usersModal');
  const userModal = $('userModal');
  const bansModal = $('bansModal');
  if (!usersModal) return;

  const st = { q: '', sort: 'new', filter: 'all', page: 1, pages: 1, loading: false };
  let openId = null;

  const fmt = (d) => (d ? new Date(d).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' }) : '—');
  function ago(d) {
    if (!d) return t('admin.users.never');
    const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (m < 2) return t('admin.users.now');
    if (m < 60) return t('admin.stats.dur.m', { n: m }) + ' ' + t('admin.users.ago');
    if (m < 1440) return t('admin.stats.dur.h', { n: Math.round(m / 60) }) + ' ' + t('admin.users.ago');
    return fmt(d);
  }
  function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, cls, onClick) {
    const b = node('button', 'icon-btn ' + (cls || ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function statusOf(u) {
    if (u.verifyPending) return { cls: 'pwa-badge-block', text: t('admin.users.pending', { d: fmt(u.verifyExpires) }) };
    if (u.banPerm) return { cls: 'pwa-badge-ban', text: t('admin.users.banned') };
    if (u.banUntil) return { cls: 'pwa-badge-block', text: t('admin.users.blockedUntil', { d: fmt(u.banUntil) }) };
    if (u.role === 'admin') return { cls: 'pwa-badge-admin', text: t('admin.users.admin') };
    if (u.role === 'friend') return { cls: 'pwa-badge-admin', text: t('admin.users.friend') };
    if (!u.termsOk) return { cls: 'pwa-badge-muted', text: t('admin.users.noTerms') };
    return { cls: 'pwa-badge-ok', text: t('admin.users.active') };
  }

  // ---------- список ----------
  async function loadUsers(append) {
    if (st.loading) return;
    st.loading = true;
    const body = $('usersBody');
    if (!append) {
      st.page = 1;
      body.innerHTML = '';
      const tr = node('tr');
      tr.appendChild(Object.assign(node('td', 'pwa-empty', t('common.loading')), { colSpan: 5 }));
      body.appendChild(tr);
    }
    try {
      const qs = new URLSearchParams({ sort: st.sort, filter: st.filter, page: String(st.page) });
      if (st.q) qs.set('q', st.q);
      const r = await api('/admin/users?' + qs);
      st.pages = r.pages;
      if (!append) body.innerHTML = '';
      $('usersTotal').textContent = t('admin.users.total', { n: r.total });
      if (!r.users.length && !append) {
        const tr = node('tr');
        tr.appendChild(Object.assign(node('td', 'pwa-empty', t('admin.users.empty')), { colSpan: 5 }));
        body.appendChild(tr);
      }
      for (const u of r.users) body.appendChild(userRow(u));
      $('usersMore').classList.toggle('hidden', st.page >= st.pages);
    } catch (e) {
      body.innerHTML = '';
      PW.toast(e.message, 'error');
    } finally {
      st.loading = false;
    }
  }

  function userRow(u) {
    const tr = node('tr', 'pwa-row-click');
    const c1 = node('td');
    c1.appendChild(node('div', 'pwa-user-name', u.username));
    c1.appendChild(node('div', 'pwa-user-sub', u.email));
    const s = statusOf(u);
    const badge = node('span', 'pwa-badge ' + s.cls, s.text);
    const c5 = node('td');
    c5.appendChild(badge);
    tr.append(c1, node('td', '', fmt(u.createdAt)), node('td', '', ago(u.lastSeenAt)), node('td', 'pwa-mono', u.lastIp || u.regIp || '—'), c5);
    tr.addEventListener('click', () => openUser(u.id));
    return tr;
  }

  let searchTimer = null;
  $('usersSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { st.q = $('usersSearch').value.trim(); loadUsers(false); }, 300);
  });
  $('usersSort').addEventListener('change', () => { st.sort = $('usersSort').value; loadUsers(false); });
  $('usersFilter').addEventListener('change', () => { st.filter = $('usersFilter').value; loadUsers(false); });
  $('usersMore').addEventListener('click', () => { st.page += 1; loadUsers(true); });

  window.openUsers = (opts = {}) => {
    if (opts.sort) st.sort = opts.sort;
    if (opts.filter) st.filter = opts.filter;
    st.q = opts.q != null ? String(opts.q) : opts.sort || opts.filter ? '' : st.q;
    $('usersSort').value = st.sort;
    $('usersFilter').value = st.filter;
    $('usersSearch').value = st.q;
    usersModal.classList.remove('hidden');
    loadUsers(false);
    $('usersSearch').focus();
  };

  // ---------- карточка аккаунта ----------
  async function openUser(id) {
    openId = id;
    const card = $('userCard');
    card.textContent = t('common.loading');
    userModal.classList.remove('hidden');
    let r;
    try {
      r = await api('/admin/users/' + encodeURIComponent(id));
    } catch (e) {
      card.textContent = e.message;
      return;
    }
    if (openId !== id) return;
    renderUser(r);
  }

  async function act(path, body, okKey) {
    try {
      const r = await api('/admin/users/' + encodeURIComponent(openId) + path, { method: 'POST', body: body || {} });
      PW.toast(t(okKey, { n: r.count || 0 }), 'success');
      openUser(openId);
      if (!usersModal.classList.contains('hidden')) loadUsers(false);
    } catch (e) {
      PW.toast(e.message, 'error');
    }
  }

  function renderUser(r) {
    const u = r.user;
    const card = $('userCard');
    card.innerHTML = '';
    card.setAttribute('data-no-i18n', '');
    const head = node('div', 'pwa-card-head');
    head.appendChild(node('h3', '', u.username));
    const s = statusOf(u);
    head.appendChild(node('span', 'pwa-badge ' + s.cls, s.text));
    card.appendChild(head);

    const info = node('dl', 'pwa-info');
    const add = (k, v) => { info.appendChild(node('dt', '', t('admin.users.f.' + k))); const dd = node('dd', '', v || '—'); info.appendChild(dd); return dd; };
    // тексты, которые вводил сам человек, — «✏️ Редактировать» превращает этот блок в форму
    const own = node('dl', 'pwa-info');
    const addOwn = (k, v) => { own.appendChild(node('dt', '', t('admin.users.f.' + k))); own.appendChild(node('dd', 'pwa-pre', v || '—')); };
    for (const f of EDIT_FIELDS) addOwn(f.k, u[f.k]);
    const ownBox = node('div', 'pwa-own');
    const ownHead = node('div', 'pwa-own-head');
    ownHead.append(node('div', 'pwa-sub', t('admin.users.ownTitle')), btn(t('admin.users.edit'), 'pwa-small', () => editOwn(ownBox, u)));
    ownBox.append(ownHead, own);
    card.appendChild(ownBox);
    add('channel', u.streamerName ? u.streamerName + (u.isLive ? ' · 🔴' : '') : '');
    add('created', fmt(u.createdAt));
    add('seen', ago(u.lastSeenAt));
    add('lastIp', u.lastIp);
    add('regIp', u.regIp);
    add('regDevice', u.regDevice);
    add('terms', u.termsOk ? t('admin.users.termsYes') : t('admin.users.termsNo'));
    if (u.banPerm || u.banUntil) {
      add('ban', (u.banPerm ? t('admin.users.banned') : t('admin.users.blockedUntil', { d: fmt(u.banUntil) })) + (u.banBy ? ' · ' + u.banBy : '') + (u.banAt ? ' · ' + fmt(u.banAt) : ''));
      add('reason', u.banReason);
    }
    card.appendChild(info);
    if (u.streamerName) {
      const a = node('a', 'pwa-link', t('admin.users.openChannel'));
      a.href = '/streamers/' + encodeURIComponent(u.streamerName.toLowerCase());
      a.target = '_blank';
      a.rel = 'noopener';
      card.appendChild(a);
    }

    // действия (админов не трогаем — сервер тоже не даст)
    if (u.role !== 'admin') {
      const box = node('div', 'pwa-actions');
      const reason = node('input');
      reason.type = 'text';
      reason.maxLength = 300;
      reason.placeholder = t('admin.users.reasonPh');
      reason.className = 'pwa-reason';
      const hours = node('select');
      for (const h of r.blockHours) {
        const o = node('option', '', h < 24 ? t('admin.stats.dur.h', { n: h }) : t('admin.stats.dur.d', { n: h / 24 }));
        o.value = String(h);
        if (h === 24) o.selected = true;
        hours.appendChild(o);
      }
      const row1 = node('div', 'pwa-actions-row');
      row1.append(
        hours,
        btn(t('admin.users.block'), '', async () => {
          if (await PW.confirm(t('admin.users.blockConfirm', { name: u.username, h: hours.selectedOptions[0].textContent }), { danger: true })) {
            act('/block', { hours: Number(hours.value), reason: reason.value }, 'admin.users.done');
          }
        }),
        btn(t('admin.users.ban'), 'pwa-danger', async () => {
          if (await PW.confirm(t('admin.users.banConfirm', { name: u.username }), { danger: true })) act('/ban', { reason: reason.value }, 'admin.users.done');
        }),
      );
      if (u.banPerm || u.banUntil) {
        row1.appendChild(btn(t('admin.users.unban'), '', () => act('/unban', {}, 'admin.users.done')));
      }
      const row2 = node('div', 'pwa-actions-row');
      row2.append(
        btn(t('admin.users.banIps'), 'pwa-danger', async () => {
          const ips = [...new Set(r.seen.map((x) => x.ip).filter(Boolean))];
          if (await PW.confirm(t('admin.users.banIpsConfirm', { n: ips.length, list: ips.slice(0, 8).join(', ') }), { danger: true })) {
            act('/ban-ip', { reason: reason.value }, 'admin.users.bannedN');
          }
        }),
        btn(t('admin.users.banDevices'), 'pwa-danger', async () => {
          const devs = r.seen.filter((x) => x.did || x.hw).length;
          if (await PW.confirm(t('admin.users.banDevicesConfirm', { n: devs }), { danger: true })) {
            act('/ban-device', { reason: reason.value }, 'admin.users.bannedN');
          }
        }),
      );
      box.append(node('div', 'pwa-sub', t('admin.users.actions')), reason, row1, row2, node('p', 'pwa-hint', t('admin.users.banHint')));
      card.appendChild(box);
    } else {
      card.appendChild(node('p', 'pwa-hint', t('admin.users.adminHint')));
    }

    // откуда заходил
    card.appendChild(node('div', 'pwa-sub', t('admin.users.seenTitle', { n: r.seen.length })));
    if (!r.seen.length) {
      card.appendChild(node('p', 'pwa-empty', t('admin.users.seenEmpty')));
      return;
    }
    const wrap = node('div', 'pwa-table-wrap');
    const table = node('table', 'pwa-table');
    const htr = node('tr');
    for (const k of ['device', 'ip', 'country', 'first', 'last', 'hits', '']) htr.appendChild(node('th', '', k ? t('admin.users.col.' + k) : ''));
    const thead = node('thead');
    thead.appendChild(htr);
    const tbody = node('tbody');
    for (const x of r.seen) {
      const tr = node('tr');
      const dev = node('td', 'pwa-td-wide', x.name || '—');
      if (x.hw) dev.title = 'did ' + (x.did || '—') + ' · hw ' + x.hw;
      const ops = node('td', 'pwa-td-ops');
      if (u.role !== 'admin') {
        if (x.ip) {
          ops.appendChild(x.banned.ip
            ? node('span', 'pwa-badge pwa-badge-ban', t('admin.users.ipBanned'))
            : btn(t('admin.users.banIp'), 'pwa-small', () => act('/ban-ip', { ip: x.ip }, 'admin.users.bannedN')));
        }
        if (x.did || x.hw) {
          ops.appendChild((x.banned.did || x.banned.hw)
            ? node('span', 'pwa-badge pwa-badge-ban', t('admin.users.devBanned'))
            : btn(t('admin.users.banDevice'), 'pwa-small', () => act('/ban-device', { did: x.did, hw: x.hw }, 'admin.users.bannedN')));
        }
      }
      tr.append(dev, node('td', 'pwa-mono', x.ip || '—'), node('td', '', x.country || ''), node('td', '', fmt(x.firstAt)), node('td', '', fmt(x.lastAt)), node('td', '', String(x.hits || 0)), ops);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
  }

  // поля, которые вводил сам человек (ограничения — как на сервере, PATCH /admin/users/:id)
  const EDIT_FIELDS = [
    { k: 'username', max: 32 },
    { k: 'email', max: 254, type: 'email' },
    { k: 'streamerBio', max: 2000, area: true },
    { k: 'streamTitle', max: 140 },
    { k: 'streamDescription', max: 2000, area: true },
    { k: 'liveNotice', max: 140 },
  ];

  // «✏️ Редактировать»: блок текстов человека становится формой, «Сохранить» шлёт только изменённые поля
  function editOwn(box, u) {
    box.innerHTML = '';
    const form = node('div', 'pwa-edit');
    const inputs = {};
    for (const f of EDIT_FIELDS) {
      const lab = node('label', 'auth-label', t('admin.users.f.' + f.k));
      const input = node(f.area ? 'textarea' : 'input');
      if (!f.area) input.type = f.type || 'text';
      else input.rows = 3;
      input.maxLength = f.max;
      input.value = u[f.k] || '';
      inputs[f.k] = input;
      form.append(lab, input);
    }
    form.appendChild(node('p', 'pwa-hint', t('admin.users.editHint')));
    const row = node('div', 'pwa-actions-row');
    const save = btn(t('common.save'), '', async () => {
      const body = {};
      for (const f of EDIT_FIELDS) if (inputs[f.k].value !== (u[f.k] || '')) body[f.k] = inputs[f.k].value;
      if (!Object.keys(body).length) return openUser(u.id);
      if (body.username && !(await PW.confirm(t('admin.users.renameConfirm', { name: body.username })))) return;
      save.disabled = true;
      try {
        await api('/admin/users/' + encodeURIComponent(u.id), { method: 'PATCH', body });
        PW.toast(t('admin.users.saved'), 'success');
        openUser(u.id);
        if (!usersModal.classList.contains('hidden')) loadUsers(false);
      } catch (e) {
        PW.toast(e.message, 'error');
        save.disabled = false;
      }
    });
    row.append(save, btn(t('common.dialog.cancel'), '', () => openUser(u.id)));
    form.appendChild(row);
    box.appendChild(form);
    inputs.username.focus();
  }

  // ---------- баны IP и устройств ----------
  async function loadBans() {
    const body = $('bansBody');
    body.innerHTML = '';
    let r;
    try {
      r = await api('/admin/bans');
    } catch (e) {
      PW.toast(e.message, 'error');
      return;
    }
    if (!r.bans.length) {
      const tr = node('tr');
      tr.appendChild(Object.assign(node('td', 'pwa-empty', t('admin.bans.empty')), { colSpan: 5 }));
      body.appendChild(tr);
      return;
    }
    for (const b of r.bans) {
      const tr = node('tr');
      const what = node('td');
      what.appendChild(node('div', '', t('admin.bans.kind.' + b.kind)));
      what.appendChild(node('div', 'pwa-mono pwa-user-sub', b.value + (b.name ? ' · ' + b.name : '')));
      const who = node('td', b.userId ? 'pwa-link' : '', b.username || '—');
      if (b.userId) who.addEventListener('click', () => openUser(b.userId));
      const ops = node('td');
      ops.appendChild(btn(t('admin.bans.remove'), 'pwa-small', async () => {
        try {
          await api('/admin/bans/' + encodeURIComponent(b.id), { method: 'DELETE' });
          PW.toast(t('admin.bans.removed'), 'success');
          loadBans();
        } catch (e) {
          PW.toast(e.message, 'error');
        }
      }));
      tr.append(what, who, node('td', '', b.reason || '—'), node('td', '', fmt(b.at) + (b.by ? ' · ' + b.by : '')), ops);
      body.appendChild(tr);
    }
  }

  window.openUserCard = (id) => openUser(id); // для 🕵️ Обнаружения

  window.openBans = () => {
    bansModal.classList.remove('hidden');
    loadBans();
  };
  window.openUpdate = () => $('updateModal')?.classList.remove('hidden');
  window.openSupport = () => $('supportAdminBtn')?.click();

  // клик по фону и Esc закрывают окна (карточка — поверх списка)
  for (const m of [usersModal, userModal, bansModal, $('updateModal'), $('detectModal')]) {
    m?.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = [userModal, usersModal, $('detectModal'), bansModal, $('updateModal')].find((m) => m && !m.classList.contains('hidden'));
    top?.classList.add('hidden');
  });
  window.addEventListener('pw:langchange', () => {
    if (!usersModal.classList.contains('hidden')) loadUsers(false);
    if (!userModal.classList.contains('hidden') && openId) openUser(openId);
    if (!bansModal.classList.contains('hidden')) loadBans();
  });
})();
