// Вместо onclick="f('a')" в разметке: data-click="f" data-arg="a".
// Работают: data-click, data-change, data-input, data-keydown, data-submit, data-blur, data-href="/путь".
// По умолчанию функция получает (arg, элемент, событие). С атрибутом data-event: (событие, arg, элемент).
(function () {
  if (window.__pwActions) return;
  window.__pwActions = true;

  function invoke(el, attr, ev) {
    const name = el.getAttribute(attr);
    const fn = name && window[name];
    if (typeof fn !== 'function') {
      console.warn('[actions] нет функции', name);
      return;
    }
    const arg = el.getAttribute('data-arg') ?? undefined;
    if (el.hasAttribute('data-event')) fn.call(el, ev, arg, el);
    else fn.call(el, arg, el, ev);
  }

  function on(type, attr) {
    document.addEventListener(type, (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest('[' + attr + ']') : null;
      if (el) invoke(el, attr, ev);
    });
  }

  on('click', 'data-click');
  on('change', 'data-change');
  on('input', 'data-input');
  on('keydown', 'data-keydown');
  on('submit', 'data-submit');
  on('focusout', 'data-blur'); // blur не всплывает, focusout всплывает

  document.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('[data-href]') : null;
    if (el) location.href = el.getAttribute('data-href');
  });

  // Предзагрузка страницы при наведении (65 мс) или нажатии: пока человек дотягивается до клика,
  // HTML уже едет с сервера (каждый запрос к нему — полсекунды и больше). Ссылки <a>, кнопки data-href
  // и меню data-click="navigateWithFade". Только свои страницы, без /api и /media; каждая — один раз.
  const prefetched = new Set();
  const PREFETCH_SKIP = /^\/(?:api|media|socket\.io|vendor|locales|overlay|debug-screenshots)\//;
  function targetUrl(el) {
    let href = null;
    if (el.hasAttribute('data-href')) href = el.getAttribute('data-href');
    else if (el.getAttribute('data-click') === 'navigateWithFade') href = el.getAttribute('data-arg');
    else if (el.tagName === 'A' && !el.hasAttribute('download') && !el.target) href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#') return null;
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin || PREFETCH_SKIP.test(u.pathname)) return null;
      u.hash = '';
      if (u.href === location.href.split('#')[0]) return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }
  function prefetch(el) {
    const url = targetUrl(el);
    if (!url || prefetched.has(url) || prefetched.size > 30) return;
    prefetched.add(url);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'document';
    link.href = url;
    document.head.appendChild(link);
  }
  const canPrefetch = (() => {
    const c = navigator.connection;
    if (c && (c.saveData || /2g/.test(c.effectiveType || ''))) return false;
    const l = document.createElement('link');
    return !!(l.relList && l.relList.supports && l.relList.supports('prefetch'));
  })();
  if (canPrefetch) {
    const SEL = 'a[href],[data-href],[data-click="navigateWithFade"]';
    let hoverTimer = null;
    document.addEventListener('pointerover', (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest(SEL) : null;
      clearTimeout(hoverTimer);
      if (el) hoverTimer = setTimeout(() => prefetch(el), 65);
    }, { passive: true });
    document.addEventListener('pointerdown', (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest(SEL) : null;
      if (el) prefetch(el);
    }, { passive: true });
  }
})();