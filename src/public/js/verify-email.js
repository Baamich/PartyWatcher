// Ссылки из писем: токен во фрагменте, на сервер — только POST.
// #t=... — подтверждение почты после регистрации (POST /auth/verify, сразу входим);
// #c=... — смена почты из профиля (POST /auth/email/confirm, вход не нужен)
(function () {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('t') || '';
  const change = params.get('c') || '';
  if (location.hash) history.replaceState(null, '', location.pathname); // токен не остаётся в истории
  const wait = document.getElementById('verifyWait');
  const err = document.getElementById('verifyError');
  const ok = document.getElementById('verifyOk');
  function fail(text) {
    wait.classList.add('hidden');
    err.textContent = text;
    err.classList.remove('hidden');
  }
  if (change) {
    api('/auth/email/confirm', { method: 'POST', body: { token: change } })
      .then((r) => {
        wait.classList.add('hidden');
        ok.removeAttribute('data-i18n'); // иначе смена языка вернёт текст «аккаунт активирован»
        ok.textContent = t('verify.emailChanged', { email: r.email || '' });
        ok.classList.remove('hidden');
      })
      .catch((e) => fail(e.message || t('verify.badLink')));
    return;
  }
  if (!token) return fail(t('verify.badLink'));
  api('/auth/verify', { method: 'POST', body: { token } })
    .then(() => {
      wait.classList.add('hidden');
      ok.classList.remove('hidden');
      try { localStorage.setItem('pw_authed', '1'); } catch (_) {}
      setTimeout(() => { location.href = '/'; }, 1500);
    })
    .catch((e) => fail(e.message || t('verify.badLink')));
})();
