// Студия → 🎁 Награды: награды за стрим-поинты. Справа — «Создать», название и значок поинтов, галочки (вкл = карточка), ✏️ — правка.
// Карточка: значок (фон + буква или своё фото), название, цена, описание, ответ бота, адрес API, «Изменить» / «Опубликовать» / «Удалить».
// Правка и создание — в окне-редакторе (сохраняется по кнопке), там же переменные ответа бота.
// Отдельная карточка «Покупки» — последние покупки: «Выполнено» / «Вернуть поинты»
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const QUEUE = 'queue';

let st = { rewards: [], points: {}, redemptions: [], max: 30, layout: null, media: [] };
let channel = '';
let win = null;

const pointsName = () => st.points.name || t('rewards.points.default');
const rewardById = (id) => st.rewards.find((r) => r.id === id);
const apiPath = (r) => `/api/rewards/${channel}/${r.slug}`;

// ---------- сохранение раскладки ----------
let layoutTimer = null;
function saveLayout(panels) {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => api('/rewards/studio-layout', { method: 'PUT', body: { panels } }).catch(() => {}), 500);
}

// значок награды: своё фото или цветной квадрат с первой буквой
function tileHtml(r, size = 56) {
  if (r.image) return `<span class="rw-tile" style="--s:${size}px;background:${esc(r.color)}"><img src="${esc(r.image)}" alt="" /></span>`;
  return `<span class="rw-tile" style="--s:${size}px;background:${esc(r.color)}">${esc((r.title || '?').trim().charAt(0).toUpperCase())}</span>`;
}

// ---------- выбор картинки (свои фото из «Событий» + загрузка) ----------
function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(t('alerts.media.readFailed')));
    fr.readAsDataURL(file);
  });
}
function uploadImage(onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/gif,image/png,image/webp,image/jpeg';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return PW.toast(t('alerts.media.tooBig', { mb: 3 }), 'error');
    try {
      const r = await api('/alerts/media', { method: 'POST', body: { kind: 'image', data: await readFile(f), name: f.name.replace(/\.[^.]+$/, '') } });
      st.media.unshift(r.media);
      onDone(r.media);
    } catch (err) {
      PW.toast(err.message, 'error');
    }
  };
  input.click();
}
function pickImage(titleKey, current, onPick, allowNone = true) {
  const wrap = document.createElement('div');
  wrap.className = 'cw-modal';
  wrap.innerHTML = `<div class="cw-modal-box"><button type="button" class="cw-modal-x" aria-label="${esc(t('common.close'))}">×</button>
    <h3>${esc(t(titleKey))}</h3><div class="cw-modal-body"><div class="rw-img-grid"></div></div></div>`;
  const close = () => wrap.remove();
  wrap.querySelector('.cw-modal-x').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const grid = wrap.querySelector('.rw-img-grid');
  const draw = () => {
    grid.innerHTML = '';
    const add = (html, ref, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rw-img' + (current === ref ? ' on' : '');
      b.title = title || '';
      b.innerHTML = html;
      b.addEventListener('click', () => { onPick(ref); close(); });
      grid.appendChild(b);
    };
    if (allowNone) add(`<span>${esc(t('rewards.image.letter'))}</span>`, null, t('rewards.image.letter'));
    for (const m of st.media.filter((x) => x.kind === 'image')) add(`<img src="/api/alerts/media/${esc(m.id)}" alt="" />`, m.ref, m.name);
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'rw-img rw-img-up';
    up.innerHTML = `<b>＋</b><span>${esc(t('rewards.image.upload'))}</span>`;
    up.addEventListener('click', () => uploadImage((m) => { onPick(m.ref); close(); }));
    grid.appendChild(up);
  };
  draw();
  document.body.appendChild(wrap);
}

// ---------- карточка награды (просмотр) и окно-редактор ----------
const CHANGE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M18.5 2.5v4.5H14M5.5 21.5V17H10" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// переменные ответа бота (сервер: REPLY_VARS в rewards.routes.js)
const REPLY_VARS = ['user', 'reward', 'cost', 'message', 'points', 'balance'];
const NEED_TEXT = ['highlight', 'hello']; // без текста зрителя эти стартовые награды не работают
const isStarter = (r) => r.kind !== 'custom';

// ответ бота с примерами вместо переменных — для превью в карточке и редакторе
function replySample(tpl, r) {
  const ex = { user: 'Viewer1', reward: r.title || '…', cost: r.cost, message: t('rewards.vars.sampleMessage'), points: pointsName(), balance: 1250 };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (REPLY_VARS.includes(k) ? String(ex[k]) : m));
}

function updateCardHead(id) {
  const r = rewardById(id);
  const p = win.get(id);
  if (!r || !p) return;
  p.title.innerHTML = `${tileHtml(r, 20)} <span>${esc(r.title)}</span>`;
}

function renderCard(id) {
  const r = rewardById(id);
  if (!r || !r.enabled) return win.close(id);
  const p = win.open(id, 'rw-card');
  p.close.title = t('rewards.card.disable');
  p.content.innerHTML = `
    <div class="rw-card-top">
      <span class="rw-card-tile">${tileHtml(r, 72)}</span>
      <div class="rw-card-fields">
        <b class="rw-v-title" data-no-i18n>${esc(r.title)}</b>
        <span class="rw-v-cost">${esc(t('rewards.card.costShort', { n: r.cost }))}</span>
        ${r.needInput ? `<span class="rw-v-tag">✍ ${esc(t('rewards.card.needInput'))}</span>` : ''}
      </div>
    </div>
    <p class="rw-v-desc${r.description ? '' : ' muted'}" data-no-i18n>${esc(r.description || t('rewards.card.noDesc'))}</p>
    ${r.reply ? `<div class="rw-v-reply"><span>${esc(t('rewards.edit.reply'))}</span><div data-no-i18n>🤖 ${esc(replySample(r.reply, r))}</div></div>` : ''}
    ${isStarter(r) ? `<p class="rw-kind">${esc(t('rewards.kind.' + r.kind))}</p>` : ''}
    <div class="rw-api"><code data-no-i18n>${esc(apiPath(r))}</code><button type="button" class="icon-btn rw-copy">${esc(t('rewards.card.copyApi'))}</button></div>
    <div class="rw-actions">
      <button type="button" class="icon-btn rw-edit">${esc(t('rewards.card.edit'))}</button>
      ${isStarter(r) ? '' : `<button type="button" class="icon-btn rw-publish" title="${esc(t('rewards.card.publishHint'))}">${esc(t('rewards.card.publish'))}</button>`}
      <button type="button" class="rw-delete">${esc(t('rewards.card.delete'))}</button>
    </div>`;
  p.content.querySelector('.rw-edit').addEventListener('click', () => openEditor(id));
  p.content.querySelector('.rw-card-tile').addEventListener('click', () => openEditor(id));
  p.content.querySelector('.rw-publish')?.addEventListener('click', () => publishReward(id));
  p.content.querySelector('.rw-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.origin + apiPath(rewardById(id)));
      PW.toast(t('rewards.card.copied'), 'success');
    } catch (_) {
      PW.toast(location.origin + apiPath(rewardById(id)), 'info');
    }
  });
  p.content.querySelector('.rw-delete').addEventListener('click', () => deleteReward(id));
  updateCardHead(id);
}

async function deleteReward(id) {
  const ok = await PW.confirm(t('rewards.card.deleteConfirm', { name: rewardById(id).title }), { danger: true, okText: t('common.delete') });
  if (!ok) return;
  try {
    await api('/rewards/studio/' + id, { method: 'DELETE' });
    st.rewards = st.rewards.filter((x) => x.id !== id);
    win.close(id);
    renderPicker();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

function publishReward(id) {
  if (!window.PWPresets) return;
  PWPresets.openPublish({ type: 'reward', rewardId: id, onDone: () => PW.toast(t('rewards.card.published'), 'success') });
}

// редактор: id — правка награды, null — новая. Сохраняется по кнопке (ошибка не портит награду на полпути)
function openEditor(id) {
  const old = id ? rewardById(id) : null;
  const d = old
    ? { title: old.title, description: old.description || '', cost: old.cost, color: old.color, needInput: !!old.needInput, reply: old.reply || '', imageRef: old.imageRef || null, image: old.image || null, kind: old.kind }
    : { title: '', description: '', cost: 100, color: '#7c3aed', needInput: false, reply: '', imageRef: null, image: null, kind: 'custom' };
  const lockInput = NEED_TEXT.includes(d.kind);
  const wrap = document.createElement('div');
  wrap.className = 'cw-modal';
  wrap.innerHTML = `<div class="cw-modal-box rw-editor"><button type="button" class="cw-modal-x" aria-label="${esc(t('common.close'))}">×</button>
    <h3>${esc(t(old ? 'rewards.edit.title' : 'rewards.edit.newTitle'))}</h3>
    <div class="cw-modal-body">
      <div class="rw-card-top">
        <div class="rw-card-tilewrap"><span class="rw-card-tile"></span>
          <button type="button" class="ev-change rw-change" title="${esc(t('rewards.image.title'))}">${CHANGE_ICON}</button></div>
        <div class="rw-card-fields">
          <label class="rw-field"><span>${esc(t('rewards.edit.name'))}</span><input class="rw-title" maxlength="45" placeholder="${esc(t('rewards.card.titlePh'))}" /></label>
          <div class="rw-row">
            <label class="rw-cost"><span>${esc(t('rewards.card.cost'))}</span><input type="number" min="1" max="1000000" /></label>
            <label class="rw-color"><span>${esc(t('rewards.card.color'))}</span><input type="color" /></label>
          </div>
        </div>
      </div>
      <label class="rw-field"><span>${esc(t('rewards.edit.desc'))}</span><textarea class="rw-desc" rows="2" maxlength="200" placeholder="${esc(t('rewards.card.descPh'))}"></textarea></label>
      <label class="rw-check"><input type="checkbox" class="rw-input" ${lockInput ? 'disabled' : ''} /> <span>${esc(t('rewards.card.needInput'))}</span></label>
      <label class="rw-field"><span>${esc(t('rewards.edit.reply'))} <small>${esc(t('rewards.edit.replyHint'))}</small></span>
        <textarea class="rw-reply" rows="2" maxlength="200" placeholder="${esc(t('rewards.edit.replyPh'))}"></textarea></label>
      <div class="rw-vars"></div>
      <div class="rw-reply-prev"></div>
      <p class="rw-err hidden"></p>
      <div class="rw-editor-btns">
        <button type="button" class="icon-btn rw-cancel">${esc(t('rewards.edit.cancel'))}</button>
        <button type="button" class="rw-save">${esc(t(old ? 'rewards.edit.save' : 'rewards.edit.create'))}</button>
      </div>
    </div></div>`;
  const $ = (sel) => wrap.querySelector(sel);
  const title = $('.rw-title'), cost = $('.rw-cost input'), color = $('.rw-color input'), desc = $('.rw-desc');
  const needInput = $('.rw-input'), reply = $('.rw-reply'), err = $('.rw-err'), save = $('.rw-save');
  title.value = d.title;
  cost.value = d.cost;
  color.value = d.color;
  desc.value = d.description;
  needInput.checked = d.needInput || lockInput;
  reply.value = d.reply;

  const cur = () => ({ ...d, title: title.value.trim() || '?', cost: Math.round(Number(cost.value)) || 0, color: color.value });
  const drawTile = () => { $('.rw-card-tile').innerHTML = tileHtml(cur(), 72); };
  const drawPreview = () => {
    const v = reply.value.trim();
    $('.rw-reply-prev').innerHTML = v ? `<span>${esc(t('rewards.edit.preview'))}</span> <b data-no-i18n>🤖 ${esc(replySample(v, cur()))}</b>` : '';
  };
  // переменные: клик — вставить в ответ там, где курсор
  const vars = $('.rw-vars');
  for (const k of REPLY_VARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rw-var';
    b.innerHTML = `<code>{${k}}</code><span>${esc(t('rewards.vars.' + k))}</span>`;
    b.addEventListener('click', () => {
      const s = reply.selectionStart ?? reply.value.length, e = reply.selectionEnd ?? s;
      const ins = '{' + k + '}';
      if (reply.value.length - (e - s) + ins.length > 200) return;
      reply.value = reply.value.slice(0, s) + ins + reply.value.slice(e);
      reply.focus();
      reply.setSelectionRange(s + ins.length, s + ins.length);
      drawPreview();
    });
    vars.appendChild(b);
  }
  title.addEventListener('input', () => { drawTile(); drawPreview(); });
  color.addEventListener('input', drawTile);
  cost.addEventListener('input', drawPreview);
  reply.addEventListener('input', drawPreview);
  $('.rw-change').addEventListener('click', () => pickImage('rewards.image.title', d.imageRef, (ref) => {
    d.imageRef = ref;
    const m = ref && st.media.find((x) => x.ref === ref);
    d.image = m ? '/api/alerts/media/' + m.id : null;
    drawTile();
  }));

  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.cw-modal + .cw-modal')) close(); };
  document.addEventListener('keydown', onKey);
  $('.cw-modal-x').addEventListener('click', close);
  $('.rw-cancel').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });

  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    const c = Math.round(Number(cost.value));
    const body = {
      title: title.value, description: desc.value, cost: Number.isFinite(c) ? c : 0, color: color.value,
      needInput: needInput.checked, reply: reply.value, image: d.imageRef,
    };
    save.disabled = true;
    try {
      const r = old
        ? await api('/rewards/studio/' + id, { method: 'PUT', body })
        : await api('/rewards/studio', { method: 'POST', body });
      const i = st.rewards.findIndex((x) => x.id === r.reward.id);
      if (i >= 0) st.rewards[i] = r.reward;
      else st.rewards.push(r.reward);
      close();
      renderCard(r.reward.id);
      renderPicker();
      PW.toast(t(old ? 'common.saved' : 'rewards.edit.created'), 'success');
    } catch (e) {
      err.textContent = e.message || t('common.requestFailed');
      err.classList.remove('hidden');
      save.disabled = false;
    }
  });

  drawTile();
  drawPreview();
  document.body.appendChild(wrap);
  title.focus();
}

// ---------- карточка «Покупки» ----------
function renderQueue() {
  const p = win.open(QUEUE, 'rw-queue');
  p.title.textContent = t('rewards.queue.title');
  p.close.title = t('rewards.card.hide');
  const list = document.createElement('div');
  list.className = 'rw-q-list';
  list.setAttribute('data-no-i18n', '');
  if (!st.redemptions.length) {
    list.innerHTML = `<p class="rw-q-empty">${esc(t('rewards.queue.empty'))}</p>`;
  }
  for (const x of st.redemptions) {
    const row = document.createElement('div');
    row.className = 'rw-q-row rw-q-' + x.status;
    row.innerHTML = `<div class="rw-q-main"><b>${esc(x.username)}</b> · ${esc(x.title)} <span class="rw-q-cost">${esc(x.cost)}</span>${x.test ? ` <span class="rw-q-test">${esc(t('rewards.queue.test'))}</span>` : ''}
      ${x.message ? `<div class="rw-q-msg">${esc(x.message)}</div>` : ''}
      <div class="rw-q-at">${esc(new Date(x.at).toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' }))}</div></div>`;
    if (x.status === 'new') {
      const btns = document.createElement('div');
      btns.className = 'rw-q-btns';
      for (const [status, key] of x.test ? [['done', 'rewards.queue.done']] : [['done', 'rewards.queue.done'], ['refunded', 'rewards.queue.refund']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.textContent = t(key);
        b.addEventListener('click', async () => {
          try {
            await api('/rewards/studio-redemptions/' + x.id, { method: 'PATCH', body: { status } });
            x.status = status;
            renderQueue();
          } catch (err) {
            PW.toast(err.message, 'error');
          }
        });
        btns.appendChild(b);
      }
      row.appendChild(btns);
    } else {
      const s = document.createElement('span');
      s.className = 'rw-q-status';
      s.textContent = t('rewards.queue.' + x.status);
      row.appendChild(s);
    }
    list.appendChild(row);
  }
  p.content.replaceChildren(list);
}

// ---------- справа ----------
function renderPicker() {
  const box = document.getElementById('cwChecks');
  box.innerHTML = '';
  const line = (id, html, checked, onChange, onEdit) => {
    const lab = document.createElement('label');
    lab.className = 'cw-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    const span = document.createElement('span');
    span.innerHTML = html;
    lab.append(cb, span);
    if (onEdit) {
      // ✏️ — правка и выключенной награды (её карточки на холсте нет)
      const ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'rw-pick-edit';
      ed.textContent = '✏️';
      ed.title = t('rewards.card.edit');
      ed.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onEdit(); });
      lab.appendChild(ed);
    }
    box.appendChild(lab);
  };
  for (const r of st.rewards) {
    line(r.id, `${tileHtml(r, 18)} ${esc(r.title)} <small>${esc(r.cost)}</small>`, r.enabled, (on) => setEnabled(r.id, on), () => openEditor(r.id));
  }
  line(QUEUE, '🧾 ' + esc(t('rewards.queue.title')), win.has(QUEUE), (on) => (on ? renderQueue() : win.close(QUEUE)));
  document.getElementById('rwCreate').disabled = st.rewards.length >= st.max;
}

async function setEnabled(id, on) {
  try {
    const r = await api('/rewards/studio/' + id, { method: 'PUT', body: { enabled: on } });
    const i = st.rewards.findIndex((x) => x.id === id);
    st.rewards[i] = r.reward;
    renderCard(id);
    renderPicker();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

function renderPoints() {
  document.getElementById('rwName').textContent = pointsName();
  const icon = document.getElementById('rwIcon');
  icon.innerHTML = st.points.icon ? `<img src="${esc(st.points.icon)}" alt="" />` : '<span class="rw-coin"></span>';
  const rename = document.getElementById('rwRename');
  rename.disabled = !!st.points.nextRenameAt;
  rename.title = st.points.nextRenameAt
    ? t('rewards.points.renameAt', { date: new Date(st.points.nextRenameAt).toLocaleDateString(I18N.locale) })
    : t('rewards.points.renameHint');
  document.getElementById('rwRule').textContent = t('rewards.points.rule', {
    min: st.points.claimEvery || 5, f: st.points.amount?.follower ?? 50, v: st.points.amount?.viewer ?? 10,
  });
}

document.getElementById('rwRename').addEventListener('click', async () => {
  const v = await PW.prompt(t('rewards.points.renameText'), { title: t('rewards.points.rename'), defaultValue: st.points.name || '' });
  if (v === null || v === undefined || !v.trim()) return;
  try {
    await api('/rewards/studio-points', { method: 'PUT', body: { name: v.trim() } });
    st.points.name = v.trim();
    st.points.nextRenameAt = new Date(Date.now() + 30 * 864e5).toISOString();
    renderPoints();
    PW.toast(t('common.saved'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});
document.getElementById('rwIcon').addEventListener('click', () => pickImage('rewards.points.icon', st.points.iconRef, async (ref) => {
  try {
    const r = await api('/rewards/studio-points', { method: 'PUT', body: { icon: ref } });
    st.points.iconRef = ref;
    st.points.icon = r.icon || null;
    renderPoints();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}));

document.getElementById('rwCreate').addEventListener('click', () => {
  if (st.rewards.length >= st.max) return PW.toast(t('rewards.limit', { n: st.max }), 'error');
  openEditor(null);
});

async function resetCardsLayout() {
  const ok = await PW.confirm(t('rewards.layoutReset'));
  if (!ok) return;
  win.resetPanels();
  api('/rewards/studio-layout', { method: 'DELETE' }).catch(() => {});
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

(async function init() {
  const canvas = document.getElementById('cwCanvas');
  const picker = document.getElementById('cwPicker');
  const topBar = document.getElementById('cwTopBar');
  // «Покупки» — первой, дальше награды по порядку
  const order = (id) => (id === QUEUE ? 0 : 1 + st.rewards.findIndex((r) => r.id === id));
  win = PWCanvasWindows.create({
    canvas, picker, topBar, minW: 240, minH: 220,
    defRect: (id) => PWCanvasWindows.gridRect({ index: order(id), picker, topBar, w: 300, h: id === QUEUE ? 420 : 400 }),
    onLayout: saveLayout,
    onClose: (id) => (id === QUEUE ? (win.close(QUEUE), renderPicker()) : setEnabled(id, false)),
  });
  try {
    const [me, d, media] = await Promise.all([api('/auth/me'), api('/rewards/studio'), api('/alerts/settings').catch(() => ({ media: [] }))]);
    channel = String(me.streamerName || '').toLowerCase();
    st = { ...st, ...d, media: media.media || [] };
  } catch (err) {
    PW.toast(err.message, 'error');
    return;
  }
  document.getElementById('rwApiBase').textContent = `/api/rewards/${channel}/<…>`;
  win.setPanels(st.layout?.panels);
  renderQueue();
  for (const r of st.rewards) renderCard(r.id);
  renderPoints();
  renderPicker();
  window.addEventListener('pw:langchange', () => { renderPoints(); renderPicker(); renderQueue(); st.rewards.forEach((r) => renderCard(r.id)); });
})();
