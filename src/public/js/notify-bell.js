// 🔔 Окно уведомлений (кнопку и кружок с числом ставит js/api.js — pwBell). Загружается в простое.
// Список — GET /api/notifications по 10, свежие сверху; дальше — при прокрутке (before = время последнего).
// Открыли окно — всё прочитано (open=1), новые до этого момента выделены цветом, пока окно открыто.
// Повторное открытие без новых — без запроса: первая страница лежит в памяти и в sessionStorage вкладки.
// Число непрочитанных приходит с опросом эфиров (js/live-notify.js → событие pw:notif); где его нет — спрашиваем сами
(function () {
  if (window.PWBell) return;

  const PAGE = 10;
  const CACHE_KEY = 'pw-nf';
  const CACHE_TTL = 10 * 60 * 1000;
  const COUNT_STALE = 75 * 1000; // число старше — спросим сами (опрос эфиров раз в минуту обычно успевает раньше)
  const tr = (k, v) => (window.t ? window.t(k, v) : k);
  const has = (k) => !!(window.I18N && window.I18N.has && window.I18N.has(k));

  let panel = null;
  let listEl = null;
  let sentinel = null;
  let observer = null;
  let items = [];
  let more = false;
  let loading = false;
  let seenAt = Infinity; // мс: что новее — выделено (пока окно открыто)
  let isOpen = false;
  let unread = (window.__pwNotif && window.__pwNotif.n) || 0;
  let countAt = (window.__pwNotif && window.__pwNotif.at) || Date.now();
  let stopped = false;

  const bell = () => document.getElementById('pwBell');
  const userOf = () => (bell() && bell().dataset.user) || '';

  (function css() {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/css/notify-bell.css?v=1';
    document.head.appendChild(l);
  })();

  // ---------- кэш первой страницы (только эта вкладка и только этот аккаунт) ----------
  function readCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.u === userOf() && Date.now() - c.at < CACHE_TTL && Array.isArray(c.items)) return c;
    } catch (_) {}
    return null;
  }
  function writeCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ u: userOf(), at: Date.now(), items: items.slice(0, PAGE), more: items.length > PAGE || more }));
    } catch (_) {}
  }

  // ---------- число на кружке ----------
  function setUnread(n) {
    if (typeof n !== 'number') return;
    const grew = n > unread;
    unread = n;
    countAt = Date.now();
    if (window.pwBellCount) window.pwBellCount(n);
    if (isOpen && grew && n > 0) loadFirst(); // пришло новое, пока окно открыто
  }
  async function refreshCount() {
    if (stopped || !userOf()) return;
    try {
      const r = await api('/notifications/count');
      setUnread(r.unread);
    } catch (e) {
      if (e.status === 401) stopped = true;
    }
  }
  window.addEventListener('pw:notif', (e) => setUnread(e.detail && e.detail.unread));
  setInterval(() => {
    if (!document.hidden && Date.now() - countAt > COUNT_STALE) refreshCount();
  }, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - countAt > 30 * 1000) refreshCount();
  });

  // ---------- тексты ----------
  const ICONS = {
    news: '📰', 'news.important': '❗', system: '👋', support: '💬', security: '🔒', room: '🏠',
    'channel.follow': '❤️', 'channel.clip': '🎬', chat: '🛡️', preset: '🧩',
  };
  const iconOf = (type) => ICONS[type] || ICONS[type.split('.')[0]] || '🔔';

  function countryName(code) {
    try {
      return new Intl.DisplayNames([window.I18N ? I18N.locale : 'ru'], { type: 'region' }).of(code) || code;
    } catch (_) {
      return code;
    }
  }

  function textsOf(x) {
    const v = Object.assign({}, x.vars || {});
    // подстановки, которых нет в записи, — пустые: иначе в тексте осталось бы «{name}»
    for (const k of ['name', 'topic', 'title', 'channel', 'preset', 'device', 'from', 'to', 'n', 'h']) if (v[k] == null) v[k] = '';
    if (!v.device) v.device = tr('common.notify.unknownDevice');
    v.where = v.country ? ' (' + countryName(v.country) + ')' : '';
    v.levelText = v.level ? tr('common.notify.level.' + v.level) : '';
    const base = 'common.notify.type.' + x.type;
    if (!has(base + '.title')) return { title: tr('common.notify.generic'), text: '' };
    const text = x.count > 1 && has(base + '.many') ? tr(base + '.many', Object.assign({}, v, { n: x.count - 1 })) : tr(base + '.text', v);
    // почему на сайт, а не письмом (лимит писем / сбой) — отдельной строкой
    const note = v.fb && has('common.notify.fb.' + v.fb) ? tr('common.notify.fb.' + v.fb) : '';
    return { title: tr(base + '.title', v), text, note };
  }

  function ago(d) {
    const sec = Math.round((new Date(d).getTime() - Date.now()) / 1000);
    const loc = window.I18N ? I18N.locale : 'ru';
    try {
      const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
      const a = Math.abs(sec);
      if (a < 60) return tr('common.notify.justNow');
      if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
      if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
      if (a < 7 * 86400) return rtf.format(Math.round(sec / 86400), 'day');
    } catch (_) {}
    return new Date(d).toLocaleDateString(loc, { day: 'numeric', month: 'short' });
  }

  // только свои адреса сайта (/…), никаких javascript: и чужих доменов
  const safeLink = (l) => (typeof l === 'string' && /^\/(?!\/)/.test(l) ? l : null);

  function go(link) {
    close();
    const url = new URL(link, location.origin);
    // тот же адрес с другим #… (профиль, новости) — страница сама откроет нужное по hashchange
    if (url.pathname === location.pathname && url.search === location.search) location.hash = url.hash;
    else location.href = link;
  }

  // ---------- окно ----------
  function build() {
    panel = document.createElement('div');
    panel.className = 'pw-nf hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', tr('common.notify.title'));
    panel.setAttribute('data-no-i18n', ''); // в списке чужой текст (темы, ники) — перерисуем сами по pw:langchange
    panel.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'pw-nf-head';
    const title = document.createElement('b');
    title.className = 'pw-nf-title';
    const settings = document.createElement('a');
    settings.className = 'pw-nf-settings';
    head.append(title, settings);

    listEl = document.createElement('div');
    listEl.className = 'pw-nf-list';
    sentinel = document.createElement('div');
    sentinel.className = 'pw-nf-sentinel';

    panel.append(head, listEl);
    document.body.appendChild(panel);
    paintHead();

    // подгрузка следующей страницы, когда низ списка показался
    observer = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) loadMore();
    }, { root: listEl, rootMargin: '120px' });

    settings.addEventListener('click', (e) => {
      e.preventDefault();
      go(settings.getAttribute('href'));
    });
    document.addEventListener('mousedown', (e) => {
      if (isOpen && !panel.contains(e.target) && !(bell() && bell().contains(e.target))) close();
    });
    document.addEventListener('keydown', (e) => {
      if (isOpen && e.key === 'Escape') {
        close();
        if (bell()) bell().focus();
      }
    });
    window.addEventListener('resize', () => isOpen && place());
    window.addEventListener('pw:langchange', () => {
      if (!panel) return;
      paintHead();
      render();
    });
  }

  function paintHead() {
    panel.querySelector('.pw-nf-title').textContent = tr('common.notify.title');
    const s = panel.querySelector('.pw-nf-settings');
    s.textContent = tr('common.notify.settings');
    s.href = '/u/' + encodeURIComponent(userOf().toLowerCase()) + '#notifications';
    panel.setAttribute('aria-label', tr('common.notify.title'));
  }

  // под колокольчиком, правым краем к нему; на узком экране — во всю ширину
  function place() {
    const b = bell();
    if (!b) return;
    const r = b.getBoundingClientRect();
    const w = window.innerWidth;
    panel.style.top = Math.round(r.bottom + 8) + 'px';
    if (w < 480) {
      panel.style.left = '8px';
      panel.style.right = '8px';
    } else {
      panel.style.left = 'auto';
      panel.style.right = Math.max(8, Math.round(w - r.right)) + 'px';
    }
    panel.style.maxHeight = Math.max(200, window.innerHeight - r.bottom - 24) + 'px';
  }

  function itemEl(x) {
    const fresh = new Date(x.at).getTime() > seenAt;
    const { title, text, note } = textsOf(x);
    const link = safeLink(x.link);

    const el = document.createElement('div');
    el.className = 'pw-nf-item' + (fresh ? ' pw-nf-item--new' : '') + (link ? ' pw-nf-item--link' : '');

    const icon = document.createElement('span');
    icon.className = 'pw-nf-icon';
    icon.textContent = iconOf(x.type);
    icon.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'pw-nf-body';
    const t1 = document.createElement('div');
    t1.className = 'pw-nf-item-title';
    t1.textContent = title;
    if (fresh) {
      const badge = document.createElement('span');
      badge.className = 'pw-nf-new';
      badge.textContent = tr('common.notify.new');
      t1.appendChild(badge);
    }
    body.appendChild(t1);
    if (text) {
      const t2 = document.createElement('div');
      t2.className = 'pw-nf-text';
      t2.textContent = text;
      body.appendChild(t2);
    }
    if (note) {
      const t3 = document.createElement('div');
      t3.className = 'pw-nf-note';
      t3.textContent = note;
      body.appendChild(t3);
    }
    const meta = document.createElement('div');
    meta.className = 'pw-nf-meta';
    const time = document.createElement('time');
    time.dateTime = new Date(x.at).toISOString();
    time.title = new Date(x.at).toLocaleString(window.I18N ? I18N.locale : 'ru');
    time.textContent = ago(x.at);
    meta.appendChild(time);
    if (link) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-nf-go';
      btn.textContent = tr('common.notify.go');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        go(link);
      });
      meta.appendChild(btn);
      el.addEventListener('click', () => go(link));
    }
    body.appendChild(meta);
    el.append(icon, body);
    return el;
  }

  function render() {
    if (!listEl) return;
    observer.unobserve(sentinel);
    listEl.replaceChildren(...items.map(itemEl));
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'pw-nf-empty';
      empty.textContent = loading ? tr('common.loading') : tr('common.notify.empty');
      listEl.appendChild(empty);
    }
    listEl.appendChild(sentinel);
    sentinel.classList.toggle('pw-nf-sentinel--loading', more);
    if (more) observer.observe(sentinel);
  }

  // первая страница: окно открыто — всё прочитано; seenAt — прежняя метка (новее неё выделяем)
  async function loadFirst() {
    loading = true;
    if (!items.length) render();
    try {
      const r = await api('/notifications?limit=' + PAGE + '&open=1');
      items = r.items || [];
      more = !!r.more;
      seenAt = new Date(r.seenAt).getTime() || 0;
      setUnread(0);
      // вшитый в страницу ответ /auth/me (api.js) ещё минуту отдаётся без запроса — в нём тоже уже прочитано
      try {
        if (typeof pwBoot !== 'undefined' && pwBoot && pwBoot.data && pwBoot.data.me) pwBoot.data.me.notif = 0;
      } catch (_) {}
      writeCache();
    } catch (e) {
      if (!items.length) {
        loading = false;
        listEl.replaceChildren();
        const err = document.createElement('div');
        err.className = 'pw-nf-empty';
        err.textContent = e.message || tr('common.requestFailed');
        listEl.appendChild(err);
        return;
      }
    } finally {
      loading = false;
    }
    render();
  }

  async function loadMore() {
    if (loading || !more || !items.length) return;
    loading = true;
    try {
      const last = new Date(items[items.length - 1].at).getTime();
      const r = await api('/notifications?limit=' + PAGE + '&before=' + last);
      const known = new Set(items.map((x) => x.id));
      items = items.concat((r.items || []).filter((x) => !known.has(x.id)));
      more = !!r.more && (r.items || []).length > 0;
    } catch (_) {
      more = false;
    } finally {
      loading = false;
    }
    render();
  }

  function open() {
    if (!userOf()) return;
    if (!panel) build();
    isOpen = true;
    panel.classList.remove('hidden');
    place();
    if (bell()) bell().setAttribute('aria-expanded', 'true');
    const cached = !items.length && readCache();
    if (cached) {
      items = cached.items;
      more = cached.more;
    }
    if (unread > 0 || !items.length) {
      // есть новые или ещё нечего показать: пока ждём ответ — то, что уже знаем, без выделения
      if (items.length) {
        seenAt = Infinity;
        render();
      }
      loadFirst();
    } else {
      seenAt = Infinity; // новых нет — запроса нет, всё как прочитанное
      render();
    }
    panel.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.add('hidden');
    if (bell()) bell().setAttribute('aria-expanded', 'false');
    // при следующем открытии выделенное станет обычным
    seenAt = Infinity;
  }

  window.PWBell = {
    toggle: () => (isOpen ? close() : open()),
    open,
    close,
    refresh: refreshCount,
  };
})();
