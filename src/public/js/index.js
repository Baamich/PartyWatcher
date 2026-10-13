function getReturnTo() {
  const v = new URLSearchParams(location.search).get('returnTo');
  // разрешаем только относительные внутренние пути — защита от открытого редиректа на чужой домен
  if (v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return v;
  return null;
}

async function checkAuth() {
  const authBox = document.getElementById('authBox');
  const appBox = document.getElementById('appBox');

  try {
    const me = await api('/auth/me');

    const returnTo = getReturnTo();
    if (returnTo) {
      location.href = returnTo;
      return;
    }

    window.__pwAuthed = true;
    // «Просмотр фильма / сериала» — только админу и друзьям (сервер проверяет сам)
    const capOpt = document.querySelector('option[value="player_capture"]');
    if (capOpt) {
      const can = me.role === 'admin' || me.role === 'friend';
      capOpt.hidden = !can;
      capOpt.classList.toggle('hidden', !can);
    }
    try { localStorage.setItem('pw_authed', '1'); } catch {}
    if (authBox) authBox.classList.add('hidden');
    if (appBox) appBox.classList.remove('hidden');
    document.documentElement.classList.remove('pw-authed');

    const meName = document.getElementById('meName');
    if (meName) meName.textContent = me.username || '';

    const adminLink = document.getElementById('adminLink');
    if (adminLink) {
      adminLink.classList.toggle('hidden', me.role !== 'admin');
    }

    // Kodik выбран по умолчанию: после входа спрашиваем, есть ли поиск (до входа /kodik/config недоступен)
    if (isKodikType()) updateKodikMode();
    initLobbySocket(); // сокет и оба списка — параллельно: каждый запрос к серверу — полсекунды дороги
    await Promise.all([loadMyRooms(), loadPublicRooms()]);
    startAutoRefresh();
  } catch (err) {
    console.warn('[checkAuth] не авторизован:', err?.message || err);
    window.__pwAuthed = false;
    try { localStorage.removeItem('pw_authed'); } catch {}
    document.documentElement.classList.remove('pw-authed'); // подсказка ошиблась (вышел на другой вкладке и т.п.)
    if (authBox) authBox.classList.remove('hidden');
    if (appBox) appBox.classList.add('hidden');
    stopAutoRefresh();
    if (new URLSearchParams(location.search).get('mode') === 'register') {
      showRegisterPanel();
    } else {
      showLoginPanel();
    }
  }
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
    // после успеха не даём жать сразу снова: сервер всё равно примет одно письмо раз в 2 минуты
    setTimeout(() => { if (btn) btn.disabled = false; }, 30000);
  } catch (e) {
    showAuthError('forgotError', e.message || t('index.sendFailed'));
    if (btn) btn.disabled = false;
  }
}

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
  try {
    await api('/auth/login', {
      method: 'POST',
      body: {
        login: loginVal,
        password,
      },
    });
    const returnTo = getReturnTo();
    if (returnTo) {
      location.href = returnTo;
      return;
    }
    await checkAuth();
  } catch (err) {
    showAuthError('loginError', err.message || t('index.login.failed'));
    document.getElementById('verifyBox')?.classList.toggle('hidden', err.code !== 'unverified');
  }
}

// ---- неподтверждённая почта: письмо ещё раз или другая почта (логин и пароль — из формы входа) ----
function verifyCreds() {
  return { login: document.getElementById('loginInput').value.trim(), password: document.getElementById('passwordInput').value };
}
function showVerifyOk(text) {
  const el = document.getElementById('verifyOk');
  el.textContent = text;
  el.classList.remove('hidden');
}
async function resendVerify() {
  hideAuthError('loginError');
  try {
    const r = await api('/auth/verify/resend', { method: 'POST', body: verifyCreds() });
    showVerifyOk(r.message || t('index.verify.sent'));
  } catch (e) {
    showAuthError('loginError', e.message);
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
  } catch (e) {
    showAuthError('loginError', e.message);
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
      // вход только после подтверждения почты: показываем, куда ушло письмо, и экран входа
      await PW.alert(reg.message, { title: t('index.register.title') });
      showLoginPanel();
      return;
    }
    const returnTo = getReturnTo();
    if (returnTo) {
      location.href = returnTo;
      return;
    }
    await checkAuth();
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

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  try { localStorage.removeItem('pw_authed'); } catch {}
  stopAutoRefresh();
  checkAuth();
}

// ---- тип видео + приватность — один общий инфо-попап на двоих ----

// тексты подсказок по типу видео — в словаре: index.info.<тип> (с HTML-ссылками)

let privacyPublic = false; // по умолчанию приватная

function lockStatusText() {
  return privacyPublic ? t('index.privacy.public') : t('index.privacy.private');
}

function renderInfoPopup() {
  const type = document.getElementById('videoType').value;
  // у Kodik для админа и друзей есть ещё поиск по названию (kodikSearchEnabled — ответ /kodik/config)
  const extra = type === 'kodik' && kodikSearchEnabled ? t('index.info.kodikSearch') + '<br><br>' : '';
  document.getElementById('infoPopup').innerHTML = `${extra}${t('index.info.' + type)}<hr>${escapeHtml(lockStatusText())}`;
}

function toggleInfoPopup() {
  const popup = document.getElementById('infoPopup');
  const willShow = popup.classList.contains('hidden');
  if (willShow) renderInfoPopup();
  popup.classList.toggle('hidden');
}

function onVideoTypeChange() {
  const popup = document.getElementById('infoPopup');
  if (!popup.classList.contains('hidden')) renderInfoPopup();
  updateKodikMode();
}

function updatePrivacyButton() {
  const btn = document.getElementById('privacyToggle');
  btn.textContent = privacyPublic ? '🔓' : '🔒';
  btn.classList.toggle('lock-public', privacyPublic);
  btn.classList.toggle('lock-private', !privacyPublic);
}

function togglePrivacy() {
  privacyPublic = !privacyPublic;
  updatePrivacyButton();
  const popup = document.getElementById('infoPopup');
  if (!popup.classList.contains('hidden')) renderInfoPopup(); // если попап открыт — сразу обновляем текст про замок
}

// ---- создание / вход в комнату ----

function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ---- Kodik: поиск фильма/сериала (если на сервере есть ключ API) или ссылка на их плеер ----

let kodikSearchEnabled = null; // null — ещё не спрашивали сервер
let kodikResults = null; // виджет выдачи (js/kodik/search.js), общий с комнатой
let kodikPick = null; // { item, tr } — выбранный фильм и озвучка (ведётся виджетом)
let kodikTimer = null;
let kodikSeq = 0;
let kodikInit = null; // один запрос /kodik/config и одна загрузка виджета, даже если режим включили дважды подряд

function isKodikType() {
  return document.getElementById('videoType').value === 'kodik';
}

function isKodikLink(s) {
  return /(kodik|aniqit)[^\/\s]*\/(serial|video|season|seria)\/\d+\//i.test(s);
}

function setUrlPlaceholder(key) {
  const input = document.getElementById('videoUrl');
  input.setAttribute('data-i18n-placeholder', key);
  input.placeholder = t(key);
}

// Kodik с поиском: поле — поиск по названию (значок 🔍, без подсказок прошлых ссылок), а не «ссылка»
function setKodikSearchLook(on) {
  const input = document.getElementById('videoUrl');
  input.classList.toggle('kodik-search', on);
  if (on) input.removeAttribute('list');
  else input.setAttribute('list', 'recentVideoUrls');
}

// название комнаты по выбранному фильму — пока человек не написал своё
function autoRoomName(pick) {
  const el = document.getElementById('roomName');
  if (el.value.trim() && el.dataset.auto !== '1') return;
  el.value = pick ? String(pick.item.title || '').slice(0, 100) : '';
  el.dataset.auto = el.value ? '1' : '';
}
document.getElementById('roomName')?.addEventListener('input', (e) => { e.target.dataset.auto = ''; });

async function updateKodikMode() {
  const box = document.getElementById('kodikResults');
  if (!isKodikType()) {
    setUrlPlaceholder('index.create.url');
    setKodikSearchLook(false);
    box.classList.add('hidden');
    return;
  }
  if (!kodikInit) {
    kodikInit = (async () => {
      try {
        kodikSearchEnabled = !!(await api('/kodik/config')).search;
      } catch {
        kodikInit = null; // не вошёл или сеть — пока только ссылка, спросим в следующий раз
        return;
      }
      if (kodikSearchEnabled) {
        const mod = await import('/js/kodik/search.js?v=1');
        kodikResults = mod.createKodikResults(document.getElementById('kodikResults'), {
          onPickChange: (pick) => { kodikPick = pick; autoRoomName(pick); },
        });
      }
    })();
  }
  await kodikInit;
  if (!isKodikType()) return; // пока ждали ответ, тип уже сменили
  setUrlPlaceholder(kodikSearchEnabled ? 'index.kodik.placeholder' : 'index.kodik.placeholderLink');
  setKodikSearchLook(!!kodikSearchEnabled);
  refreshKodikBox();
}

function onVideoUrlInput() {
  if (!isKodikType()) return;
  clearTimeout(kodikTimer);
  const q = document.getElementById('videoUrl').value.trim();
  if (!kodikSearchEnabled || q.length < 2 || isKodikLink(q)) {
    kodikSeq++; // ответ уже отправленного поиска больше не нужен
    kodikResults?.setItems([]);
    refreshKodikBox();
    return;
  }
  kodikTimer = setTimeout(() => kodikSearch(q), 400);
}

function onVideoUrlKeydown(arg, el, e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = el.value.trim();
  if (isKodikType() && kodikSearchEnabled && q.length >= 2 && !isKodikLink(q) && !kodikPick) {
    clearTimeout(kodikTimer);
    kodikSearch(q);
  } else {
    createRoom();
  }
}

async function kodikSearch(q) {
  const seq = ++kodikSeq;
  const box = document.getElementById('kodikResults');
  box.classList.remove('hidden');
  kodikResults?.searching();
  try {
    const data = await api('/kodik/search?q=' + encodeURIComponent(q));
    if (seq !== kodikSeq) return;
    kodikResults?.setItems(data.items || []);
  } catch (err) {
    if (seq !== kodikSeq) return;
    kodikResults?.error(err.message);
  }
}

// показываем/прячем блок выдачи; саму отрисовку карточек делает виджет
function refreshKodikBox() {
  const box = document.getElementById('kodikResults');
  const q = document.getElementById('videoUrl').value.trim();
  if (!isKodikType() || !kodikSearchEnabled || q.length < 2 || isKodikLink(q)) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  kodikResults?.render();
}

// подписи карточек (год · сериал · озвучки) собраны из t() — при смене языка перерисовываем
window.addEventListener('pw:langchange', () => {
  if (isKodikType() && kodikResults?.hasItems()) kodikResults.render();
});
// браузер мог восстановить выбранный тип при возврате на страницу
document.addEventListener('DOMContentLoaded', () => {
  // гостю /kodik/config недоступен (401) — не спрашиваем; после входа checkAuth вызовет сам
  if (isKodikType() && window.__pwAuthed !== false) updateKodikMode();
});

let creatingRoom = false; // двойной клик не должен создать две комнаты (и обойти лимит)
async function createRoom() {
  if (creatingRoom) return;
  creatingRoom = true;
  let leaving = false;
  try {
    const selection = document.getElementById('videoType').value;
    // для фильма из поиска Kodik название комнаты можно не писать — возьмём название фильма
    const name = document.getElementById('roomName').value.trim()
      || (selection === 'kodik' && kodikPick ? String(kodikPick.item.title || '').slice(0, 100) : '');
    if (!name) return PW.toast(t('index.create.noName'), 'info');

    const rawUrl = document.getElementById('videoUrl').value.trim();
    if (!rawUrl) return PW.toast(t('index.create.noUrl'), 'info');

    let type, url;
    const extra = {};

    if (selection === 'youtube_twitch') {
      // один пункт на три сервиса: тип определяем по ссылке
      if (/youtube\.com|youtu\.be/.test(rawUrl)) type = 'youtube';
      else if (/twitch\.tv/.test(rawUrl)) type = 'twitch';
      else if (/(^|[/.])(vk\.com|vk\.ru|vkvideo\.ru)\//i.test(rawUrl) || /^(vk\.com|vk\.ru|vkvideo\.ru)/i.test(rawUrl)) type = 'vk';
      else return PW.toast(t('index.create.unknownYtTwitch'), 'error');
      url = rawUrl;
    } else if (selection === 'drive') {
      const fileId = extractDriveFileId(rawUrl);
      if (!fileId) return PW.toast(t('index.create.badDrive'), 'error');
      type = 'drive';
      url = fileId;
    } else if (selection === 'player_capture') {
      if (!rawUrl.startsWith('http')) return PW.toast(t('index.create.needHttp'), 'error');
      type = 'player_capture';
      url = rawUrl;
    } else if (selection === 'direct') {
      if (!rawUrl.startsWith('http')) return PW.toast(t('index.create.needHttp'), 'error');
      type = 'direct';
      url = rawUrl;
    } else if (selection === 'kodik') {
      type = 'kodik';
      if (kodikPick) {
        url = kodikPick.tr.link;
        extra.title = kodikPick.item.title;
        if (kodikPick.item.poster) extra.poster = kodikPick.item.poster;
      } else if (isKodikLink(rawUrl)) {
        url = rawUrl;
      } else if (kodikSearchEnabled) {
        if (!kodikResults?.hasItems()) kodikSearch(rawUrl);
        return PW.toast(t('index.kodik.pickFirst'), 'info');
      } else {
        return PW.toast(t('index.kodik.needLink'), 'info');
      }
    } else {
      return PW.toast(t('index.create.chooseType'), 'info');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let room;
    try {
      room = await api('/rooms', {
        method: 'POST',
        body: {
          name,
          video: { type, url, ...extra },
          isPublic: privacyPublic,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!room?.code) {
      throw new Error(room?.error || t('index.create.noCode'));
    }
    leaving = true; // уходим в комнату — повторный клик не нужен
    window.PWRecent?.add(rawUrl); // в подсказки поля — только ссылки (не названия для поиска)
    location.href = `/room.html?code=${room.code}`;
  } catch (err) {
    console.error('[createRoom]', err);
    if (err.name === 'AbortError') {
      PW.toast(t('index.create.timeout'), 'error');
    } else {
      PW.toast(err.message || t('index.create.failed'), 'error');
    }
  } finally {
    if (!leaving) creatingRoom = false;
  }
}

async function joinByCode() {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) return;
  try {
    await api('/rooms/' + encodeURIComponent(code));
    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  } catch {
    PW.toast(t('index.join.notFound'), 'error');
  }
}

// ---- отрисовка списков комнат ----

function roomThumbnail(room) {
  if (room.thumbnailUrl) return room.thumbnailUrl;
  if (room.video.type === 'youtube') {
    const idMatch = room.video.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (idMatch) return `https://img.youtube.com/vi/${idMatch[1]}/hqdefault.jpg`;
  }
  return null;
}

function occupancyLabel(room) {
  return room.viewerCount > 0 ? room.viewerCount : t('index.card.empty');
}

function deletionLabel(room) {
  if (room.viewerCount > 0) return t('index.card.keptWhileWatching');
  if (!room.emptySince) return '';
  const deadline = new Date(room.emptySince).getTime() + 20 * 60 * 60 * 1000;
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) return t('index.card.deleting');
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return t('index.card.deletesIn', { h, m });
}

async function deleteRoom(code, ev) {
  ev.stopPropagation();
  const ok = await PW.confirm(t('index.delete.text'), {
    title: t('index.delete.title'),
    okText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/rooms/' + code, { method: 'DELETE' });
    loadMyRooms();
  } catch (err) {
    PW.toast(err.message || t('index.delete.failed'), 'error');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Корзина в SVG: выглядит одинаково на любом устройстве
// (эмодзи 🗑️ у некоторых показывается белым и пропадает на светлой теме)
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function renderRoomCard(room, { showDelete }) {
  const thumb = roomThumbnail(room);
  const card = document.createElement('div');
  card.className = 'room-card';
  card.innerHTML = `
    ${showDelete ? `<button type="button" class="delete-btn" title="${t('index.delete.btn')}" aria-label="${t('index.delete.btn')}">${TRASH_SVG}</button>` : ''}
    ${thumb ? `<img class="room-thumb" src="${escapeHtml(thumb)}" loading="lazy" />` : `<div class="room-thumb-placeholder">🎬</div>`}
    <div class="room-info">
      <span class="room-name" title="${escapeHtml(room.name)}">${room.video?.adult ? '<span class="adult-badge">18+</span> ' : ''}${escapeHtml(room.name)}</span>
      <span class="room-occupancy">👤 ${occupancyLabel(room)}</span>
    </div>
    <div class="room-actions">
      <button class="enter-btn">${t('index.join.submit')}</button>
      <div class="countdown">${deletionLabel(room)}</div>
    </div>`;

  card.querySelector('.enter-btn').onclick = () => (location.href = `/room.html?code=${room.code}`);
  if (showDelete) {
    card.querySelector('.delete-btn').onclick = (ev) => deleteRoom(room.code, ev);
  }
  return card;
}

const lastRender = { mine: '', public: '' };

function renderRoomList(list, rooms, opts, cacheKey) {
  const sig = JSON.stringify(rooms);

  // данные не изменились: карточки не трогаем, обновляем только таймеры
  if (lastRender[cacheKey] === sig) {
    rooms.forEach((room, i) => {
      const el = list.children[i]?.querySelector('.countdown');
      if (el) el.textContent = deletionLabel(room);
    });
    return;
  }

  lastRender[cacheKey] = sig;
  list.innerHTML = '';
  rooms.forEach((room) => list.appendChild(renderRoomCard(room, opts)));
}

async function loadMyRooms() {
  try {
    const rooms = await api('/rooms/mine');
    const list = document.getElementById('roomList');
    if (!list) return;

    if (!rooms.length) {
      lastRender.mine = '';
      list.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${t('index.mine.empty')}</p>`;
      return;
    }

    renderRoomList(list, rooms, { showDelete: true }, 'mine');
  } catch (err) {
    console.warn('[loadMyRooms]', err.message);
  }
}

// ===== Публичные комнаты: состояние =====
let publicState = {
  page: 1,
  sort: 'newest',
  onlyWithPeople: false,
  query: '',
  totalPages: 1,
};

function onPublicFilterChange() {
  publicState.page = 1;
  publicState.sort = document.getElementById('publicSort')?.value || 'newest';
  publicState.onlyWithPeople = document.getElementById('onlyWithPeople')?.checked || false;
  publicState.query = document.getElementById('publicSearchInput')?.value.trim() || '';
  loadPublicRooms();
}

function handlePublicSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    onPublicFilterChange();
  }
}

async function loadPublicRooms() {
  const list = document.getElementById('publicRoomList');
  const paginationEl = document.getElementById('publicPagination');
  if (!list) return;

  const params = new URLSearchParams({
    page: publicState.page,
    sort: publicState.sort,
    onlyWithPeople: publicState.onlyWithPeople ? '1' : '0',
  });
  if (publicState.query) params.set('q', publicState.query);

  try {
    const data = await api('/rooms/public?' + params.toString());
    const rooms = data.rooms || [];
    publicState.totalPages = data.totalPages || 1;

    if (!rooms.length) {
      lastRender.public = '';
      list.innerHTML = `<p style="color:var(--text-muted); font-size:14px;">${publicState.query ? t('index.public.notFound') : t('index.public.empty')}</p>`;
      if (paginationEl) paginationEl.classList.add('hidden');
      return;
    }

    renderRoomList(list, rooms, { showDelete: false }, 'public');
    renderPagination();
  } catch (err) {
    console.warn('[loadPublicRooms]', err.message);
  }
}

function renderPagination() {
  const el = document.getElementById('publicPagination');
  if (!el) return;

  const { page, totalPages } = publicState;

  if (totalPages <= 1) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = '';

  // стрелка влево
  const prev = document.createElement('button');
  prev.textContent = '‹';
  prev.disabled = page <= 1;
  prev.onclick = () => goToPage(page - 1);
  el.appendChild(prev);

  // страницы
  const pages = buildPageNumbers(page, totalPages);
  pages.forEach((p) => {
    if (p === '...') {
      const span = document.createElement('span');
      span.className = 'page-ellipsis';
      span.textContent = '…';
      el.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.textContent = p;
      if (p === page) btn.classList.add('active');
      btn.onclick = () => goToPage(p);
      el.appendChild(btn);
    }
  });

  // стрелка вправо
  const next = document.createElement('button');
  next.textContent = '›';
  next.disabled = page >= totalPages;
  next.onclick = () => goToPage(page + 1);
  el.appendChild(next);
}

function buildPageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages = [];
  pages.push(1);

  if (current > 3) pages.push('...');

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) pages.push('...');

  pages.push(total);
  return pages;
}

function goToPage(page) {
  if (page < 1 || page > publicState.totalPages) return;
  publicState.page = page;
  loadPublicRooms();
  // плавно вверх к списку
  document.getElementById('publicRoomList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let lobbySocket = null;
let refreshTimer = null;

function initLobbySocket() {
  if (lobbySocket) return;

  // socket.io должен быть уже подключён на странице (как в room.html)
  lobbySocket = io({ transports: ['websocket', 'polling'], tryAllTransports: true }); // сразу WebSocket: polling через туннель — лишние круги по полсекунды

  lobbySocket.on('connect', () => {
    lobbySocket.emit('lobby:join');
  });

 lobbySocket.on('rooms:public-updated', () => {
  if (publicState.page === 1 && publicState.sort === 'newest' && !publicState.onlyWithPeople && !publicState.query) {
    loadPublicRooms();
  }
});

  // мгновенное обновление "Мои комнаты"
  lobbySocket.on('rooms:mine-updated', () => {
    loadMyRooms();
  });
}

function startAutoRefresh() {
  if (refreshTimer) return;

  // лёгкий фоновый поллинг только для счётчиков зрителей и таймеров удаления
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    loadMyRooms();
    loadPublicRooms();
  };

  refreshTimer = setInterval(tick, 40000); // раз в 40 секунд достаточно
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (lobbySocket) {
    lobbySocket.emit('lobby:leave');
    lobbySocket.disconnect();
    lobbySocket = null;
  }
}


// ---- Служба поддержки ----
(function initSupport() {
  const fab = document.getElementById('supportFab');
  const modal = document.getElementById('supportModal');
  const closeBtn = document.getElementById('supportModalClose');
  const sendBtn = document.getElementById('supportSendBtn');
  if (!fab || !modal) return;

  function openSupport() {
    // без входа отвечаем только на почту, поэтому она обязательна
    const label = document.getElementById('supportEmailLabel');
    if (label) label.textContent = window.__pwAuthed ? t('index.support.emailOptional') : t('index.support.emailRequired');
    modal.classList.remove('hidden');
    document.getElementById('supportError')?.classList.add('hidden');
    document.getElementById('supportOk')?.classList.add('hidden');
  }
  function closeSupport() {
    modal.classList.add('hidden');
  }

  fab.addEventListener('click', openSupport);
  closeBtn?.addEventListener('click', closeSupport);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSupport();
  });

  sendBtn?.addEventListener('click', async () => {
    const name = (document.getElementById('supportName')?.value || '').trim().slice(0, 12);
    const email = (document.getElementById('supportEmail')?.value || '').trim().slice(0, 100);
    const description = (document.getElementById('supportDesc')?.value || '').trim().slice(0, 1000);
    const errEl = document.getElementById('supportError');
    const okEl = document.getElementById('supportOk');
    errEl?.classList.add('hidden');
    okEl?.classList.add('hidden');

    const fail = (text) => {
      if (errEl) {
        errEl.textContent = text;
        errEl.classList.remove('hidden');
      }
    };
    if (!window.__pwAuthed && !email) return fail(t('index.support.needEmail'));
    if (email && getEmailError(email)) return fail(t('index.support.badEmail'));
    if (!description || description.length < 5) return fail(t('index.support.shortDesc'));

    sendBtn.disabled = true;
    try {
      await api('/support', {
        method: 'POST',
        body: { name, email, description },
      });
      if (okEl) okEl.classList.remove('hidden');
      const desc = document.getElementById('supportDesc');
      if (desc) desc.value = '';
      setTimeout(closeSupport, 1200);
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message || t('index.sendFailed');
        errEl.classList.remove('hidden');
      }
    } finally {
      sendBtn.disabled = false;
    }
  });
})();
checkAuth();