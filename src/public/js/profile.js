// /u/<ник> — профиль. Свой: настройки аккаунта (разделы — #general, #security), чужой — пока пусто

const profileName = (() => {
  const raw = location.pathname.replace(/^\/u\/?/, '').replace(/\/$/, '');
  try { return decodeURIComponent(raw).toLowerCase(); } catch (_) { return raw.toLowerCase(); }
})();

const TABS = ['general', 'security', 'devices', 'chat'];
let account = null; // GET /auth/account
let emailShown = false;

// «Назад» — на ту вкладку сайта, с которой пришли; открыли по ссылке извне — на главную.
// Разделы меняют адрес через replaceState, поэтому «Назад» не ходит по ним
function profileBack() {
  let sameSite = false;
  try { sameSite = new URL(document.referrer).origin === location.origin; } catch (_) {}
  if (sameSite && history.length > 1) history.back();
  else location.href = '/';
}

async function profileLogout() {
  const ok = await PW.confirm(t('profile.general.logoutConfirm'), { danger: true, okText: t('profile.general.logout') });
  if (!ok) return;
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  try { localStorage.removeItem('pw_authed'); } catch (_) {}
  location.href = '/';
}

function openTab(tab) {
  if (!TABS.includes(tab)) tab = TABS[0];
  document.querySelectorAll('.pf-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pf-section').forEach((s) => s.classList.toggle('hidden', s.dataset.section !== tab));
  history.replaceState(null, '', '#' + tab);
  if (tab === 'devices') loadDevices();
}

document.getElementById('pfNav')?.addEventListener('click', (e) => {
  const b = e.target.closest('.pf-nav-btn');
  if (b) openTab(b.dataset.tab);
});

const fmtDate = (d) => new Date(d).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'long', year: 'numeric' });

// ---------- Общее ----------

function renderGeneral() {
  const a = account;
  document.getElementById('pfNick').textContent = a.username;

  const stream = document.getElementById('pfStream');
  const streamBtn = document.getElementById('pfStreamBtn');
  if (a.streamerName) {
    stream.textContent = a.streamerName;
    streamBtn.href = '/streamers/' + encodeURIComponent(a.streamerName.toLowerCase());
    streamBtn.textContent = t('profile.general.streamOpen');
  } else {
    stream.textContent = t('profile.general.streamNone');
    streamBtn.href = '/streamers/edit.html';
    streamBtn.textContent = t('profile.general.streamCreate');
  }

  document.getElementById('pfCreated').textContent = fmtDate(a.createdAt) + (a.regDevice ? ' · ' + a.regDevice : '');
  document.getElementById('pfPassChanged').textContent = a.passwordChangedAt ? fmtDate(a.passwordChangedAt) : t('profile.general.passNever');
  renderEmail();
}

function renderEmail() {
  const el = document.getElementById('pfEmail');
  el.textContent = emailShown ? account.email : '••••••••••';
  el.classList.toggle('pf-secret', !emailShown);
  const eye = document.getElementById('pfEmailEye');
  eye.title = t(emailShown ? 'profile.general.hide' : 'profile.general.show');
}

function toggleEmail() {
  if (!account) return;
  emailShown = !emailShown;
  renderEmail();
}

// ---------- Безопасность: смена почты ----------

let emailTimer = null;
let locked = false; // не главное устройство: пароль, почта и удаление недоступны
// письмо уже ушло: подсказка, куда, и отсчёт до повтора на кнопке
function renderEmailState(pending, retrySec) {
  const note = document.getElementById('pfEmailState');
  note.textContent = pending ? t('profile.email.pending', { email: pending }) : '';
  note.classList.toggle('hidden', !pending);
  const btn = document.getElementById('pfEmailSubmit');
  clearInterval(emailTimer);
  let left = retrySec || 0;
  const tick = () => {
    btn.disabled = locked || left > 0;
    btn.textContent = left > 0 ? t('profile.email.again', { n: left }) : t('profile.email.submit');
    left--;
    if (left < 0) clearInterval(emailTimer);
  };
  tick();
  if (left >= 0) emailTimer = setInterval(tick, 1000);
}

const emailBody = () => ({
  email: document.getElementById('pfEmailNew').value.trim(),
  password: document.getElementById('pfEmailPass').value,
});

async function changeEmail(e) {
  e.preventDefault();
  document.getElementById('pfEmailLimit').classList.add('hidden');
  const btn = document.getElementById('pfEmailSubmit');
  btn.disabled = true;
  try {
    const r = await api('/auth/email', { method: 'POST', body: emailBody() });
    document.getElementById('pfEmailPass').value = '';
    renderEmailState(r.pendingEmail, r.retryIn);
    PW.toast(r.message, 'success');
  } catch (err) {
    if (err.code === 'mailLimit') {
      document.getElementById('pfEmailLimitText').textContent = err.message;
      document.getElementById('pfEmailLimit').classList.remove('hidden');
    } else {
      PW.toast(err.message, 'error');
    }
    renderEmailState(account?.pendingEmail, err.retryIn || 0);
  }
}

// лимит писем исчерпан — заявка: админ сверит и сменит почту в карточке аккаунта
async function emailSupport() {
  try {
    const r = await api('/auth/email/support', { method: 'POST', body: emailBody() });
    document.getElementById('pfEmailLimit').classList.add('hidden');
    document.getElementById('pfEmailPass').value = '';
    PW.toast(r.message, 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// ---------- Устройства ----------

let devices = null; // GET /devices

const fmtTime = (d) => new Date(d).toLocaleString(I18N.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function devRow(s) {
  const row = document.createElement('div');
  row.className = 'pf-dev';
  const info = document.createElement('div');
  info.className = 'pf-dev-info';
  const name = document.createElement('div');
  name.className = 'pf-dev-name';
  name.textContent = s.device || t('profile.devices.unknown');
  if (s.main) {
    const b = document.createElement('span');
    b.className = 'pf-badge';
    b.textContent = t('profile.devices.main');
    name.appendChild(b);
  }
  const meta = document.createElement('div');
  meta.className = 'pf-dev-meta';
  meta.textContent = [s.country, s.ip, s.current ? t('profile.devices.now') : t('profile.devices.seen', { d: fmtTime(s.lastSeenAt) })]
    .filter(Boolean).join(' · ');
  const since = document.createElement('div');
  since.className = 'pf-dev-meta';
  since.textContent = t('profile.devices.since', { d: fmtTime(s.createdAt) });
  info.append(name, meta, since);
  row.appendChild(info);

  const ops = document.createElement('div');
  ops.className = 'pf-dev-ops';
  const btn = (key, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn pf-small-btn ' + cls;
    b.textContent = t(key);
    b.addEventListener('click', fn);
    ops.appendChild(b);
  };
  if (!s.current && devices.isMain && !s.main && s.canMain) btn('profile.devices.makeMain', '', () => makeMain(s));
  if (!s.current && (devices.isMain || !s.main)) btn('profile.devices.revoke', 'pf-danger-btn', () => revokeSession(s));
  row.appendChild(ops);
  return row;
}

function renderDevices() {
  const cur = devices.sessions.filter((s) => s.current);
  const others = devices.sessions.filter((s) => !s.current);
  const curBox = document.getElementById('pfDevCurrent');
  const othersBox = document.getElementById('pfDevOthers');
  curBox.replaceChildren(...cur.map(devRow));
  othersBox.replaceChildren(...others.map(devRow));
  if (!others.length) {
    const p = document.createElement('p');
    p.className = 'pf-empty';
    p.textContent = t('profile.devices.none');
    othersBox.appendChild(p);
  }
  document.getElementById('pfDevRevokeAll').classList.toggle('hidden', !others.some((s) => devices.isMain || !s.main));
}

async function loadDevices() {
  try {
    devices = await api('/devices');
    renderDevices();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

async function revokeSession(s) {
  if (!(await PW.confirm(t('profile.devices.revokeConfirm', { device: s.device || '?' }), { danger: true, okText: t('profile.devices.revoke') }))) return;
  try {
    await api('/devices/revoke', { method: 'POST', body: { sid: s.sid } });
    PW.toast(t('profile.devices.revoked'), 'success');
    loadDevices();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

async function revokeOthers() {
  if (!(await PW.confirm(t('profile.devices.revokeAllConfirm'), { danger: true, okText: t('profile.devices.revokeAll') }))) return;
  try {
    const r = await api('/devices/revoke-others', { method: 'POST', body: {} });
    PW.toast(t('profile.devices.revokedN', { n: r.count }), 'success');
    loadDevices();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

async function makeMain(s) {
  if (!(await PW.confirm(t('profile.devices.makeMainConfirm', { device: s.device || '?' }), { okText: t('profile.devices.makeMain') }))) return;
  try {
    await api('/devices/main', { method: 'POST', body: { sid: s.sid } });
    PW.toast(t('profile.devices.mainDone'), 'success');
    loadDevices();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// не с главного устройства — формы почты, пароля и удаления заблокированы, сверху плашка
function lockCritical(on) {
  locked = on;
  document.getElementById('pfMainOnly').classList.toggle('hidden', !on);
  for (const id of ['pfEmailForm', 'pfPassForm', 'pfDeleteForm']) {
    const form = document.getElementById(id);
    form.classList.toggle('pf-locked', on);
    form.querySelectorAll('input, button').forEach((el) => { el.disabled = on || el.type === 'submit' && id !== 'pfEmailForm'; });
  }
  if (!on) { checkPassRules(); checkDelete(); }
}

// ---------- Безопасность: удаление аккаунта ----------

function checkDelete() {
  document.getElementById('pfDelSubmit').disabled = !document.getElementById('pfDelPass').value || !document.getElementById('pfDelAgree').checked;
}

async function deleteAccount(e) {
  e.preventDefault();
  if (!(await PW.confirm(t('profile.del.confirm'), { danger: true, okText: t('profile.del.submit') }))) return;
  const btn = document.getElementById('pfDelSubmit');
  btn.disabled = true;
  try {
    const r = await api('/auth/delete', { method: 'POST', body: { password: document.getElementById('pfDelPass').value, agree: true } });
    try { localStorage.removeItem('pw_authed'); } catch (_) {}
    const date = new Date(r.deleteAt).toLocaleString(I18N.locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    await PW.alert(t('profile.del.done', { date }));
    location.href = '/';
  } catch (err) {
    PW.toast(err.message, 'error');
    checkDelete();
  }
}

// ---------- Вид чата ----------

function chatLine(color, text) {
  const row = document.createElement('div');
  row.className = 'pf-chat-line';
  const nick = document.createElement('b');
  nick.className = 'pw-nick';
  nick.style.setProperty('--nick', color);
  nick.textContent = account.username;
  row.append(nick, document.createTextNode(': ' + text));
  return row;
}

function renderChat() {
  const c = account.chatColor;
  const lines = () => [chatLine(c, t('profile.chat.sample1')), chatLine(c, t('profile.chat.sample2'))];
  document.getElementById('pfChatSite').replaceChildren(...lines());
  document.getElementById('pfChatObs').replaceChildren(...lines());
  const box = document.getElementById('pfSwatches');
  box.replaceChildren(...(account.palette || []).map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pf-swatch' + (p === c ? ' active' : '');
    b.style.setProperty('--sw', p);
    b.title = p;
    b.setAttribute('aria-pressed', p === c ? 'true' : 'false');
    b.addEventListener('click', () => pickColor(p));
    return b;
  }));
}

async function pickColor(color) {
  if (color === account.chatColor) return;
  const prev = account.chatColor;
  account.chatColor = color;
  renderChat();
  try {
    await api('/auth/chat-color', { method: 'POST', body: { color } });
    PW.toast(t('profile.chat.saved'), 'success');
  } catch (err) {
    account.chatColor = prev;
    renderChat();
    PW.toast(err.message, 'error');
  }
}

// ---------- Безопасность: смена пароля ----------

function togglePass(id, btn) {
  const input = document.getElementById(id);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.title = t(show ? 'profile.general.hide' : 'profile.general.show');
}

// те же правила, что у регистрации (validatePassword в auth.routes.js)
function checkPassRules() {
  const p = document.getElementById('pfPassNew').value;
  const c = document.getElementById('pfPassConfirm').value;
  const rules = {
    length: p.length >= 8,
    upper: /^[A-Z]/.test(p),
    letter: /[A-Za-z]/.test(p),
    digit: /\d/.test(p),
    match: !!p && p === c,
  };
  document.querySelectorAll('#pfPassRules [data-rule]').forEach((li) => li.classList.toggle('ok', rules[li.dataset.rule]));
  const ready = Object.values(rules).every(Boolean)
    && !!document.getElementById('pfPassCurrent').value
    && document.getElementById('pfPassAgree').checked;
  document.getElementById('pfPassSubmit').disabled = !ready;
}
document.getElementById('pfPassCurrent')?.addEventListener('input', checkPassRules);

async function changePassword(e) {
  e.preventDefault();
  const btn = document.getElementById('pfPassSubmit');
  btn.disabled = true;
  try {
    const r = await api('/auth/password', {
      method: 'POST',
      body: {
        current: document.getElementById('pfPassCurrent').value,
        password: document.getElementById('pfPassNew').value,
        confirm: document.getElementById('pfPassConfirm').value,
        agree: document.getElementById('pfPassAgree').checked,
      },
    });
    document.getElementById('pfPassForm').reset();
    checkPassRules();
    if (account) {
      account.passwordChangedAt = r.passwordChangedAt;
      renderGeneral();
    }
    PW.toast(t('profile.pass.done'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
    checkPassRules();
  }
}

// язык сменили без перезагрузки — перерисовать то, что собрано в JS (даты, подписи кнопок)
window.addEventListener('pw:langchange', () => {
  if (account) { renderGeneral(); renderChat(); }
  if (devices) renderDevices();
});

// ---------- старт ----------

(async () => {
  let me = null;
  try { me = await api('/auth/me'); } catch (_) {}
  const own = !!me && String(me.username || '').toLowerCase() === profileName;
  if (!own) return; // чужой профиль — оформим позже
  try {
    account = await api('/auth/account');
  } catch (err) {
    PW.toast(err.message, 'error');
    return;
  }
  document.getElementById('pfOwn').classList.remove('hidden');
  document.getElementById('pfDeleteForm').classList.toggle('hidden', me.role === 'owner'); // владельца так не удалить
  renderGeneral();
  renderChat();
  lockCritical(!account.isMain);
  renderEmailState(account.pendingEmail, account.emailRetryIn);
  openTab(location.hash.slice(1));
})();
