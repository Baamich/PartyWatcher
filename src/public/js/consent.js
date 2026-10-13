// Баннер согласия на статистику (политика — /datenschutz). Грузит api.js, если выбора ещё нет (cookie pw_consent).
// «Принять статистику» → pw_consent=stats: сервер записывает посещения (устройство, браузер, страна) для статистики.
// «Только необходимые» → pw_consent=essential: только то, без чего сайт не работает и не защищён.
// Изменить выбор — кнопка на странице /datenschutz (PWConsent.show())
(function () {
  if (window.PWConsent) return;
  let box = null;

  function save(value) {
    const host = location.hostname;
    const domain = /(^|\.)partywatcher\.de$/i.test(host) ? '; domain=.partywatcher.de' : '';
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = 'pw_consent=' + value + '; path=/; max-age=31536000; SameSite=Lax' + domain + secure;
    window.dispatchEvent(new CustomEvent('pw:consent', { detail: { value } }));
  }

  function el(tag, cls, key) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (key) {
      e.setAttribute('data-i18n', key);
      e.textContent = t(key);
    }
    return e;
  }

  function show() {
    if (box) return;
    if (!document.getElementById('pw-consent-css')) {
      const st = document.createElement('style');
      st.id = 'pw-consent-css';
      st.textContent =
        '.pw-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9000;max-width:560px;margin:0 auto;' +
        'background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);' +
        'box-shadow:var(--shadow);padding:14px 16px;font-size:14px;line-height:1.45}' +
        '.pw-consent p{margin:0 0 10px}.pw-consent a{color:var(--accent-text)}' +
        '.pw-consent-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}' +
        '.pw-consent-row button{width:auto;margin:0}';
      document.head.appendChild(st);
    }
    box = el('div', 'pw-consent');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    const text = el('p', '', 'common.consent.text');
    const more = el('a', '', 'common.consent.more');
    more.href = '/datenschutz';
    text.append(' ', more);
    const row = el('div', 'pw-consent-row');
    const no = el('button', 'icon-btn', 'common.consent.essential');
    no.type = 'button';
    const yes = el('button', '', 'common.consent.accept');
    yes.type = 'button';
    no.addEventListener('click', () => { save('essential'); close(); });
    yes.addEventListener('click', () => { save('stats'); close(); });
    row.append(no, yes);
    box.append(text, row);
    document.body.appendChild(box);
  }

  function close() {
    box?.remove();
    box = null;
  }

  window.PWConsent = { show };
  // на /datenschutz баннер открывается только по кнопке «Изменить выбор»
  if (!/^\/datenschutz/.test(location.pathname)) show();
})();
