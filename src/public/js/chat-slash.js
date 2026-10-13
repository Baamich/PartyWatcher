// Подсказка команд модерации у поля чата (студия и страница канала): набрали «/» — список команд, которые мне можно
// по правам из chat:role. Выполняет их сервер (chatSocket → slashCommand), ответ приходит событием chat:cmd-result.
// ↑/↓ — выбрать, Tab/Enter — подставить, Esc — закрыть
(function () {
  if (window.PWChatSlash) return;

  // [команда, право] — те же, что SLASH_PERM в sockets/chatSocket.js
  const CMDS = [
    ['ban', 'ban'], ['unban', 'ban'], ['timeout', 'timeout'], ['untimeout', 'timeout'], ['clear', 'clearChat'],
    ['slow', 'chatSettings'], ['slowoff', 'chatSettings'], ['followers', 'chatSettings'], ['followersoff', 'chatSettings'],
    ['filter', 'chatSettings'], ['raid', 'raid'], ['unraid', 'raid'], ['title', 'editTitle'],
  ];
  const tr = (k, v) => (window.t ? window.t('common.slash.' + k, v) : k);
  const needsArgs = (name) => tr(name + '.use').includes('<');

  function injectCss() {
    if (document.getElementById('pw-slash-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-slash-css';
    st.textContent = `
      .pw-slash-host { position: relative; }
      .pw-slash { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 40; max-height: 280px; overflow-y: auto;
        padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow); }
      .pw-slash[hidden] { display: none; }
      .pw-slash-head { padding: 4px 8px 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
      [data-theme] .pw-slash .pw-slash-row { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; margin: 0;
        padding: 6px 8px; background: transparent; box-shadow: none; border: 0; border-radius: 6px; color: var(--text); text-align: left; font-weight: 400; }
      [data-theme] .pw-slash .pw-slash-row.on, [data-theme] .pw-slash .pw-slash-row:hover { background: var(--surface-alt); transform: none; }
      .pw-slash-row code { font-size: 13px; font-weight: 700; color: var(--accent-text); background: none; padding: 0; }
      .pw-slash-row span { font-size: 12px; color: var(--text-muted); line-height: 1.35; }`;
    document.head.appendChild(st);
  }

  // input — поле чата; getPerms() — мои права в этом чате (пусто — подсказки нет)
  function attach(input, getPerms) {
    if (!input || input.dataset.slash) return null;
    input.dataset.slash = '1';
    injectCss();
    const host = input.parentElement;
    host.classList.add('pw-slash-host');
    const box = document.createElement('div');
    box.className = 'pw-slash';
    box.hidden = true;
    box.setAttribute('data-no-i18n', ''); // текст рисуем сами через t() — переводчик разметки не нужен
    host.appendChild(box);
    let items = [];
    let sel = 0;

    const close = () => { box.hidden = true; items = []; };

    function draw() {
      const m = /^\/(\S*)$/.exec(input.value); // только пока набирается имя команды
      const perms = (typeof getPerms === 'function' && getPerms()) || [];
      if (!m || !perms.length) return close();
      const q = m[1].toLowerCase();
      items = CMDS.filter(([n, p]) => perms.includes(p) && n.startsWith(q));
      if (!items.length) return close();
      sel = Math.max(0, Math.min(sel, items.length - 1));
      box.replaceChildren();
      const head = document.createElement('div');
      head.className = 'pw-slash-head';
      head.textContent = tr('heading');
      box.appendChild(head);
      items.forEach(([n], i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.tabIndex = -1;
        row.className = 'pw-slash-row' + (i === sel ? ' on' : '');
        const code = document.createElement('code');
        code.textContent = tr(n + '.use');
        const desc = document.createElement('span');
        desc.textContent = tr(n + '.desc');
        row.append(code, desc);
        row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); }); // mousedown — поле не теряет фокус
        box.appendChild(row);
      });
      box.hidden = false;
      box.querySelector('.pw-slash-row.on')?.scrollIntoView({ block: 'nearest' });
    }

    function pick(i) {
      const it = items[i];
      if (!it) return;
      input.value = '/' + it[0] + (needsArgs(it[0]) ? ' ' : '');
      close();
      input.focus();
    }

    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('focus', draw);
    input.addEventListener('blur', () => setTimeout(close, 120));
    // capture: срабатывает раньше отправки сообщения по Enter (форма канала, обработчик студии)
    input.addEventListener('keydown', (e) => {
      if (box.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        const typed = input.value.slice(1).toLowerCase();
        // команда без обязательных аргументов уже набрана целиком (/clear) — Enter отправляет её как есть
        if (e.key === 'Enter' && items.some(([n]) => n === typed) && !needsArgs(typed)) { close(); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(sel);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }, true);
    window.addEventListener('pw:langchange', () => { if (!box.hidden) draw(); });
    return { refresh: draw, close };
  }

  window.PWChatSlash = { attach, CMDS };
})();
