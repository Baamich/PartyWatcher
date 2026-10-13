// /datenschutz: текущий выбор по статистике (cookie pw_consent) и кнопка «Изменить выбор» (баннер js/consent.js)
(function () {
  const state = document.getElementById('consentState');
  function render() {
    const m = document.cookie.match(/(?:^|;\s*)pw_consent=(\w+)/);
    const key = !m ? 'privacy.consentNone' : m[1] === 'stats' ? 'privacy.consentStats' : 'privacy.consentEssential';
    state.setAttribute('data-i18n', key);
    state.textContent = t(key);
  }
  render();
  window.addEventListener('pw:consent', render);
  document.getElementById('consentChangeBtn')?.addEventListener('click', () => window.PWConsent && window.PWConsent.show());
})();
