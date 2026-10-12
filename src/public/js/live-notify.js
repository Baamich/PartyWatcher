// Уведомление «вышел в эфир» от подписок: справа сверху на любой странице сайта.
// Раз в минуту (только в видимой вкладке) спрашиваем, кто из подписок в эфире. Показываем эфиры, начавшиеся
// не раньше 15 минут назад и ещё не показанные (метки — в localStorage, общие для вкладок).
// Гостю сервер отвечает { guest: true } — дальше не спрашиваем
(function () {
  if (window.__pwLiveNotify) return;
  window.__pwLiveNotify = true;

  const POLL_MS = 60 * 1000;
  const FRESH_MS = 15 * 60 * 1000;
  const SHOW_MS = 15 * 1000;
  const SEEN_KEY = 'pw-live-seen';
  let stopped = false;
  let stack = null;

  const tr = (k, v) => (window.t ? window.t(k, v) : k);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeSeen(map) {
    const keep = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 100); // хватит с запасом
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(keep))); } catch {}
  }

  function ensureStack() {
    if (stack) return stack;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/css/live-notify.css?v=1';
    document.head.appendChild(css);
    stack = document.createElement('div');
    stack.className = 'pw-ln-stack';
    stack.setAttribute('data-no-i18n', ''); // имя и текст стримера не переводим
    document.body.appendChild(stack);
    return stack;
  }

  function catName(c) {
    return (window.I18N?.lang === 'ru' && c?.ru) || c?.name || '';
  }

  function show(x) {
    const box = ensureStack();
    while (box.children.length >= 3) box.firstElementChild.remove();
    const href = '/streamers/' + encodeURIComponent(x.streamerName.toLowerCase());
    const card = document.createElement('div');
    card.className = 'pw-ln-card';
    const text = x.notice || x.title || '';
    card.innerHTML = `
      <a class="pw-ln-main" href="${href}">
        <span class="pw-ln-avatar">${x.avatarUrl ? `<img src="${esc(x.avatarUrl)}" alt="" />` : esc(x.streamerName.charAt(0).toUpperCase())}</span>
        <span class="pw-ln-text">
          <span class="pw-ln-head"><b>${esc(x.streamerName)}</b> <span class="pw-ln-live">${esc(tr('common.liveNotify.live'))}</span></span>
          ${text ? `<span class="pw-ln-notice">${esc(text)}</span>` : ''}
          ${x.category ? `<span class="pw-ln-cat">${esc(catName(x.category))}</span>` : ''}
          <span class="pw-ln-watch">${esc(tr('common.liveNotify.watch'))} ›</span>
        </span>
      </a>
      <button type="button" class="pw-ln-close" aria-label="${esc(tr('common.close'))}">×</button>`;
    const close = () => {
      card.classList.add('out');
      setTimeout(() => card.remove(), 250);
    };
    card.querySelector('.pw-ln-close').addEventListener('click', close);
    // не прячем, пока на уведомление навели мышь
    let timer = setTimeout(close, SHOW_MS);
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', () => { timer = setTimeout(close, SHOW_MS / 2); });
    box.appendChild(card);
  }

  async function poll() {
    if (stopped || document.hidden) return;
    let d;
    try {
      const r = await fetch('/api/streams/live-follows', { credentials: 'include' });
      if (!r.ok) return;
      d = await r.json();
    } catch {
      return;
    }
    if (d.guest) { stopped = true; return; }
    const seen = readSeen();
    const now = Date.now();
    const here = location.pathname.toLowerCase();
    let changed = false;
    for (const x of d.list || []) {
      const started = new Date(x.startedAt).getTime();
      const id = x.streamerName.toLowerCase() + '@' + started;
      if (seen[id]) continue;
      seen[id] = now;
      changed = true;
      if (now - started > FRESH_MS) continue; // эфир идёт давно — это не «только что вышел»
      if (here === '/streamers/' + encodeURIComponent(x.streamerName.toLowerCase())) continue; // и так на его странице
      show(x);
    }
    if (changed) writeSeen(seen);
  }

  function start() {
    setTimeout(poll, 1500); // не мешаем загрузке страницы
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
