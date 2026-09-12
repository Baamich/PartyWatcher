(function () {
  const stored = localStorage.getItem('pw-theme') || 'light';
  document.documentElement.setAttribute('data-theme', stored);
})();

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pw-theme', theme);
}

function openThemeModal() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const radio = document.querySelector(`input[name="themeChoice"][value="${current}"]`);
  if (radio) radio.checked = true;
  document.getElementById('themeSettingsModal').classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}