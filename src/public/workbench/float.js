// Мини-пульт стримера: кнопка «📌 Мини-пульт стримера» (js/pw-float.js), обычное маленькое окно или док в OBS
// (Docks → Custom Browser Docks → https://partywatcher.de/workbench/float.html). Время эфира, зрители, подписчики,
// чат канала (писать и /команды), кнопки виджетов и лента событий. Нужен вход стримером
(function () {
  const C = window.PWWidgetCatalog;
  const AC = window.PWAlertCatalog;
  const $ = (id) => document.getElementById(id);
  let st = { widgets: [], live: null, stats: null, channel: null };
  let chat = null;
  let perms = [];
  let tab = 'chat';
  let unseen = 0;

  function showMsg(key, link) {
    const box = $('flMsg');
    box.replaceChildren();
    const p = document.createElement('p');
    p.textContent = t(key);
    box.appendChild(p);
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'icon-btn';
      a.textContent = t(link.key);
      box.appendChild(a);
    }
    box.hidden = false;
  }

  // ---------- вкладки ----------
  document.querySelectorAll('.fl-tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.fl-tab').forEach((x) => x.classList.toggle('on', x === b));
    $('flChat').hidden = tab !== 'chat';
    $('flWidgets').hidden = tab !== 'widgets';
    $('flEvents').hidden = tab !== 'events';
    if (tab === 'events') { unseen = 0; drawBadge(); }
    if (tab === 'chat') scrollChat(true);
  }));
  function drawBadge() {
    const b = $('flEvBadge');
    b.hidden = !unseen;
    b.textContent = unseen > 9 ? '9+' : String(unseen);
  }

  // ---------- шапка: время эфира и числа ----------
  function drawTop() {
    const live = st.live;
    const on = !!(live?.isLive && live.startedAt);
    $('flLive').textContent = t(on ? 'widgets.float.live' : 'widgets.float.offline');
    $('flLive').classList.toggle('on', on);
    $('flUptime').textContent = on ? C.fmtDuration(PWWidgetRender.serverNow() - live.startedAt) : '';
    const fmt = (n) => Number(n || 0).toLocaleString(window.I18N?.locale);
    $('flViewers').textContent = fmt(st.stats?.viewers);
    $('flFollowers').textContent = fmt(st.stats?.followers);
  }
  setInterval(drawTop, 1000);

  // ---------- виджеты: только те, которыми управляют ----------
  const CONTROLLED = ['countdown', 'stopwatch', 'counter', 'goal', 'text', 'ticker', 'credits', 'custom'];
  const ctl = new Map(); // id → { controls, optsKey }
  function drawWidgets() {
    const box = $('flWidgets');
    const ctlText = (w) => (w.opts.lines || []).map((l) => l.text).join(' ') + (w.opts.barValue || '');
    const list = st.widgets.filter((w) => CONTROLLED.includes(w.type) && !(w.type === 'goal' && w.opts.source !== 'manual')
      && !(w.type === 'custom' && !/\{(n|text|random|choice|dice|coin)\b/.test(ctlText(w))));
    if (!list.length) {
      ctl.clear();
      box.replaceChildren();
      const p = document.createElement('p');
      p.className = 'fl-empty';
      p.textContent = t('widgets.float.noWidgets');
      const a = document.createElement('a');
      a.href = '/workbench/widgets.html';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t('widgets.float.toStudio');
      box.append(p, a);
      return;
    }
    // порядок и состав поменялись — собираем заново, иначе только обновляем
    const ids = list.map((w) => w.id + ':' + JSON.stringify(w.opts)).join('|');
    if (box.dataset.ids !== ids) {
      box.dataset.ids = ids;
      box.replaceChildren();
      ctl.clear();
      for (const w of list) {
        const card = document.createElement('div');
        card.className = 'fl-wcard';
        const h = document.createElement('div');
        h.className = 'fl-wtitle';
        h.setAttribute('data-no-i18n', '');
        h.textContent = (C.typeById(w.type)?.icon || '') + ' ' + (w.name || t('widgets.type.' + w.type + '.name'));
        const body = document.createElement('div');
        card.append(h, body);
        box.appendChild(card);
        const controls = PWWidgetControls.build(body, w, {
          act: (action, arg) => api('/widgets/' + w.id + '/action', { method: 'POST', body: { action, arg } }).then((r) => onWidget(r.widget)),
        });
        ctl.set(w.id, controls);
      }
    } else {
      for (const w of list) ctl.get(w.id)?.refresh(w);
    }
  }
  function onWidget(w) {
    if (!w) return;
    const i = st.widgets.findIndex((x) => x.id === w.id);
    if (i < 0) st.widgets.push(w);
    else st.widgets[i] = w;
    drawWidgets();
  }

  // ---------- события ----------
  function addEvent(ev) {
    const def = AC.eventById(ev.type);
    if (!def) return;
    const row = document.createElement('div');
    row.className = 'fl-ev';
    const time = document.createElement('span');
    time.className = 'fl-time';
    time.textContent = new Date(ev.at || Date.now()).toLocaleTimeString(window.I18N?.locale, { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('span');
    text.textContent = def.icon + ' ' + PWAlertRender.plainText(t('alerts.default.' + ev.type), ev.vars || {});
    row.append(time, text);
    const list = $('flEvList');
    list.prepend(row);
    while (list.children.length > 50) list.lastChild.remove();
    if (tab !== 'events') { unseen += 1; drawBadge(); }
  }

  // ---------- чат ----------
  const msgs = $('flMsgs');
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  const scrollChat = (force) => { if (force || nearBottom()) msgs.scrollTop = msgs.scrollHeight; };
  function autoColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
  }
  function addMsg(m, quiet) {
    if (!m || m.deleted) return;
    const stick = nearBottom();
    const row = document.createElement('div');
    row.className = 'fl-m' + (m.highlight ? ' hl' : '') + (m.system ? ' sys' : '');
    if (m._id) row.dataset.id = m._id;
    if (m.system) {
      row.textContent = m.text;
    } else if (m.streak && !m.text) {
      row.classList.add('hl');
      row.textContent = '🔥 ' + t('common.streak.shared', { n: m.streak, name: m.senderUsername });
    } else if (m.source === 'raid') {
      row.textContent = '🚀 ' + t('common.raid.message', { name: m.raid?.from || m.senderUsername, n: m.raid?.viewers ?? 0 });
    } else {
      if (m.modLevel && window.PWBadges) {
        const b = document.createElement('span');
        b.innerHTML = PWBadges.html(m.modLevel);
        if (b.firstChild) row.appendChild(b.firstChild);
      }
      const nick = document.createElement('b');
      nick.className = 'fl-nick' + (m.isOwner ? ' own' : '');
      nick.textContent = I18N.sysName(m.senderUsername) + ': ';
      if (!m.isOwner) nick.style.color = /^#[0-9a-f]{6}$/i.test(m.nickColor || '') ? m.nickColor : autoColor(String(m.senderUsername || ''));
      if (m.streak) {
        row.classList.add('hl');
        const head = document.createElement('div');
        head.textContent = '🔥 ' + t('common.streak.shared', { n: m.streak, name: m.senderUsername });
        row.prepend(head);
      }
      const text = document.createElement('span');
      const plain = String(m.text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      text.innerHTML = window.PWEmotes ? PWEmotes.render(plain, m.emotes) : plain;
      row.append(nick, text);
    }
    msgs.appendChild(row);
    while (msgs.children.length > 150) msgs.firstChild.remove();
    if (!quiet) scrollChat(stick);
  }

  function connectChat() {
    chat = io('/chat', { transports: ['websocket', 'polling'], tryAllTransports: true, reconnection: true });
    chat.on('connect', () => {
      chat.emit('lang:set', window.I18N?.lang);
      chat.emit('chat:join', { streamerName: st.channel });
    });
    chat.on('chat:history', (list) => {
      msgs.replaceChildren();
      (list || []).forEach((m) => addMsg(m, true));
      scrollChat(true);
    });
    chat.on('chat:message', (m) => addMsg(m));
    chat.on('chat:message-deleted', ({ messageId }) => msgs.querySelector('[data-id="' + CSS.escape(String(messageId)) + '"]')?.remove());
    chat.on('chat:cleared', () => msgs.replaceChildren());
    chat.on('chat:role', (r) => { perms = Array.isArray(r?.perms) ? r.perms : []; });
    chat.on('chat:cmd-result', (r) => addMsg({ system: true, text: (r?.ok ? '✓ ' : '✕ ') + (r?.text || '') }));
    window.PWChatSlash?.attach($('flInput'), () => perms, { socket: () => chat });
  }
  $('flForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('flInput');
    const text = input.value.trim();
    if (!text || !chat) return;
    chat.emit('chat:send', { text });
    input.value = '';
  });

  // ---------- старт ----------
  (async function init() {
    let d;
    try {
      d = await api('/widgets');
    } catch (err) {
      if (err.status === 401) return showMsg('widgets.float.login', { href: '/', key: 'widgets.float.loginBtn' });
      return showMsg(err.status === 403 ? 'widgets.float.noStreamer' : 'common.requestFailed');
    }
    PWWidgetRender.syncClock(d.now);
    st = { widgets: d.widgets, live: d.live, stats: d.stats, channel: d.channel };
    drawTop();
    drawWidgets();
    connectChat();
    let key;
    try {
      key = (await api('/alerts/key')).key;
    } catch (err) {
      if (err.status !== 404) return;
      key = (await api('/alerts/key', { method: 'POST' }).catch(() => ({}))).key;
    }
    if (!key) return;
    const sock = io('/alerts', { transports: ['websocket', 'polling'], tryAllTransports: true, reconnection: true });
    sock.on('connect', () => {
      sock.emit('alerts:join', { key });
      sock.emit('widget:join', { key });
    });
    sock.on('event', addEvent);
    sock.on('widget:init', (x) => {
      PWWidgetRender.syncClock(x.now);
      st.widgets = x.widgets || [];
      st.live = x.live;
      st.stats = x.stats;
      drawTop();
      drawWidgets();
    });
    sock.on('widget:update', (x) => { PWWidgetRender.syncClock(x.now); onWidget(x.widget); });
    sock.on('widget:remove', (x) => { st.widgets = st.widgets.filter((w) => w.id !== x.id); drawWidgets(); });
    sock.on('widget:stats', (x) => {
      if (x.live) st.live = x.live;
      if (x.stats) st.stats = x.stats;
      drawTop();
    });
    window.addEventListener('pw:langchange', () => {
      chat?.emit('lang:set', window.I18N?.lang);
      $('flWidgets').dataset.ids = '';
      drawWidgets();
      drawTop();
    });
  })();
})();
