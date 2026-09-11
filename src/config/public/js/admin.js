// public/js/admin.js — заменить runUpdate на поллинг статуса
async function runUpdate() {
  const log = document.getElementById('log');
  log.textContent = 'Запуск...\n';
  try {
    await api('/admin/update', { method: 'POST' });
  } catch (err) {
    log.textContent += 'Ошибка запуска: ' + err.message;
    return;
  }

  const poll = setInterval(async () => {
    const s = await api('/admin/update/status');
    log.textContent = s.log.join('\n');
    if (s.state === 'done' || s.state === 'error') {
      clearInterval(poll);
      log.textContent += s.state === 'done' ? '\n\n✅ Завершено' : '\n\n❌ Ошибка';
    }
  }, 1500);
}

async function loadUsers() {
  try {
    const users = await api('/admin/users');
    document.getElementById('users').innerHTML = users.map((u) => `${u.username} (${u.email}) — ${u.role}`).join('<br>');
  } catch (err) { document.getElementById('users').textContent = err.message; }
}

loadUsers();