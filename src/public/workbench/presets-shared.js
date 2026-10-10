(function () {
  'use strict';
  const S = window.PWStyle;
  const tr = (k, v) => window.t(k, v); // здесь есть переменная t (тип пре-сета), поэтому перевод — tr
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
    { owner: true, text: tr('constructor.sample.owner') },
    { nick: 'Viewer1', text: tr('constructor.sample.hi') },
    { nick: 'viewer123', color: '#4ade80', src: 'twitch', text: tr('constructor.sample.twitch') },
    { nick: tr('common.sys.bot'), src: 'bot', text: tr('constructor.sample.bot') },
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
    r1.append(el('span', 'pst-cmd-lbl', tr('presets.input')), el('code', null, item.preview?.line || '!' + item.data.name));
    const r2 = el('div', 'pst-cmd-row');
    r2.append(el('span', 'pst-cmd-lbl', tr('presets.output')), el('span', 'pst-cmd-out', item.preview?.text || '…'));
    box.append(r1, r2);
    const u = usageText(item.data.args);
    if (u) box.appendChild(el('div', 'pst-cmd-usage', tr('presets.args') + ' ' + u));
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
      d.title = item.canDelete ? tr('presets.delete') : tr('presets.unadd');
      d.setAttribute('aria-label', d.title);
      d.innerHTML = ICON_TRASH; // статичная иконка из константы выше
      d.addEventListener('click', () => o.onTrash(item));
      card.appendChild(d);
    }

    const main = el('div', 'pst-main');
    main.appendChild(item.type === 'style' ? styleStage(item.data, item.authorName) : commandBox(item));
    main.appendChild(el('h3', 'pst-name', item.name));
    if (item.description) main.appendChild(el('p', 'pst-desc', item.description));
    const tag = item.mine ? ' · ' + tr('presets.tagMine') : item.added ? ' · ' + tr('presets.tagAdded') : '';
    main.appendChild(el('div', 'pst-meta',
      `${item.type === 'style' ? tr('presets.typeStyle') : tr('presets.typeCommand')} · ${tr('presets.by', { name: item.authorName })} · ${new Date(item.createdAt).toLocaleDateString(I18N.locale)}${tag}`));
    card.appendChild(main);

    const foot = el('div', 'pst-foot');
    if (o.readonly) {
      foot.append(el('span', 'pst-count', '👥 ' + item.adds), el('span', 'pst-count', '♥ ' + item.likes));
    } else {
      const add = el('button', 'pst-add' + (item.added ? ' on' : ''), item.added ? tr('presets.added') : tr('presets.add'));
      add.type = 'button';
      if (item.mine) { add.disabled = true; add.textContent = tr('presets.yours'); }
      add.addEventListener('click', () => o.onAdd && o.onAdd(item));

      const adds = el('span', 'pst-count', '👥 ' + item.adds);
      adds.title = tr('presets.addsTitle');

      const like = el('button', 'pst-like' + (item.liked ? ' on' : ''), '♥ ' + item.likes);
      like.type = 'button';
      like.title = item.mine ? tr('presets.noSelfLike') : tr('presets.like');
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
      tr('presets.del.text', { name: item.name }) + (item.adds ? ' ' + tr('presets.del.textAdded') : ''),
      { title: tr('presets.del.title'), okText: tr('presets.yes'), cancelText: tr('presets.no'), danger: true }
    );
    if (!ok) return;
    try {
      await api('/presets/' + item.id, { method: 'DELETE' });
      PW.toast(tr('presets.del.done'), 'success');
      after && after('deleted');
    } catch (e) { PW.toast(e.message || tr('presets.del.failed'), 'error'); }
  }

  async function unaddItem(item, after) {
    const extra = ' ' + (item.type === 'command' ? tr('presets.unaddCmd', { name: item.data.name }) : tr('presets.unaddStyle'));
    const ok = await PW.confirm(tr('presets.unaddText', { name: item.name }) + extra,
      { title: tr('presets.unaddTitle'), okText: tr('presets.yes'), cancelText: tr('presets.no'), danger: true });
    if (!ok) return;
    try {
      await api(`/presets/${item.id}/add`, { method: 'DELETE' });
      PW.toast(tr('presets.unaddDone'), 'success');
      after && after('unadded');
    } catch (e) { PW.toast(e.message || tr('presets.unaddFailed'), 'error'); }
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
    name.placeholder = tr('presets.pub.namePh');
    const desc = el('textarea');
    desc.rows = 3;
    desc.maxLength = 200;
    desc.placeholder = tr('presets.pub.descPh');
    const err = el('p', 'ctor-error hidden');
    const submit = el('button', 'auth-submit', tr('presets.pub.submit'));
    submit.type = 'button';

    const typeRow = el('div', 'pst-seg');
    const body = el('div', 'pst-pub-body');
    const select = el('select');
    select.addEventListener('change', drawBody);

    function drawTypeRow() {
      typeRow.replaceChildren();
      [['style', tr('presets.pub.typeStyle')], ['command', tr('presets.typeCommand')]].forEach(([k, label]) => {
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
          el('p', 'wb-hint', tr('presets.pub.styleHint')),
          styleStage(currentStyle(), tr('common.streamer'))
        );
        submit.disabled = false;
      } else if (!cmds.length) {
        body.appendChild(el('p', 'wb-hint', tr('presets.pub.noCmds')));
        submit.disabled = true;
      } else {
        const c = cmds[parseInt(select.value, 10) || 0];
        body.append(
          el('div', 'auth-label', tr('presets.pub.whichCmd')),
          select,
          el('p', 'wb-hint', tr('presets.pub.response') + ' ' + c.response)
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
        PW.toast(tr('presets.pub.done'), 'success');
        close();
        onDone && onDone();
      } catch (e) {
        err.textContent = e.message || tr('presets.pub.failed');
        err.classList.remove('hidden');
        submit.disabled = false;
      }
    });

    box.append(closeBtn, el('h3', null, tr('presets.pub.title')));
    if (!type) box.appendChild(typeRow);
    box.append(body, el('label', 'auth-label', tr('presets.pub.name')), name, el('label', 'auth-label', tr('presets.pub.desc')), desc, err, submit);

    drawTypeRow();
    await ensureCmds();
    drawBody();
    document.body.appendChild(back);
    name.focus();
  }

  window.PWPresets = { buildCard, openPublish, deleteItem, unaddItem, trash, currentStyle, applyStyle, LS_KEY };
})();