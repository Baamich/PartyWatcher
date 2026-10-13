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
  return me;
}
document.addEventListener('DOMContentLoaded', () => {
  if (pwBoot && pwBoot.data && pwBoot.data.me) pwWatchMe(pwBoot.data.me);
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
    throw err;
  }
  if (path === '/auth/me') pwWatchMe(data);
  return data;
}
