// Подтверждение почты по ссылке из письма: токен во фрагменте (#t=...), на сервер — только в POST /auth/verify
(function () {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  if (location.hash) history.replaceState(null, '', location.pathname); // токен не остаётся в истории
  const wait = document.getElementById('verifyWait');
  const err = document.getElementById('verifyError');
  function fail(text) {
    wait.classList.add('hidden');
    err.textContent = text;
    err.classList.remove('hidden');
  }
  if (!token) return fail(t('verify.badLink'));
  api('/auth/verify', { method: 'POST', body: { token } })
    .then(() => {
      wait.classList.add('hidden');
      document.getElementById('verifyOk').classList.remove('hidden');
      try { localStorage.setItem('pw_authed', '1'); } catch (_) {}
      setTimeout(() => { location.href = '/'; }, 1500);
    })
    .catch((e) => fail(e.message || t('verify.badLink')));
})();
