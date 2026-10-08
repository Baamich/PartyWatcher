// Страница сброса пароля: токен приходит во фрагменте ссылки (#t=...), на сервер он уходит только в POST
(function () {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  // убираем токен из адресной строки и истории — чтобы не остался в закладках/скриншотах
  if (location.hash) history.replaceState(null, '', location.pathname);

  const pass = document.getElementById('newPassword');
  const confirm = document.getElementById('newPasswordConfirm');
  const btn = document.getElementById('resetBtn');
  const errEl = document.getElementById('resetError');

  function showError(text) {
    errEl.textContent = text;
    errEl.classList.remove('hidden');
  }

  if (!token) {
    showError('Ссылка неполная. Запросите сброс пароля ещё раз на главной странице.');
    document.getElementById('resetForm').classList.add('hidden');
    return;
  }

  // те же правила, что при регистрации (сервер проверяет их ещё раз)
  function checks() {
    const p = pass.value;
    return {
      ruleLength: p.length >= 8,
      ruleUpper: /^[A-Z]/.test(p),
      ruleLetter: /[A-Za-z]/.test(p),
      ruleDigit: /\d/.test(p),
      ruleMatch: p.length > 0 && p === confirm.value,
    };
  }

  function update() {
    const c = checks();
    let ok = true;
    for (const [id, good] of Object.entries(c)) {
      const li = document.getElementById(id);
      li.classList.toggle('rule-ok', good);
      li.classList.toggle('rule-bad', !good);
      if (!good) ok = false;
    }
    btn.disabled = !ok;
    return ok;
  }

  pass.addEventListener('input', update);
  confirm.addEventListener('input', update);

  window.toggleResetPassword = function (inputId, el) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    if (el) el.setAttribute('aria-label', input.type === 'password' ? 'Показать пароль' : 'Скрыть пароль');
  };

  window.submitReset = async function () {
    errEl.classList.add('hidden');
    if (!update()) return;
    btn.disabled = true;
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password: pass.value } });
      document.getElementById('resetForm').classList.add('hidden');
      document.getElementById('resetOk').classList.remove('hidden');
      setTimeout(() => { location.href = '/'; }, 1500);
    } catch (e) {
      showError(e.message || 'Не удалось сменить пароль');
      btn.disabled = false;
    }
  };
})();
