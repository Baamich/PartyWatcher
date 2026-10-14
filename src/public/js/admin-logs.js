// 📜 Логи сервера (GET /api/admin/logs): быстрые группы, уровень, процесс, период, тег, поиск, порядок; авто-обновление 10 с
(function () {
  const modal = document.getElementById('logsModal');
  if (!modal) return;
  const $ = (id) => document.getElementById(id);
  const list = $('logsList');
  const info = $('logsInfo');
  const state = { group: '', level: 'all', proc: 'all', since: '60', tag: '', order: 'desc', q: '' };
  let autoTimer = null;
  let qTimer = null;
  let loading = false;

  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // время в логах — UTC «2026-10-14 10:49:25», показываем в часовом поясе админа
  const fmtTime = (t) => new Date(t.replace(' ', 'T') + 'Z').toLocaleString(I18N.locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function row(e) {
    const el = node('div', 'pwa-log pwa-log-' + e.lv.toLowerCase());
    const head = node('div', 'pwa-log-head');
    head.append(node('span', 'pwa-log-time', e.t ? fmtTime(e.t) : t('admin.logs.noTime')), node('span', 'pwa-log-lv', e.lv),
      node('span', 'pwa-log-proc', t('admin.logs.proc.' + e.proc)));
    let msg = e.msg;
    if (e.tag) {
      const b = node('button', 'pwa-log-tag', e.tag);
      b.type = 'button';
      b.title = t('admin.logs.byTag');
      b.addEventListener('click', () => { state.tag = e.tag; load(); });
      head.append(b);
      msg = msg.slice(e.tag.length + 2).trim();
    }
    el.append(head, node('pre', 'pwa-log-msg', msg));
    return el;
  }

  async function load() {
    if (loading) return;
    loading = true;
    const p = new URLSearchParams(Object.entries(state).filter(([, v]) => v !== ''));
    let r;
    try {
      r = await api('/admin/logs?' + p);
    } catch (e) {
      info.textContent = e.message;
      loading = false;
      return;
    }
    loading = false;
    const sel = $('logsTag');
    sel.replaceChildren(new Option(t('admin.logs.allTags'), ''), ...r.tags.map((x) => new Option(`${x.name} (${x.n})`, x.name)));
    if (state.tag && !r.tags.some((x) => x.name === state.tag)) sel.append(new Option(state.tag, state.tag));
    sel.value = state.tag;
    info.textContent = r.files ? t('admin.logs.count', { n: r.items.length, total: r.total }) : t('admin.logs.noFiles');
    list.replaceChildren(...(r.items.length ? r.items.map(row) : [node('p', 'pwa-empty', t('admin.logs.empty'))]));
  }

  // быстрые группы
  $('logsGroups').addEventListener('click', (e) => {
    const b = e.target.closest('[data-group]');
    if (!b) return;
    state.group = b.dataset.group;
    state.tag = '';
    $('logsGroups').querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('on', x === b));
    load();
  });
  for (const [id, key] of [['logsLevel', 'level'], ['logsProc', 'proc'], ['logsSince', 'since'], ['logsTag', 'tag'], ['logsOrder', 'order']]) {
    $(id).addEventListener('change', (e) => { state[key] = e.target.value; load(); });
  }
  $('logsQ').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 300);
  });
  $('logsReload').addEventListener('click', load);
  $('logsAuto').addEventListener('change', (e) => {
    clearInterval(autoTimer);
    autoTimer = e.target.checked ? setInterval(() => { if (!modal.classList.contains('hidden') && !document.hidden) load(); }, 10000) : null;
  });

  window.openLogs = () => {
    modal.classList.remove('hidden');
    load();
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  window.addEventListener('pw:langchange', () => { if (!modal.classList.contains('hidden')) load(); });
})();
