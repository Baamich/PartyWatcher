async function runUpdate() {
  const log = document.getElementById('log');
  log.textContent = 'Загрузка...\n';
  try {
    const result = await api('/admin/update', { method: 'POST' });
    log.textContent += 'Готово!\n' + JSON.stringify(result, null, 2);
  } catch (err) { log.textContent += 'Ошибка: ' + err.message; }
}

async function loadUsers() {
  try {
    const users = await api('/admin/users');
    document.getElementById('users').innerHTML = users.map((u) => `${u.username} (${u.email}) — ${u.role}`).join('<br>');
  } catch (err) { document.getElementById('users').textContent = err.message; }
}

loadUsers();