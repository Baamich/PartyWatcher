// GET /auth/me без запроса: сервер кладёт ответ в <script type="application/json" id="pw-boot"> (services/pages.js).
// Годится, пока на странице не было запросов, меняющих данные (вход, выход, настройки) и не прошла минута.
// Нет блока (упреждающая загрузка, старая страница) — обычный запрос
const pwBoot = (() => {
  try {
    const el = document.getElementById('pw-boot');
    return el ? { data: JSON.parse(el.textContent), until: Date.now() + 60000 } : null;
  } catch (_) {
    return null;
  }
})();

function bootMe() {
  if (!pwBoot || Date.now() > pwBoot.until) return null;
  const d = pwBoot.data;
  if (d.me) return Promise.resolve(JSON.parse(JSON.stringify(d.me))); // копия: вызывающий может её менять
  const err = new Error(d.error || 'Unauthorized');
  err.status = 401;
  return Promise.reject(err);
}

// Условия пользования не приняты или изменились (me.termsOk === false) — окно js/terms-gate.js на любой странице,
// кроме самой страницы условий. Сервер в это время не принимает запросы, меняющие данные (403, code: 'terms')
let pwTermsGateLoading = null;
function pwTermsGate(me) {
  if (/^\/terms(\.html)?$/.test(location.pathname)) return;
  // свой профиль открывается без окна: удалить аккаунт можно и не принимая новые условия (POST /auth/delete)
  if (me && /^\/u\//.test(location.pathname)) return;
  if (!pwTermsGateLoading) {
    pwTermsGateLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/terms-gate.js?v=1';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  pwTermsGateLoading.then(() => window.PWTermsGate && window.PWTermsGate.show(me || {})).catch(() => { pwTermsGateLoading = null; });
}
function pwWatchMe(me) {
  if (me && me.termsOk === false) pwTermsGate(me);
  pwShowMe(me);
  return me;
}
document.addEventListener('DOMContentLoaded', () => {
  if (pwBoot && pwBoot.data && pwBoot.data.me) pwWatchMe(pwBoot.data.me);
  else if (pwBoot) pwShowMe(null); // гость — кнопка «Войти» вместо ника
  // нет вшитого ответа (упреждающая загрузка) — спросим сами, чтобы показать ник в шапке
  else if (document.getElementById('meLink')) api('/auth/me').catch(() => pwShowMe(null));
});

// ник в шапке (#meLink > #meName) — кнопка «Мой профиль» (/u/<ник>); гостю на её месте — «Войти»
// (страница /login, после входа — обратно сюда). Показывается сама после любого /auth/me
const pwProfileHref = (name) => '/u/' + encodeURIComponent(String(name).toLowerCase());
function pwLoginLink(link, show) {
  let a = document.getElementById('pwLoginLink');
  if (!show) {
    if (a) a.classList.add('hidden');
    return;
  }
  if (!a) {
    a = document.createElement('a');
    a.id = 'pwLoginLink';
    a.className = 'icon-btn pw-login';
    a.setAttribute('data-i18n', 'common.header.login');
    a.textContent = window.t ? t('common.header.login') : 'Sign in';
    link.parentNode.insertBefore(a, link);
  }
  a.href = '/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
  a.classList.remove('hidden');
}
function pwShowMe(me) {
  pwBell(me);
  const link = document.getElementById('meLink');
  if (!link) return;
  const name = me && me.username;
  link.classList.toggle('hidden', !name);
  pwLoginLink(link, !name);
  if (!name) return;
  link.href = pwProfileHref(name);
  const el = document.getElementById('meName');
  if (el) el.textContent = name;
}

// 🔔 колокольчик уведомлений рядом с ником (на страницах без ника — перед кнопкой темы). Кнопка и кружок
// с числом — сразу (шапка не прыгает), окно со списком и опрос — js/notify-bell.js, загружается в простое
const PW_BELL_JS = '/js/notify-bell.js?v=1';
let pwBellLoading = null;
function pwBellLoad() {
  if (!pwBellLoading) {
    pwBellLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PW_BELL_JS;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => { pwBellLoading = null; });
  }
  return pwBellLoading;
}
// число на кружке (0 — кружка нет); вызывает и js/notify-bell.js
function pwBellCount(n) {
  const badge = document.querySelector('#pwBell .pw-bell-badge');
  if (!badge || typeof n !== 'number') return;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n <= 0);
  document.getElementById('pwBell').classList.toggle('pw-bell--on', n > 0);
}
function pwBell(me) {
  let btn = document.getElementById('pwBell');
  if (!me || !me.username) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    const host = document.getElementById('meLink') || document.querySelector('.corner-menu .theme-toggle, .header-right .theme-toggle, .theme-toggle');
    if (!host || !host.parentNode) return;
    const label = window.t ? t('common.notify.title') : 'Notifications';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pwBell';
    btn.className = 'icon-btn pw-bell';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('data-i18n-title', 'common.notify.title');
    btn.setAttribute('data-i18n-aria-label', 'common.notify.title');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'
      + '<span class="pw-bell-badge hidden" data-no-i18n></span>';
    host.parentNode.insertBefore(btn, host);
    btn.addEventListener('click', () => pwBellLoad().then(() => window.PWBell && window.PWBell.toggle()));
    if ('requestIdleCallback' in window) requestIdleCallback(pwBellLoad, { timeout: 4000 });
    else setTimeout(pwBellLoad, 1500);
  }
  btn.dataset.user = me.username; // ссылка «Настройки» в окне и кэш списка — по аккаунту
  if (typeof me.notif === 'number') {
    window.__pwNotif = { n: me.notif, at: Date.now() };
    // окно (если уже загружено) узнаёт о новых: при открытии перечитает список, а не покажет кэш
    window.dispatchEvent(new CustomEvent('pw:notif', { detail: { unread: me.notif } }));
  }
  pwBellCount(me.notif);
}

// баннер согласия на статистику (js/consent.js) — пока человек не выбрал; на /datenschutz он сам решает, когда показать
document.addEventListener('DOMContentLoaded', () => {
  if (/(?:^|;\s*)pw_consent=/.test(document.cookie) || /^\/datenschutz/.test(location.pathname)) return;
  const s = document.createElement('script');
  s.src = '/js/consent.js?v=1';
  s.async = true;
  document.head.appendChild(s);
});

// id устройства (cookie pw_dev) для статистики и банов: считается один раз, в простое — загрузку не тормозит
(function () {
  if (/(?:^|;\s*)pw_dev=1\./.test(document.cookie)) return;
  const load = () => {
    const s = document.createElement('script');
    s.src = '/js/device.js?v=1';
    s.async = true;
    document.head.appendChild(s);
  };
  if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 5000 });
  else setTimeout(load, 2000);
})();

async function api(path, options = {}) {
  const opts = { ...options };
  const method = String(opts.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    if (pwBoot) pwBoot.until = 0;
  } else if (path === '/auth/me') {
    const hit = bootMe();
    if (hit) return hit.then(pwWatchMe);
  }

  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data.code === 'terms') pwTermsGate();
    const err = new Error(data.error || (window.t ? t('common.requestFailed') : 'Request failed'));
    err.status = res.status; // текст ошибки переведён, поэтому проверяем код, а не слова
    err.code = data.code;
    err.retryIn = data.retryIn; // секунды до повтора (письма: «Отправить ещё раз» с отсчётом)
    throw err;
  }
  if (path === '/auth/me') pwWatchMe(data);
  return data;
}
