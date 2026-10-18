// /u/<ник> — профиль пользователя. Пока пустой: «Назад» и (в своём профиле) «Выйти»

const profileName = (() => {
  const raw = location.pathname.replace(/^\/u\/?/, '').replace(/\/$/, '');
  try { return decodeURIComponent(raw).toLowerCase(); } catch (_) { return raw.toLowerCase(); }
})();

// «Назад» — на ту вкладку сайта, с которой пришли; открыли по ссылке извне — на главную
function profileBack() {
  let sameSite = false;
  try { sameSite = new URL(document.referrer).origin === location.origin; } catch (_) {}
  if (sameSite && history.length > 1) history.back();
  else location.href = '/';
}

async function profileLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  try { localStorage.removeItem('pw_authed'); } catch (_) {}
  location.href = '/';
}

api('/auth/me')
  .then((me) => {
    const own = !!me && String(me.username || '').toLowerCase() === profileName;
    document.getElementById('logoutBtn')?.classList.toggle('hidden', !own);
  })
  .catch(() => {});
