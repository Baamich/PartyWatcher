// Подсказки поля ссылки: вместо истории браузера — только последние ссылки, с которыми создавали комнату
// или меняли видео (на этом устройстве). Поле: autocomplete="off" list="recentVideoUrls".
(function () {
  const KEY = 'pw_recent_urls';
  const MAX = 8;
  const isLink = (s) => /^https?:\/\//i.test(s) || /^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i.test(s); // и «vk.com/video…» без https

  function list() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(a) ? a.filter((s) => typeof s === 'string').slice(0, MAX) : [];
    } catch (_) {
      return [];
    }
  }

  function fill() {
    const dl = document.getElementById('recentVideoUrls');
    if (!dl) return;
    dl.replaceChildren(...list().map((u) => Object.assign(document.createElement('option'), { value: u })));
  }

  function add(raw) {
    const url = String(raw || '').trim().slice(0, 500);
    if (!url || !isLink(url)) return; // названия для поиска Kodik не храним
    try {
      localStorage.setItem(KEY, JSON.stringify([url, ...list().filter((u) => u !== url)].slice(0, MAX)));
    } catch (_) { /* без localStorage — просто без истории */ }
    fill();
  }

  window.PWRecent = { list, add, fill };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
