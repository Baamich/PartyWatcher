// Страница входа (/login; гостю — и по адресу главной): вход, регистрация, сброс пароля, письмо подтверждения.
// После входа — на ?returnTo= (внутренний путь) или на главную с комнатами (services/pages: сервер отдаёт по входу)
function getReturnTo() {
  const v = new URLSearchParams(location.search).get('returnTo');
  // разрешаем только относительные внутренние пути — защита от открытого редиректа на чужой домен
  if (v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return v;
  return null;
}

// уже вошёл (вход в другой вкладке, старая ссылка «Войти») — сразу дальше
api('/auth/me').then(() => location.replace(getReturnTo() || '/')).catch(() => {
  if (new URLSearchParams(location.search).get('mode') === 'register') showRegisterPanel();
  else showLoginPanel();
});

// вход, сброс пароля и регистрация — отдельные <form>: Enter отправляет, менеджер паролей заполняет нужные поля
function submitAuth(e, which) {
  e.preventDefault();
  if (which === 'login') login();
  else if (which === 'forgot') sendForgot();
  else if (which === 'register') register();
}

function showAuthPanel(id) {
  ['loginPanel', 'registerPanel', 'forgotPanel'].forEach((p) => {
    document.getElementById(p)?.classList.toggle('hidden', p !== id);
  });
}

function showLoginPanel() {
  showAuthPanel('loginPanel');
  hideAuthError('loginError');
}

function showRegisterPanel() {
  showAuthPanel('registerPanel');
  hideAuthError('registerError');
  validateRegisterForm();
}

function showForgotPanel() {
  showAuthPanel('forgotPanel');
  hideAuthError('forgotError');
  document.getElementById('forgotOk')?.classList.add('hidden');
  const loginVal = document.getElementById('loginInput')?.value.trim() || '';
  const emailInput = document.getElementById('forgotEmail');
  if (emailInput && !emailInput.value && loginVal.includes('@')) emailInput.value = loginVal;
}

// ---- кнопки писем с отсчётом: «Отправить ещё раз (1:59)», пока сервер не разрешит повтор ----
const cooldowns = new Map(); // кнопка → таймер
function startCooldown(btn, sec, labelKey) {
  if (!btn) return;
  clearInterval(cooldowns.get(btn));
  cooldowns.delete(btn);
  let left = Math.max(0, Math.round(Number(sec) || 0));
  const draw = () => {
    const label = t(labelKey);
    btn.textContent = left > 0 ? t('index.mail.wait', { label, time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }) : label;
    btn.disabled = left > 0;
  };
  draw();
  if (!left) return;
  cooldowns.set(btn, setInterval(() => {
    left -= 1;
    draw();
    if (left <= 0) { clearInterval(cooldowns.get(btn)); cooldowns.delete(btn); }
  }, 1000));
}

async function sendForgot() {
  hideAuthError('forgotError');
  const okEl = document.getElementById('forgotOk');
  okEl?.classList.add('hidden');
  const email = (document.getElementById('forgotEmail')?.value || '').trim();
  const err = getEmailError(email);
  if (err) return showAuthError('forgotError', err);

  const btn = document.getElementById('forgotBtn');
  if (btn) btn.disabled = true;
  try {
    const data = await api('/auth/forgot', { method: 'POST', body: { email } });
    if (okEl) {
      okEl.textContent = data.message || t('index.forgot.checkMail');
      okEl.classList.remove('hidden');
    }
    document.getElementById('forgotHint')?.classList.remove('hidden');
    // повтор на этот же адрес — через 2 минуты (раньше сервер не примет); исправил адрес — можно сразу
    startCooldown(btn, data.retryIn || 120, 'index.forgot.again');
  } catch (e) {
    showAuthError('forgotError', e.message || t('index.sendFailed'));
    if (e.retryIn) startCooldown(btn, e.retryIn, 'index.forgot.again');
    else if (btn) btn.disabled = false;
  }
}
// исправил почту — на новый адрес можно отправить сразу (лимит у сервера — на аккаунт)
document.getElementById('forgotEmail')?.addEventListener('input', () => {
  const btn = document.getElementById('forgotBtn');
  if (btn && cooldowns.has(btn)) startCooldown(btn, 0, 'index.forgot.again');
});

function showAuthError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAuthError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-label', show ? t('index.password.hide') : t('index.password.show'));
}

function isValidEmail(email) {
  // практичная проверка: есть @, домен с точкой, без пробелов
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function getEmailError(email) {
  const v = String(email).trim();
  if (!v) return t('index.email.empty');
  if (v.includes(' ')) return t('index.email.spaces');
  if (!v.includes('@')) return t('index.email.noAt');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return t('index.email.format');
  return null;
}

function updateEmailStatus() {
  const input = document.getElementById('regEmail');
  const status = document.getElementById('emailStatus');
  const hint = document.getElementById('emailHint');
  if (!input || !status || !hint) return;

  const err = getEmailError(input.value);
  if (!input.value.trim()) {
    status.textContent = '';
    status.className = 'field-status';
    status.title = '';
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }

  if (err) {
    status.textContent = '!';
    status.className = 'field-status bad';
    status.title = t('index.email.showError');
    status.onclick = () => {
      hint.textContent = err;
      hint.classList.remove('hidden');
    };
  } else {
    status.textContent = '✓';
    status.className = 'field-status ok';
    status.title = t('index.email.ok');
    status.onclick = null;
    hint.classList.add('hidden');
    hint.textContent = '';
  }
}

function getPasswordChecks(password) {
  const p = String(password || '');
  return {
    length: p.length >= 8,
    upper: /^[A-Z]/.test(p),
    letter: /[A-Za-z]/.test(p),
    digit: /\d/.test(p),
  };
}

function updatePasswordRules() {
  const password = document.getElementById('regPassword')?.value || '';
  const confirm = document.getElementById('regPasswordConfirm')?.value || '';
  const checks = getPasswordChecks(password);
  const match = password.length > 0 && password === confirm;

  const map = [
    ['ruleLength', checks.length],
    ['ruleUpper', checks.upper],
    ['ruleLetter', checks.letter],
    ['ruleDigit', checks.digit],
    ['ruleMatch', match],
  ];

  map.forEach(([id, ok]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('rule-ok', ok);
    el.classList.toggle('rule-bad', !ok);
  });

  return checks.length && checks.upper && checks.letter && checks.digit && match;
}

function validateRegisterForm() {
  const username = document.getElementById('regUsername')?.value.trim() || '';
  const emailOk = !getEmailError(document.getElementById('regEmail')?.value || '');
  const passwordOk = updatePasswordRules();
  const termsOk = !!document.getElementById('regTerms')?.checked;
  const btn = document.getElementById('registerBtn');
  if (btn) btn.disabled = !(username && emailOk && passwordOk && termsOk);
}

async function login() {
  hideAuthError('loginError');
  const loginVal = document.getElementById('loginInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!loginVal || !password) {
    showAuthError('loginError', t('index.login.empty'));
    return;
  }
  const send = (cancelDeletion) => api('/auth/login', { method: 'POST', body: { login: loginVal, password, cancelDeletion } });
  try {
    try {
      await send(false);
    } catch (err) {
      // аккаунт ждёт удаления (сам попросил в профиле): войти — значит отменить удаление
      if (err.code !== 'deletionPending') throw err;
      if (!(await PW.confirm(err.message, { okText: t('index.login.cancelDeletion') }))) return;
      await send(true);
      PW.toast(t('index.login.deletionCancelled'), 'success');
    }
    const returnTo = getReturnTo();
    if (returnTo) {
      location.href = returnTo;
      return;
    }
    location.href = '/';
  } catch (err) {
    showAuthError('loginError', err.message || t('index.login.failed'));
    document.getElementById('verifyBox')?.classList.toggle('hidden', err.code !== 'unverified');
    if (err.code === 'queued') document.getElementById('verifyBox')?.classList.remove('hidden');
    setQueued(err.code === 'queued');
    if (err.code === 'unverified') startCooldown(document.getElementById('verifyResendBtn'), err.retryIn, 'index.verify.resend');
  }
}

// ---- неподтверждённая почта: письмо ещё раз или другая почта (логин и пароль — из формы входа) ----
function verifyCreds() {
  return { login: document.getElementById('loginInput').value.trim(), password: document.getElementById('passwordInput').value };
}
// в очереди на письмо (дневной лимит писем исчерпан): «отправить ещё раз» не нужно, почту сменить можно
function setQueued(on) {
  document.getElementById('verifyResendBtn')?.classList.toggle('hidden', !!on);
}
function showVerifyOk(text) {
  const el = document.getElementById('verifyOk');
  el.textContent = text;
  el.classList.remove('hidden');
}
async function resendVerify() {
  hideAuthError('loginError');
  const btn = document.getElementById('verifyResendBtn');
  try {
    const r = await api('/auth/verify/resend', { method: 'POST', body: verifyCreds() });
    showVerifyOk(r.message || t('index.verify.sent'));
    setQueued(r.queued);
    if (!r.queued) startCooldown(btn, r.retryIn || 120, 'index.verify.resend');
  } catch (e) {
    showAuthError('loginError', e.message);
    if (e.retryIn) startCooldown(btn, e.retryIn, 'index.verify.resend');
  }
}
function toggleVerifyEmail() {
  const row = document.getElementById('verifyEmailRow');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) document.getElementById('verifyEmailInput').focus();
}
async function changeVerifyEmail() {
  hideAuthError('loginError');
  const email = document.getElementById('verifyEmailInput').value.trim();
  const err = getEmailError(email);
  if (err) return showAuthError('loginError', err);
  try {
    const r = await api('/auth/verify/change-email', { method: 'POST', body: { ...verifyCreds(), email } });
    document.getElementById('verifyEmailRow').classList.add('hidden');
    showVerifyOk(r.message || t('index.verify.sent'));
    setQueued(r.queued);
    if (!r.queued) startCooldown(document.getElementById('verifyResendBtn'), r.retryIn || 120, 'index.verify.resend');
  } catch (e) {
    showAuthError('loginError', e.message);
    if (e.retryIn) startCooldown(document.getElementById('verifyResendBtn'), e.retryIn, 'index.verify.resend');
  }
}

async function register() {
  hideAuthError('registerError');
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;

  if (!username) {
    showAuthError('registerError', t('index.register.noUsername'));
    return;
  }
  const emailErr = getEmailError(email);
  if (emailErr) {
    showAuthError('registerError', emailErr);
    updateEmailStatus();
    return;
  }
  if (!updatePasswordRules()) {
    if (password !== confirm) {
      showAuthError('registerError', t('index.register.mismatch'));
    } else {
      showAuthError('registerError', t('index.register.weak'));
    }
    return;
  }
  if (!document.getElementById('regTerms')?.checked) {
    showAuthError('registerError', t('index.register.termsNeeded'));
    return;
  }

  try {
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { username, email, password, acceptTerms: true },
    });
    if (reg.pending) {
      // вход только после подтверждения почты: экран входа с уже вписанными логином и паролем, куда ушло письмо,
      // «Отправить ещё раз» (с отсчётом) и «Сменить почту» (ошибся адресом — исправил и отправил)
      showLoginPanel();
      document.getElementById('loginInput').value = username;
      document.getElementById('passwordInput').value = password;
      document.getElementById('verifyBox')?.classList.remove('hidden');
      const emailInput = document.getElementById('verifyEmailInput');
      if (emailInput) emailInput.value = email;
      showVerifyOk(reg.message);
      setQueued(reg.queued); // в очереди — письмо придёт само, когда откроется дневной лимит
      if (!reg.queued) startCooldown(document.getElementById('verifyResendBtn'), reg.retryIn || 120, 'index.verify.resend');
      return;
    }
    const returnTo = getReturnTo();
    if (returnTo) {
      location.href = returnTo;
      return;
    }
    location.href = '/';
  } catch (err) {
    showAuthError('registerError', err.message || t('index.register.failed'));
  }
}

document.getElementById('regEmail')?.addEventListener('blur', updateEmailStatus);
document.getElementById('regEmail')?.addEventListener('input', () => {
  document.getElementById('emailHint')?.classList.add('hidden');
  validateRegisterForm();
});
document.getElementById('regPassword')?.addEventListener('input', validateRegisterForm);
document.getElementById('regPasswordConfirm')?.addEventListener('input', validateRegisterForm);
document.getElementById('regUsername')?.addEventListener('input', validateRegisterForm);
document.getElementById('regTerms')?.addEventListener('change', validateRegisterForm);
