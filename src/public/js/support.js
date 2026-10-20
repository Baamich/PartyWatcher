// Служба поддержки: кнопка справа снизу и окно (главная и страница входа). Без входа ответ — только на почту,
// поэтому гостю она обязательна (window.__pwAuthed ставят index.js / login.js)
(function initSupport() {
  const emailBad = (v) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const fab = document.getElementById('supportFab');
  const modal = document.getElementById('supportModal');
  const closeBtn = document.getElementById('supportModalClose');
  const sendBtn = document.getElementById('supportSendBtn');
  if (!fab || !modal) return;
  const attachBox = document.getElementById('supportAttach');
  const attach = attachBox && window.PWAttach ? PWAttach.create(attachBox, { max: 5, pasteRoot: modal }) : null;

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
    if (email && emailBad(email)) return fail(t('index.support.badEmail'));
    if (!description || description.length < 5) return fail(t('index.support.shortDesc'));
    if (attach?.busy()) return fail(t('common.attach.wait'));

    sendBtn.disabled = true;
    try {
      await api('/support', {
        method: 'POST',
        body: { name, email, description, files: attach ? attach.files() : [] },
      });
      if (okEl) okEl.classList.remove('hidden');
      const desc = document.getElementById('supportDesc');
      if (desc) desc.value = '';
      attach?.clear();
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
