// Окно «условия пользования изменились / подтвердите условия». Грузит api.js, когда /auth/me пришёл с termsOk: false
// или сервер ответил 403 code: 'terms'. Закрыть мимо нельзя: «Принять» (POST /auth/terms) или «Не принимаю» — выход
// из аккаунта и на главную (смотреть сайт гостем можно, при следующем входе окно появится снова)
(function () {
  if (window.PWTermsGate) return;
  let box = null;

  function el(tag, cls, key) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (key) {
      e.setAttribute('data-i18n', key);
      e.textContent = t(key);
    }
    return e;
  }

  function show(me) {
    if (box) return;
    box = el('div', 'modal pw-terms-gate');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.style.zIndex = '10050';
    const card = el('div', 'modal-content');
    card.style.maxWidth = '460px';

    const title = el('h3', '', me && me.termsChanged ? 'common.terms.changedTitle' : 'common.terms.needTitle');
    const text = el('p', '', me && me.termsChanged ? 'common.terms.changedText' : 'common.terms.needText');
    text.style.lineHeight = '1.5';
    const link = el('a', '', 'common.terms.open');
    link.href = '/terms';
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.fontWeight = '700';

    const lab = document.createElement('label');
    lab.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:14px 0;cursor:pointer;font-size:14px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'width:auto;margin:3px 0 0;flex-shrink:0';
    lab.append(cb, el('span', '', 'common.terms.agree'));

    const err = el('div', 'auth-error hidden');
    const row = el('div', 'pw-dialog-actions');
    const no = el('button', 'icon-btn', 'common.terms.decline');
    no.type = 'button';
    const yes = el('button', '', 'common.terms.accept');
    yes.type = 'button';
    const setYes = (on) => { yes.disabled = !on; yes.style.opacity = on ? '' : '0.5'; };
    setYes(false);
    row.append(no, yes);

    cb.addEventListener('change', () => setYes(cb.checked));
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        await api('/auth/terms', { method: 'POST', body: { accept: true } });
        box.remove();
        box = null;
        if (window.PW && PW.toast) PW.toast(t('common.terms.thanks'), 'success');
      } catch (e) {
        err.textContent = e.message;
        err.classList.remove('hidden');
        setYes(cb.checked);
      }
    });
    no.addEventListener('click', async () => {
      no.disabled = true;
      try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
      try { localStorage.removeItem('pw_authed'); } catch (_) {}
      location.href = '/';
    });

    card.append(title, text, link, lab, err, row);
    box.appendChild(card);
    document.body.appendChild(box);
    // окно нельзя закрыть Esc и кликом мимо — гасим, чтобы не сработали обработчики страницы
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
    cb.focus();
  }

  window.PWTermsGate = { show };
})();
