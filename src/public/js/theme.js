(function () {
  const stored = localStorage.getItem('pw-theme') || 'dark'; // тёмная по умолчанию
  document.documentElement.setAttribute('data-theme', stored);
})();

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function applyThemeIcon() {
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.textContent = currentTheme() === 'dark' ? '🌙' : '☀️';
  });
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pw-theme', next);
  applyThemeIcon();
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', applyThemeIcon);