// Подсказка команд модерации у поля чата (студия и страница канала): набрали «/» — список команд, которые мне можно
// по правам из chat:role. Выполняет их сервер (chatSocket → slashCommand), ответ приходит событием chat:cmd-result.
// После команды с ником («/ban », «/SP+ ») от 3 символов — подсказка ников (chat:user-search: сначала те, кто в чате).
// ↑/↓ — выбрать, Tab/Enter — подставить, Esc — закрыть
(function () {
  if (window.PWChatSlash) return;

  // [команда, право, ключ словаря, как вставить] — те же, что SLASH_PERM в sockets/chatSocket.js.
  // 'points' (/SP+ /SP-) есть только у владельца канала
  const CMDS = [
    ['ban', 'ban'], ['unban', 'ban'], ['timeout', 'timeout'], ['untimeout', 'timeout'], ['clear', 'clearChat'],
    ['slow', 'chatSettings'], ['slowoff', 'chatSettings'], ['followers', 'chatSettings'], ['followersoff', 'chatSettings'],
    ['filter', 'chatSettings'], ['raid', 'raid'], ['unraid', 'raid'], ['title', 'editTitle'],
    ['sp+', 'points', 'spAdd', 'SP+'], ['sp-', 'points', 'spSub', 'SP-'],
  ];
  const keyOf = (name) => (CMDS.find((c) => c[0] === name) || [])[2] || name;
  // команды, первый аргумент которых — ник: «/ban @ник», «/SP+ ник»
  const USER_CMD_RE = /^\/(ban|unban|timeout|untimeout|sp\+|sp-)\s+@?([^\s@]{3,32})$/i;
  const tr = (k, v) => (window.t ? window.t('common.slash.' + k, v) : k);
  const needsArgs = (name) => tr(keyOf(name) + '.use').includes('<');

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
      .pw-slash-row span { font-size: 12px; color: var(--text-muted); line-height: 1.35; }
      .pw-slash-user { display: flex; align-items: center; gap: 8px; }
      .pw-slash-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success, #22c55e); flex: none; }`;
    document.head.appendChild(st);
  }

  // input — поле чата; getPerms() — мои права в этом чате (пусто — подсказки нет);
  // opts.socket() — сокет чата /chat (для подсказки ников; без него ники не подсказываются)
  function attach(input, getPerms, opts = {}) {
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
    let mode = 'cmd'; // 'cmd' — список команд, 'user' — список ников
    let sel = 0;
    let userTimer = null;
    let userSeq = 0;
    let userQuery = '';
    let users = [];

    const close = () => { box.hidden = true; items = []; };

    function row(i, build) {
      const r = document.createElement('button');
      r.type = 'button';
      r.tabIndex = -1;
      r.className = 'pw-slash-row' + (i === sel ? ' on' : '');
      build(r);
      r.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); }); // mousedown — поле не теряет фокус
      return r;
    }

    function show(headKey, rows) {
      box.replaceChildren();
      const head = document.createElement('div');
      head.className = 'pw-slash-head';
      head.textContent = tr(headKey);
      box.append(head, ...rows);
      box.hidden = false;
      box.querySelector('.pw-slash-row.on')?.scrollIntoView({ block: 'nearest' });
    }

    // ники с сервера: с задержкой (пока печатают — не спрашиваем), ответ на устаревший запрос не показываем
    function askUsers(q) {
      const sock = typeof opts.socket === 'function' ? opts.socket() : null;
      if (!sock || q === userQuery) return;
      userQuery = q;
      clearTimeout(userTimer);
      const seq = ++userSeq;
      userTimer = setTimeout(() => {
        sock.timeout(5000).emit('chat:user-search', { q }, (err, res) => {
          if (seq !== userSeq) return;
          users = !err && Array.isArray(res?.users) ? res.users : [];
          if (document.activeElement === input) draw();
        });
      }, 200);
    }

    function draw() {
      const perms = (typeof getPerms === 'function' && getPerms()) || [];
      if (!perms.length) return close();

      const um = USER_CMD_RE.exec(input.value);
      if (um && CMDS.some(([n, p]) => n === um[1].toLowerCase() && perms.includes(p))) {
        mode = 'user';
        const q = um[2].toLowerCase();
        askUsers(q);
        items = users.filter((u) => String(u.username).toLowerCase().startsWith(q));
        if (!items.length) return close();
        sel = Math.max(0, Math.min(sel, items.length - 1));
        return show('users', items.map((u, i) => row(i, (r) => {
          const line = document.createElement('div');
          line.className = 'pw-slash-user';
          if (u.online) {
            const dot = document.createElement('i');
            dot.className = 'pw-slash-dot';
            dot.title = tr('online');
            line.appendChild(dot);
          }
          const code = document.createElement('code');
          code.textContent = '@' + u.username;
          line.appendChild(code);
          r.appendChild(line);
        })));
      }
      userQuery = '';

      const m = /^\/(\S*)$/.exec(input.value); // только пока набирается имя команды
      if (!m) return close();
      mode = 'cmd';
      const q = m[1].toLowerCase();
      items = CMDS.filter(([n, p]) => perms.includes(p) && n.startsWith(q));
      if (!items.length) return close();
      sel = Math.max(0, Math.min(sel, items.length - 1));
      show('heading', items.map(([n], i) => row(i, (r) => {
        const code = document.createElement('code');
        code.textContent = tr(keyOf(n) + '.use');
        const desc = document.createElement('span');
        desc.textContent = tr(keyOf(n) + '.desc');
        r.append(code, desc);
      })));
    }

    function pick(i) {
      const it = items[i];
      if (!it) return;
      if (mode === 'user') input.value = input.value.replace(/@?[^\s@]*$/, '@' + it.username + ' ');
      else input.value = '/' + (it[3] || it[0]) + (needsArgs(it[0]) ? ' ' : '');
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
        if (e.key === 'Enter' && mode === 'cmd' && items.some(([n]) => n === typed) && !needsArgs(typed)) { close(); return; }
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
