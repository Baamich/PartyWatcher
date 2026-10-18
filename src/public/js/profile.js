// /u/<ник> — профиль. Свой: настройки аккаунта (разделы — #general, #security), чужой — пока пусто

const profileName = (() => {
  const raw = location.pathname.replace(/^\/u\/?/, '').replace(/\/$/, '');
  try { return decodeURIComponent(raw).toLowerCase(); } catch (_) { return raw.toLowerCase(); }
})();

const TABS = ['general', 'security', 'devices', 'chat', 'notifications', 'support'];
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

// tab может быть «support:<id>» — сразу открыть переписку (ссылка из уведомления)
function openTab(tab) {
  let ticketId = null;
  const m = /^support:([a-f0-9]{24})$/i.exec(String(tab || ''));
  if (m) {
    tab = 'support';
    ticketId = m[1];
  }
  if (!TABS.includes(tab)) tab = TABS[0];
  document.querySelectorAll('.pf-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pf-section').forEach((s) => s.classList.toggle('hidden', s.dataset.section !== tab));
  history.replaceState(null, '', '#' + (ticketId ? 'support:' + ticketId : tab));
  if (tab === 'devices') loadDevices();
  if (tab === 'notifications') loadNotifSettings();
  if (tab === 'support') {
    if (ticketId) openThread(ticketId);
    else supBack();
    loadSupport();
  }
}

document.getElementById('pfNav')?.addEventListener('click', (e) => {
  const b = e.target.closest('.pf-nav-btn');
  if (b) openTab(b.dataset.tab);
});
// переход из колокольчика на этой же странице (меняется только #…)
window.addEventListener('hashchange', () => {
  if (account) openTab(location.hash.slice(1));
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

// ---------- Уведомления: что показывать в колокольчике ----------

let notifSettings = null; // GET /notifications/settings

function renderNotifSettings() {
  const box = document.getElementById('pfNotifCats');
  box.replaceChildren(...notifSettings.cats.map((c) => {
    const row = document.createElement('label');
    row.className = 'pf-switch-row pf-notif-row' + (c.locked ? ' pf-notif-row--locked' : '');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = c.on;
    input.disabled = c.locked;
    input.addEventListener('change', () => saveNotifCat(c.id, input.checked, input));
    const text = document.createElement('span');
    text.className = 'pf-switch-text';
    const b = document.createElement('b');
    b.textContent = t('profile.notif.cats.' + c.id + '.title');
    const hint = document.createElement('span');
    hint.className = 'pf-hint';
    hint.textContent = t('profile.notif.cats.' + c.id + '.desc') + (c.locked ? ' ' + t('profile.notif.locked') : '');
    text.append(b, hint);
    row.append(input, text);
    return row;
  }));
}

async function loadNotifSettings() {
  try {
    notifSettings = await api('/notifications/settings');
    renderNotifSettings();
    renderSupMail();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

async function saveNotifCat(id, on, input) {
  const off = notifSettings.cats.filter((c) => (c.id === id ? !on : !c.on)).map((c) => c.id);
  input.disabled = true;
  try {
    notifSettings = await api('/notifications/settings', { method: 'PUT', body: { off } });
    renderNotifSettings();
    PW.toast(t('profile.notif.saved'), 'success');
  } catch (err) {
    input.checked = !on;
    input.disabled = false;
    PW.toast(err.message, 'error');
  }
}

// ---------- Поддержка: обращения, переписка, «ответы на почту» ----------

let supTickets = null; // GET /support/my
let supByEmail = false;
let supThread = null; // открытая переписка
let supAttach = null;

const supStatus = (tk) => t('profile.sup.status.' + (tk.status === 'unread' && tk.answered ? 'waiting' : tk.status));

function renderSupMail() {
  const box = document.getElementById('pfSupEmail');
  if (notifSettings) supByEmail = notifSettings.supportByEmail;
  box.checked = supByEmail;
  document.getElementById('pfSupMailHint').textContent = t(supByEmail ? 'profile.sup.mailOn' : 'profile.sup.mailOff');
}

function renderSupList() {
  const box = document.getElementById('pfSupList');
  if (!supTickets.length) {
    const p = document.createElement('p');
    p.className = 'pf-empty';
    p.textContent = t('profile.sup.empty');
    box.replaceChildren(p);
  } else {
    box.replaceChildren(...supTickets.map((tk) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pf-sup-row' + (tk.fresh ? ' pf-sup-row--fresh' : '');
      const main = document.createElement('div');
      main.className = 'pf-sup-row-main';
      const title = document.createElement('div');
      title.className = 'pf-sup-row-title';
      title.textContent = (tk.report ? '🚩 ' : '') + '#' + tk.number + ' · ' + (tk.topic || t('profile.sup.noTopic'));
      const meta = document.createElement('div');
      meta.className = 'pf-sup-row-meta';
      meta.textContent = t('profile.sup.updated', { d: fmtTime(tk.updatedAt) });
      main.append(title, meta);
      const side = document.createElement('div');
      side.className = 'pf-sup-row-side';
      if (tk.fresh) {
        const n = document.createElement('span');
        n.className = 'pf-sup-new';
        n.textContent = t('profile.sup.newReply');
        side.appendChild(n);
      }
      const st = document.createElement('span');
      st.className = 'pf-sup-status pf-sup-status--' + tk.status;
      st.textContent = supStatus(tk);
      side.appendChild(st);
      row.append(main, side);
      row.addEventListener('click', () => openTab('support:' + tk.id));
      return row;
    }));
  }
  document.getElementById('pfSupDot').classList.toggle('hidden', !supTickets.some((x) => x.fresh));
}

async function loadSupport() {
  try {
    const r = await api('/support/my');
    supTickets = r.tickets;
    supByEmail = !!r.supportByEmail;
    if (notifSettings) notifSettings.supportByEmail = supByEmail;
    renderSupMail();
    renderSupList();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

function msgEl(m) {
  const mine = m.from === 'user';
  const el = document.createElement('div');
  el.className = 'pf-sup-msg ' + (mine ? 'pf-sup-msg--me' : 'pf-sup-msg--support');
  const head = document.createElement('div');
  head.className = 'pf-sup-msg-head';
  const via = m.fallback ? '🔔 ' + t('profile.sup.fallback.' + m.fallback)
    : !mine && m.emailed ? '✉️ ' + t('profile.sup.viaMail')
      : mine && m.kind === 'user' && !m.site && m.at ? '✉️ ' + t('profile.sup.fromMail') : '';
  head.textContent = [mine ? t('profile.sup.you') : t('profile.sup.team'), fmtTime(m.at), via].filter(Boolean).join(' · ');
  const text = document.createElement('div');
  text.className = 'pf-sup-msg-text';
  text.textContent = m.kind === 'accepted' || m.kind === 'trivial' ? t('profile.sup.kind.' + m.kind) : m.text;
  if (m.kind === 'accepted' || m.kind === 'trivial') text.classList.add('pf-sup-msg-status');
  el.append(head, text);
  return el;
}

function renderThread() {
  const tk = supThread;
  document.getElementById('pfSupThreadTitle').textContent =
    (tk.report ? '🚩 ' : '') + '#' + tk.number + ' · ' + (tk.topic || t('profile.sup.noTopic')) + ' — ' + supStatus(tk);
  const first = { from: 'user', kind: 'user', text: tk.description, at: tk.createdAt, site: true };
  const box = document.getElementById('pfSupMsgs');
  box.replaceChildren(...[first, ...tk.messages].map(msgEl));
  if (tk.files && tk.files.length) {
    const files = document.createElement('div');
    files.className = 'pf-sup-files';
    for (const id of tk.files) {
      const a = document.createElement('a');
      a.href = '/api/support/file/' + encodeURIComponent(id);
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = a.href;
      img.alt = '';
      img.loading = 'lazy';
      a.appendChild(img);
      files.appendChild(a);
    }
    box.firstElementChild.appendChild(files);
  }
  box.scrollTop = box.scrollHeight;
}

async function openThread(id) {
  document.getElementById('pfSupForm').classList.add('hidden');
  try {
    const r = await api('/support/my/' + encodeURIComponent(id));
    supThread = r.ticket;
    document.getElementById('pfSupList').classList.add('hidden');
    document.getElementById('pfSupThread').classList.remove('hidden');
    renderThread();
    // открыл — ответ прочитан: убрать метку в списке
    const row = supTickets && supTickets.find((x) => x.id === id);
    if (row && row.fresh) {
      row.fresh = false;
      renderSupList();
    }
  } catch (err) {
    PW.toast(err.message, 'error');
    supBack();
  }
}

function supBack() {
  supThread = null;
  document.getElementById('pfSupThread').classList.add('hidden');
  document.getElementById('pfSupList').classList.remove('hidden');
  if (/^#support:/.test(location.hash)) history.replaceState(null, '', '#support');
}

async function supReply(e) {
  e.preventDefault();
  const input = document.getElementById('pfSupReplyText');
  const text = input.value.trim();
  if (!supThread || text.length < 2) return;
  const btn = document.getElementById('pfSupReplyBtn');
  btn.disabled = true;
  try {
    const r = await api('/support/my/' + encodeURIComponent(supThread.id) + '/reply', { method: 'POST', body: { text } });
    input.value = '';
    supThread.messages.push(r.message);
    supThread.status = r.ticket.status;
    renderThread();
    const row = supTickets && supTickets.find((x) => x.id === supThread.id);
    if (row) {
      Object.assign(row, r.ticket);
      supTickets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      renderSupList();
    }
    PW.toast(t('profile.sup.sent'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function supNew() {
  supBack();
  const form = document.getElementById('pfSupForm');
  form.classList.remove('hidden');
  if (!supAttach && window.PWAttach) supAttach = PWAttach.create(document.getElementById('pfSupAttach'), { max: 5, pasteRoot: form });
  document.getElementById('pfSupSubject').focus();
}

function supCancel() {
  document.getElementById('pfSupForm').classList.add('hidden');
}

async function supSend(e) {
  e.preventDefault();
  const subject = document.getElementById('pfSupSubject').value.trim();
  const description = document.getElementById('pfSupText').value.trim();
  if (!subject) return PW.toast(t('profile.sup.needSubject'), 'error');
  if (description.length < 5) return PW.toast(t('profile.sup.shortText'), 'error');
  if (supAttach && supAttach.busy()) return PW.toast(t('common.attach.wait'), 'error');
  const btn = document.getElementById('pfSupSendBtn');
  btn.disabled = true;
  try {
    const r = await api('/support', { method: 'POST', body: { subject, description, files: supAttach ? supAttach.files() : [] } });
    document.getElementById('pfSupForm').reset();
    if (supAttach) supAttach.clear();
    supCancel();
    PW.toast(t('profile.sup.created', { n: r.number }), 'success');
    await loadSupport();
    if (r.id) openTab('support:' + r.id);
  } catch (err) {
    PW.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// «Ответы на почту»: включение — только после объяснения, что изменится
async function supEmailToggle(_arg, box) {
  const want = box.checked;
  box.checked = supByEmail;
  if (want && !(await PW.confirm(t('profile.sup.mailConfirm', { email: account ? account.email : '' }), { title: t('profile.sup.mailConfirmTitle'), okText: t('profile.sup.mailEnable') }))) return;
  box.disabled = true;
  try {
    notifSettings = await api('/notifications/settings', { method: 'PUT', body: { supportByEmail: want } });
    supByEmail = notifSettings.supportByEmail;
    renderSupMail();
    PW.toast(t(supByEmail ? 'profile.sup.mailOnToast' : 'profile.sup.mailOffToast'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  } finally {
    box.disabled = false;
  }
}

// язык сменили без перезагрузки — перерисовать то, что собрано в JS (даты, подписи кнопок)
window.addEventListener('pw:langchange', () => {
  if (account) { renderGeneral(); renderChat(); }
  if (devices) renderDevices();
  if (notifSettings) renderNotifSettings();
  if (supTickets) { renderSupMail(); renderSupList(); }
  if (supThread) renderThread();
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
  // точка «новый ответ» у «Поддержки» видна из любого раздела
  if (!/^support/.test(location.hash.slice(1))) loadSupport();
})();
