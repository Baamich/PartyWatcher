const $ = (id) => document.getElementById(id);

const st = { type: 'all', sort: 'likes', q: '', page: 1 };
const known = new Map(); // id → единый объект пре-сета (одинаковый в списке и в «Ваши»)
let listToken = 0;
let searchTimer = null;

function remember(it) {
  const o = known.get(it.id);
  if (o) { Object.assign(o, it); return o; }
  known.set(it.id, it);
  return it;
}

function makeCard(item) {
  return PWPresets.buildCard(item, {
    onLike,
    onAdd,
    onTrash: (it) => PWPresets.trash(it, (kind) => afterRemove(it, kind)),
  });
}

// перерисовываем все карточки этого пре-сета (и в списке, и в «Ваши»)
function paint(id) {
  const it = known.get(id);
  if (!it) return;
  document.querySelectorAll(`.pst-card[data-id="${id}"]`).forEach((c) => c.replaceWith(makeCard(it)));
}

function checkEmpty() {
  $('pstEmpty').classList.toggle('hidden', $('pstList').children.length > 0);
}

// ---------- списки ----------

async function loadList(reset) {
  const tk = ++listToken;
  if (reset) st.page = 1;
  const qs = `?sort=${st.sort}&page=${st.page}` +
    (st.type !== 'all' ? '&type=' + st.type : '') +
    (st.q ? '&q=' + encodeURIComponent(st.q) : '');
  $('pstMore').disabled = true;
  try {
    const r = await api('/presets' + qs);
    if (tk !== listToken) return; // за это время фильтры уже поменялись
    const box = $('pstList');
    if (reset) box.replaceChildren();
    r.items.map(remember).forEach((it) => box.appendChild(makeCard(it)));
    $('pstMore').classList.toggle('hidden', !r.hasMore);
    checkEmpty();
  } catch (e) {
    if (tk === listToken) PW.toast(e.message || t('presets.loadFailed'), 'error');
  } finally {
    if (tk === listToken) $('pstMore').disabled = false;
  }
}

async function loadMine() {
  try {
    const r = await api('/presets/mine');
    const all = [...r.published, ...r.added].map(remember);
    const box = $('pstMine');
    box.replaceChildren();
    all.forEach((it) => box.appendChild(makeCard(it)));
    $('pstMineEmpty').classList.toggle('hidden', all.length > 0);
  } catch (e) {
    PW.toast(e.message || t('presets.loadMineFailed'), 'error');
  }
}

// ---------- действия ----------

async function onLike(item) {
  try {
    const r = await api(`/presets/${item.id}/like`, { method: 'PUT', body: { on: !item.liked } });
    item.liked = r.liked;
    item.likes = r.likes;
    paint(item.id);
  } catch (e) {
    PW.toast(e.message || t('presets.likeFailed'), 'error');
  }
}

async function onAdd(item) {
  if (item.added) return PWPresets.unaddItem(item, (k) => afterRemove(item, k));

  try {
    if (item.type === 'style') {
      const ok = await PW.confirm(t('presets.addStyle.text', { name: item.name }),
        { title: t('presets.addStyle.title'), okText: t('presets.addOk') });
      if (!ok) return;
      const r = await api(`/presets/${item.id}/add`, { method: 'POST', body: {} });
      PWPresets.applyStyle(r.data);
      item.added = true;
      item.adds = r.adds ?? item.adds + 1;
      PW.toast(t('presets.addStyle.done'), 'success');
    } else {
      let name = item.data.name;
      let existing = [];
      try { existing = (await api('/workbench/commands')).map((c) => c.name); } catch (_) {}
      if (existing.includes(name)) {
        const v = await PW.prompt(t('presets.cmdTaken.text', { name }),
          { title: t('presets.cmdTaken.title'), defaultValue: name + '2', okText: t('presets.addOk') });
        if (!v) return;
        name = String(v).trim().replace(/^!+/, '').toLowerCase();
      }
      const r = await api(`/presets/${item.id}/add`, { method: 'POST', body: { name } });
      item.added = true;
      item.adds = r.adds ?? item.adds + 1;
      PW.toast(t('presets.cmdAdded', { name }), 'success');
    }
    paint(item.id);
    loadMine();
  } catch (e) {
    PW.toast(e.message || t('presets.addFailed'), 'error');
  }
}

function afterRemove(item, kind) {
  if (kind === 'deleted') {
    known.delete(item.id);
    document.querySelectorAll(`.pst-card[data-id="${item.id}"]`).forEach((c) => c.remove());
    checkEmpty();
  } else {
    item.added = false;
    item.adds = Math.max(0, item.adds - 1);
    paint(item.id);
  }
  loadMine();
}

function openPublishPreset() {
  PWPresets.openPublish({ onDone: () => { loadList(true); loadMine(); } });
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

// ---------- старт ----------

async function init() {
  try {
    const me = await api('/auth/me');
    if (!me.streamerName) { location.href = '/streamers/edit.html'; return; }
  } catch {
    location.href = '/';
    return;
  }

  $('pstType').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    st.type = b.dataset.type;
    $('pstType').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    loadList(true);
  });
  $('pstSort').addEventListener('change', () => { st.sort = $('pstSort').value; loadList(true); });
  $('pstSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { st.q = $('pstSearch').value.trim(); loadList(true); }, 300);
  });
  $('pstMore').addEventListener('click', () => { st.page += 1; loadList(false); });

  loadList(true);
  loadMine();
}

init();