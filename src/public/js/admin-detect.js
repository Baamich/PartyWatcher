// Админка → 🕵️ Обнаружение: разные аккаунты с одного IP, браузера или железа (GET /api/admin/detect).
// Красный кружок с числом на кнопке меню — сколько совпадений не просмотрено/не проигнорировано (раз в минуту).
// «Проверить» — аккаунты совпадения с переходом в их карточку, «Игнорировать» — скрыть, пока не появится новый аккаунт
(function () {
  const $ = (id) => document.getElementById(id);
  const modal = $('detectModal');
  const listEl = $('detectList');
  const badge = $('detectBadge');
  if (!modal) return;

  const fmt = (d) => (d ? new Date(d).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' }) : '—');
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

  function setBadge(n) {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', !n);
  }
  async function refreshCount() {
    try {
      setBadge((await api('/admin/detect/count')).count || 0);
    } catch (_) {}
  }

  function card(x) {
    const box = node('div', 'pwa-detect');
    const head = node('div', 'pwa-detect-head');
    head.appendChild(node('span', 'pwa-detect-kind', t('admin.detect.kind.' + x.kind)));
    head.appendChild(node('span', 'pwa-mono', x.value));
    if (x.banned) head.appendChild(node('span', 'pwa-badge pwa-badge-ban', t('admin.detect.alreadyBanned')));
    box.appendChild(head);

    const meta = [t('admin.detect.accounts', { n: x.users.length }), t('admin.detect.last', { d: fmt(x.lastAt) })];
    if (x.name && x.kind !== 'ip') meta.push(x.name);
    if (x.country) meta.push(x.country);
    box.appendChild(node('div', 'pwa-user-sub', meta.join(' · ')));

    const chips = node('div', 'pwa-detect-chips');
    for (const u of x.users) {
      const chip = node('span', 'pwa-badge ' + (u.banned ? 'pwa-badge-ban' : u.role === 'admin' || u.role === 'owner' ? 'pwa-badge-admin' : 'pwa-badge-ok'), u.username);
      chips.appendChild(chip);
    }
    box.appendChild(chips);

    // «Проверить»: аккаунты совпадения — последний заход и переход в карточку (как в 👥 Аккаунты)
    const details = node('div', 'pwa-detect-details hidden');
    const table = node('table', 'pwa-table');
    const tbody = node('tbody');
    for (const u of x.users) {
      const tr = node('tr');
      tr.append(node('td', 'pwa-user-name', u.username), node('td', '', fmt(u.lastSeenAt)));
      const td = node('td');
      td.appendChild(btn(t('admin.detect.open'), 'pwa-small', () => window.openUserCard && window.openUserCard(u.id)));
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    details.appendChild(table);

    const row = node('div', 'pwa-actions-row');
    const check = btn(t('admin.detect.check'), 'pwa-small', () => {
      const open = details.classList.toggle('hidden') === false;
      check.textContent = open ? t('admin.detect.hide') : t('admin.detect.check');
    });
    const ignore = btn(t('admin.detect.ignore'), 'pwa-small', async () => {
      ignore.disabled = true;
      try {
        await api('/admin/detect/ignore', { method: 'POST', body: { kind: x.kind, value: x.value, users: x.users.map((u) => u.id) } });
        box.remove();
        if (!listEl.children.length) listEl.appendChild(node('p', 'pwa-empty', t('admin.detect.empty')));
        refreshCount();
      } catch (e) {
        PW.toast(e.message, 'error');
        ignore.disabled = false;
      }
    });
    row.append(check, ignore);
    box.append(row, details);
    return box;
  }

  async function load(fresh) {
    listEl.innerHTML = '';
    listEl.appendChild(node('p', 'pwa-empty', t('common.loading')));
    let r;
    try {
      r = await api('/admin/detect' + (fresh ? '?fresh=1' : ''));
    } catch (e) {
      listEl.innerHTML = '';
      PW.toast(e.message, 'error');
      return;
    }
    listEl.innerHTML = '';
    setBadge(r.items.length);
    if (!r.items.length) {
      listEl.appendChild(node('p', 'pwa-empty', t('admin.detect.empty')));
      return;
    }
    for (const x of r.items) listEl.appendChild(card(x));
  }

  window.openDetect = () => {
    modal.classList.remove('hidden');
    load(true);
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  window.addEventListener('pw:langchange', () => { if (!modal.classList.contains('hidden')) load(false); });

  refreshCount();
  setInterval(() => { if (!document.hidden) refreshCount(); }, 60 * 1000);
})();
