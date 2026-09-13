let allCommits = [];
let selectedHash = null;

async function loadCommits() {
  const list = document.getElementById('commitList');
  try {
    const data = await api('/admin/commits');
    allCommits = data.commits || [];
    renderCommits(allCommits);
  } catch (err) {
    list.textContent = 'Ошибка загрузки коммитов: ' + err.message;
  }
}

function renderCommits(commits) {
  const list = document.getElementById('commitList');
  if (!commits.length) {
    list.innerHTML = '<div class="commit-empty">Ничего не найдено</div>';
    return;
  }

  list.innerHTML = commits
    .map(
      (c) => `
      <label class="commit-item">
        <input type="radio" name="commit" value="${c.hash}"
          onchange="selectCommit('${c.hash}')"
          ${selectedHash === c.hash ? 'checked' : ''} />
        <span class="commit-hash">${c.short}</span>
        <span class="commit-msg">${escapeHtml(c.message)}</span>
        <span class="commit-meta">${c.author} · ${c.date}</span>
      </label>
    `
    )
    .join('');
}

function selectCommit(hash) {
  selectedHash = hash;
  document.getElementById('revertBtn').disabled = false;
}

function filterCommits() {
  const q = document.getElementById('commitSearch').value.trim().toLowerCase();
  if (!q) return renderCommits(allCommits);
  const filtered = allCommits.filter(
    (c) => c.hash.toLowerCase().includes(q) || c.message.toLowerCase().includes(q)
  );
  renderCommits(filtered);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function runUpdate(hash) {
  const log = document.getElementById('log');
  log.textContent = 'Запуск...\n';
  try {
    await api('/admin/update', {
      method: 'POST',
      body: hash ? { hash } : {},
    });
  } catch (err) {
    log.textContent += 'Ошибка запуска: ' + err.message;
    return;
  }
  pollStatus(log);
}

function revertToCommit() {
  if (!selectedHash) return;
  if (!confirm('Откатить проект на выбранный коммит?')) return;
  runUpdate(selectedHash);
}

function pollStatus(log) {
  const poll = setInterval(async () => {
    const s = await api('/admin/update/status');
    log.textContent = s.log.join('\n');
    if (s.state === 'done' || s.state === 'error') {
      clearInterval(poll);
      log.textContent += s.state === 'done' ? '\n\n✅ Завершено' : '\n\n❌ Ошибка';
    }
  }, 1500);
}

loadCommits();