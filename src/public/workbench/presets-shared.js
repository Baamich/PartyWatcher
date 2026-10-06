(function () {
  'use strict';
  const S = window.PWStyle;
  const LS_KEY = 'pw_ctor_chat'; // тот же ключ, что у Конструктора

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  const SAMPLE = [
    { owner: true, text: 'Всем привет! Начинаем стрим' },
    { nick: 'Viewer1', text: 'Привет!' },
    { nick: 'viewer123', color: '#4ade80', src: 'twitch', text: 'Привет из твича 👋' },
    { nick: 'Бот', src: 'bot', text: '🎲 Viewer1, выпало 17 (из 30)' },
  ];

  const usageText = (args) => (args || []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ');

  // ---------- стиль из Конструктора ----------
  function currentStyle() {
    try { return S.sanitize(JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch (_) { return S.sanitize({}); }
  }
  function applyStyle(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S.sanitize(data))); } catch (_) {}
  }

  // ---------- превью ----------
  function styleStage(settings, owner) {
    const box = el('div', 'ctor-stage ctor-stage--small');
    S.render(box, settings, SAMPLE, owner);
    return box;
  }

  function commandBox(item) {
    const box = el('div', 'pst-cmd');
    const r1 = el('div', 'pst-cmd-row');
    r1.append(el('span', 'pst-cmd-lbl', 'Ввод:'), el('code', null, item.preview?.line || '!' + item.data.name));
    const r2 = el('div', 'pst-cmd-row');
    r2.append(el('span', 'pst-cmd-lbl', 'Вывод:'), el('span', 'pst-cmd-out', item.preview?.text || '…'));
    box.append(r1, r2);
    const u = usageText(item.data.args);
    if (u) box.appendChild(el('div', 'pst-cmd-usage', 'Аргументы: ' + u));
    return box;
  }

  // ---------- карточка ----------
  // o: { onLike, onAdd, onTrash, readonly }
  function buildCard(item, o = {}) {
    const card = el('article', 'pst-card');
    card.dataset.id = item.id;

    if (o.onTrash && (item.canDelete || item.added)) {
      const d = el('button', 'pst-del');
      d.type = 'button';
      d.title = item.canDelete ? 'Удалить пре-сет' : 'Убрать у себя';
      d.setAttribute('aria-label', d.title);
      d.innerHTML = ICON_TRASH; // статичная иконка из константы выше
      d.addEventListener('click', () => o.onTrash(item));
      card.appendChild(d);
    }

    const main = el('div', 'pst-main');
    main.appendChild(item.type === 'style' ? styleStage(item.data, item.authorName) : commandBox(item));
    main.appendChild(el('h3', 'pst-name', item.name));
    if (item.description) main.appendChild(el('p', 'pst-desc', item.description));
    const tag = item.mine ? ' · ваш' : item.added ? ' · добавлен' : '';
    main.appendChild(el('div', 'pst-meta',
      `${item.type === 'style' ? 'Стиль' : 'Команда'} · от ${item.authorName} · ${new Date(item.createdAt).toLocaleDateString('ru-RU')}${tag}`));
    card.appendChild(main);

    const foot = el('div', 'pst-foot');
    if (o.readonly) {
      foot.append(el('span', 'pst-count', '👥 ' + item.adds), el('span', 'pst-count', '♥ ' + item.likes));
    } else {
      const add = el('button', 'pst-add' + (item.added ? ' on' : ''), item.added ? '✓ Добавлено' : '＋ Добавить');
      add.type = 'button';
      if (item.mine) { add.disabled = true; add.textContent = 'Ваш пре-сет'; }
      add.addEventListener('click', () => o.onAdd && o.onAdd(item));

      const adds = el('span', 'pst-count', '👥 ' + item.adds);
      adds.title = 'Сколько человек добавили';

      const like = el('button', 'pst-like' + (item.liked ? ' on' : ''), '♥ ' + item.likes);
      like.type = 'button';
      like.title = item.mine ? 'Свой пре-сет лайкать нельзя' : 'Нравится';
      if (item.mine) like.disabled = true;
      like.addEventListener('click', () => o.onLike && o.onLike(item));

      foot.append(add, adds, like);
    }
    card.appendChild(foot);
    return card;
  }

  // ---------- удаление / убрать у себя ----------
  async function deleteItem(item, after) {
    const ok = await PW.confirm(
      `Вы уверены, что хотите удалить пре-сет: «${item.name}»?` +
      (item.adds ? ' Из списка он пропадёт у всех, но уже добавленные стили и команды останутся у пользователей.' : ''),
      { title: 'Удалить пре-сет?', okText: 'Да', cancelText: 'Нет', danger: true }
    );
    if (!ok) return;
    try {
      await api('/presets/' + item.id, { method: 'DELETE' });
      PW.toast('Пре-сет удалён', 'success');
      after && after('deleted');
    } catch (e) { PW.toast(e.message || 'Не удалось удалить', 'error'); }
  }

  async function unaddItem(item, after) {
    const extra = item.type === 'command' ? ` Команда !${item.data.name} тоже удалится из твоих команд.` : ' Текущие настройки Конструктора не изменятся.';
    const ok = await PW.confirm(`Убрать пре-сет «${item.name}» из добавленных?${extra}`,
      { title: 'Убрать пре-сет?', okText: 'Да', cancelText: 'Нет', danger: true });
    if (!ok) return;
    try {
      await api(`/presets/${item.id}/add`, { method: 'DELETE' });
      PW.toast('Пре-сет убран', 'success');
      after && after('unadded');
    } catch (e) { PW.toast(e.message || 'Не удалось убрать', 'error'); }
  }

  const trash = (item, after) => (item.canDelete ? deleteItem(item, after) : unaddItem(item, after));

  // ---------- окно «Опубликовать пре-сет» ----------
  async function openPublish({ type, onDone } = {}) {
    let t = type || 'style';
    let cmds = [];
    let cmdsLoaded = false;

    const back = el('div', 'modal');
    const box = el('div', 'modal-content pst-modal');
    back.appendChild(box);

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);

    const closeBtn = el('button', 'modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);

    const name = el('input');
    name.maxLength = 40;
    name.placeholder = 'Название (обязательно), например: Неоновая лента';
    const desc = el('textarea');
    desc.rows = 3;
    desc.maxLength = 200;
    desc.placeholder = 'Описание (необязательно, до 200 символов)';
    const err = el('p', 'ctor-error hidden');
    const submit = el('button', 'auth-submit', 'Опубликовать');
    submit.type = 'button';

    const typeRow = el('div', 'pst-seg');
    const body = el('div', 'pst-pub-body');
    const select = el('select');
    select.addEventListener('change', drawBody);

    function drawTypeRow() {
      typeRow.replaceChildren();
      [['style', 'Стиль чата'], ['command', 'Команда']].forEach(([k, label]) => {
        const b = el('button', k === t ? 'active' : '', label);
        b.type = 'button';
        b.addEventListener('click', async () => { t = k; drawTypeRow(); await ensureCmds(); drawBody(); });
        typeRow.appendChild(b);
      });
    }

    async function ensureCmds() {
      if (t !== 'command' || cmdsLoaded) return;
      try { cmds = await api('/workbench/commands'); } catch (_) { cmds = []; }
      cmdsLoaded = true;
      select.replaceChildren();
      cmds.forEach((c, i) => {
        const o = el('option', null, '!' + c.name);
        o.value = String(i);
        select.appendChild(o);
      });
    }

    function drawBody() {
      body.replaceChildren();
      err.classList.add('hidden');
      if (t === 'style') {
        body.append(
          el('p', 'wb-hint', 'Будет опубликован стиль из Конструктора чата, который сейчас сохранён в этом браузере.'),
          styleStage(currentStyle(), 'Стример')
        );
        submit.disabled = false;
      } else if (!cmds.length) {
        body.appendChild(el('p', 'wb-hint', 'У тебя пока нет команд. Создай команду в «Командах чата», потом опубликуй её.'));
        submit.disabled = true;
      } else {
        const c = cmds[parseInt(select.value, 10) || 0];
        body.append(
          el('div', 'auth-label', 'Какую команду опубликовать'),
          select,
          el('p', 'wb-hint', 'Ответ: ' + c.response)
        );
        submit.disabled = false;
      }
    }

    submit.addEventListener('click', async () => {
      err.classList.add('hidden');
      const payload = { type: t, name: name.value, description: desc.value };
      if (t === 'style') payload.data = currentStyle();
      else {
        const c = cmds[parseInt(select.value, 10) || 0];
        if (!c) return;
        payload.data = { name: c.name, response: c.response, args: c.args || [] };
      }
      submit.disabled = true;
      try {
        await api('/presets', { method: 'POST', body: payload });
        PW.toast('Пре-сет опубликован', 'success');
        close();
        onDone && onDone();
      } catch (e) {
        err.textContent = e.message || 'Не удалось опубликовать';
        err.classList.remove('hidden');
        submit.disabled = false;
      }
    });

    box.append(closeBtn, el('h3', null, 'Опубликовать пре-сет'));
    if (!type) box.appendChild(typeRow);
    box.append(body, el('label', 'auth-label', 'Название'), name, el('label', 'auth-label', 'Описание'), desc, err, submit);

    drawTypeRow();
    await ensureCmds();
    drawBody();
    document.body.appendChild(back);
    name.focus();
  }

  window.PWPresets = { buildCard, openPublish, deleteItem, unaddItem, trash, currentStyle, applyStyle, LS_KEY };
})();