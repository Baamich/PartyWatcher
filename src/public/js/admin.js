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