let canManage = false;
let editingId = null;        // id новости, которую правим (null — создаём новую)
let existingImageUrl = null; // картинка, которая уже есть у правимой новости
let imageRemoved = false;    // админ нажал «Убрать» у существующей картинки
let pendingImage = null;     // новая выбранная картинка (data URL), уже уменьшенная
let delNewsId = null;
let titleSpell = null;
let bodySpell = null;

const $ = (id) => document.getElementById(id);

function fmtDate(d) {
  return new Date(d).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'long', year: 'numeric' });
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

// ---------- список ----------

function buildNewsRow(n) {
  const row = document.createElement('div');
  row.className = 'news-row';

  const card = document.createElement('article');
  card.className = 'news-card';

  if (n.imageUrl) {
    const img = document.createElement('img');
    img.className = 'news-card-img';
    img.src = n.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'news-card-body';

  const date = document.createElement('div');
  date.className = 'news-card-date';
  date.textContent = fmtDate(n.publishedAt) + (n.editedAt ? ' · ' + t('news.edited', { date: fmtDate(n.editedAt) }) : '');

  const title = document.createElement('h2');
  title.className = 'news-card-title';

  const text = document.createElement('div');
  text.className = 'news-card-text'; // white-space: pre-wrap: показываем ровно как написано

  body.append(date, title, text);

  // автоперевод: показываем на языке читателя, оригинал — по кнопке
  let showOriginal = !n.translation;
  const paint = () => {
    const src = showOriginal ? n : n.translation;
    title.textContent = src.title;
    text.textContent = src.body || '';
    text.classList.toggle('hidden', !src.body);
    if (toggle) toggle.textContent = showOriginal ? t('news.tr.showTranslation') : t('news.tr.showOriginal');
  };
  let toggle = null;
  if (n.translation) {
    const note = document.createElement('div');
    note.className = 'news-tr-note';
    const label = document.createElement('span');
    label.textContent = t('news.tr.auto') + ' · ';
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'news-tr-toggle';
    toggle.onclick = () => { showOriginal = !showOriginal; paint(); };
    note.append(label, toggle);
    body.appendChild(note);
  }
  paint();

  card.appendChild(body);
  row.appendChild(card);

  if (canManage) {
    const actions = document.createElement('div');
    actions.className = 'news-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn';
    edit.textContent = t('news.editBtn');
    edit.onclick = () => openNewsModal(n);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = t('news.delBtn');
    del.onclick = () => openDelNews(n.id);

    actions.append(edit, del);
    row.appendChild(actions);
  }

  return row;
}

async function loadNews() {
  const list = $('newsList');
  const from = $('newsFrom').value;
  const to = $('newsTo').value;

  const qs = new URLSearchParams();
  if (from) qs.set('from', new Date(from + 'T00:00:00').toISOString());
  if (to) qs.set('to', new Date(to + 'T23:59:59.999').toISOString());

  try {
    const data = await api('/news' + (qs.toString() ? '?' + qs.toString() : ''));
    canManage = !!data.canManage;
    $('newsCreateBtn').classList.toggle('hidden', !canManage);

    list.innerHTML = '';
    if (!data.items.length) {
      const empty = document.createElement('p');
      empty.className = 'wb-subpage-hint';
      empty.textContent = from || to ? t('news.emptyPeriod') : t('news.empty');
      list.appendChild(empty);
      return;
    }
    data.items.forEach((n) => list.appendChild(buildNewsRow(n)));
  } catch (e) {
    list.innerHTML = '';
    const err = document.createElement('p');
    err.style.color = 'var(--danger)';
    err.textContent = e.message || t('news.loadFailed');
    list.appendChild(err);
  }
}

// ---------- картинка: уменьшаем до 1200 px и делаем JPEG, чтобы не грузить мегабайты ----------

async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1200 / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // у PNG с прозрачностью фон станет белым, а не чёрным
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// показывает превью: новая картинка важнее старой; если старую убрали, превью нет
function renderImageUi() {
  const preview = $('newsImagePreview');
  const src = pendingImage || (!imageRemoved ? existingImageUrl : null);
  if (src) {
    preview.src = src;
    preview.classList.remove('hidden');
    $('newsImageRemove').classList.remove('hidden');
  } else {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    $('newsImageRemove').classList.add('hidden');
  }
}

function removeImage() {
  pendingImage = null;
  if (existingImageUrl) imageRemoved = true;
  $('newsImageInput').value = '';
  renderImageUi();
}

// ---------- проверка орфографии: список замечаний под полем ----------

function setupSpell(field, listEl) {
  let timer = null;
  let token = 0;
  let checkedText = '';

  function render(matches) {
    listEl.innerHTML = '';
    if (!matches.length) {
      listEl.textContent = t('news.spell.ok');
      return;
    }

    const head = document.createElement('div');
    head.className = 'news-spell-title';
    head.textContent = t('news.spell.found', { n: matches.length });
    listEl.appendChild(head);

    matches.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'news-spell-row';

      const word = checkedText.substr(m.offset, m.length);
      const b = document.createElement('b');
      b.textContent = '«' + word + '»';
      row.append(b, document.createTextNode(' — ' + m.message + ' '));

      (m.replacements || []).forEach((rep) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'news-spell-fix';
        btn.textContent = rep;
        btn.onclick = () => {
          if (field.value !== checkedText) return; // текст уже изменился: подожди новую проверку
          field.value = checkedText.slice(0, m.offset) + rep + checkedText.slice(m.offset + m.length);
          field.dispatchEvent(new Event('input')); // перепроверим
        };
        row.appendChild(btn);
      });

      listEl.appendChild(row);
    });
  }

  async function run() {
    const text = field.value;
    checkedText = text;
    const mine = ++token;

    if (!text.trim()) {
      listEl.innerHTML = '';
      return;
    }
    try {
      const data = await api('/news/spellcheck', { method: 'POST', body: { text } });
      if (mine !== token) return;
      render(data.matches || []);
    } catch (e) {
      if (mine !== token) return;
      listEl.textContent = t('news.spell.unavailable');
    }
  }

  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 1200); // ждём, пока перестанешь печатать
  });

  return {
    run,
    reset() {
      clearTimeout(timer);
      token++;
      listEl.innerHTML = '';
    },
  };
}

// ---------- создание и правка ----------

function showFormError(text) {
  const el = $('newsFormError');
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideFormError() {
  $('newsFormError').classList.add('hidden');
}

// item = null: новая новость; item = объект новости: правка
function openNewsModal(item) {
  editingId = item ? item.id : null;
  existingImageUrl = item ? item.imageUrl : null;
  imageRemoved = false;
  pendingImage = null;

  $('newsModalTitle').textContent = item ? t('news.editTitle') : t('news.newTitle');
  $('newsPublishBtn').textContent = item ? t('common.save') : t('news.publish');
  $('newsDateInfo').textContent = item
    ? t('news.publishedAt', { date: fmtDate(item.publishedAt) })
    : t('news.dateAuto', { date: fmtDate(new Date()) });

  $('newsTitleInput').value = item ? item.title : '';
  $('newsBodyInput').value = item ? item.body : '';
  $('newsImageInput').value = '';
  hideFormError();
  renderImageUi();

  titleSpell.reset();
  bodySpell.reset();
  if (item) {
    titleSpell.run();
    bodySpell.run();
  }

  $('newsModal').classList.remove('hidden');
  $('newsTitleInput').focus();
}

function closeNewsModal() {
  $('newsModal').classList.add('hidden');
}

async function publishNews() {
  const title = $('newsTitleInput').value.trim();
  const body = $('newsBodyInput').value; // без обрезки: как написал, так и сохранится

  if (title.length < 3) {
    showFormError(t('news.titleShort'));
    return;
  }

  const payload = { title, body };
  if (pendingImage) payload.image = pendingImage;
  else if (editingId && imageRemoved) payload.removeImage = true;

  const btn = $('newsPublishBtn');
  btn.disabled = true;
  hideFormError();
  try {
    if (editingId) await api('/news/' + editingId, { method: 'PATCH', body: payload });
    else await api('/news', { method: 'POST', body: payload });
    closeNewsModal();
    await loadNews();
  } catch (e) {
    showFormError(e.message || t('common.saveFailed'));
  } finally {
    btn.disabled = false;
  }
}

// ---------- удаление ----------

function openDelNews(id) {
  delNewsId = id;
  $('delNewsModal').classList.remove('hidden');
}

function closeDelNews() {
  delNewsId = null;
  $('delNewsModal').classList.add('hidden');
}

async function confirmDelNews() {
  if (!delNewsId) return;
  try {
    await api('/news/' + delNewsId, { method: 'DELETE' });
  } catch (e) {
    PW.toast(e.message || t('news.delFailed'), 'error');
  }
  closeDelNews();
  loadNews();
}

// ---------- старт ----------

async function init() {
  try {
    await api('/auth/me');
  } catch {
    location.href = '/';
    return;
  }

  titleSpell = setupSpell($('newsTitleInput'), $('newsTitleSpell'));
  bodySpell = setupSpell($('newsBodyInput'), $('newsBodySpell'));

  $('newsFrom').addEventListener('change', loadNews);
  $('newsTo').addEventListener('change', loadNews);
  $('newsResetBtn').addEventListener('click', () => {
    $('newsFrom').value = '';
    $('newsTo').value = '';
    loadNews();
  });
  $('newsCreateBtn').addEventListener('click', () => openNewsModal(null));

  $('newsImageRemove').addEventListener('click', removeImage);
  $('newsImageInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      showFormError(t('news.imageTooBig'));
      e.target.value = '';
      return;
    }
    try {
      pendingImage = await prepareImage(file);
      renderImageUi();
      hideFormError();
    } catch {
      pendingImage = null;
      e.target.value = '';
      renderImageUi();
      showFormError(t('news.imageReadFailed'));
    }
  });

  $('newsModal').addEventListener('click', (e) => {
    if (e.target.id === 'newsModal') closeNewsModal();
  });
  $('delNewsModal').addEventListener('click', (e) => {
    if (e.target.id === 'delNewsModal') closeDelNews();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeNewsModal();
      closeDelNews();
    }
  });

  loadNews();
}

init();