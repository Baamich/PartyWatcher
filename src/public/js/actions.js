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
})();