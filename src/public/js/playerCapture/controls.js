let currentMeta = null;

export function showEpisodeControls(meta) {
  currentMeta = meta;
  const btn = document.getElementById('episodeSelectBtn');
  if (btn) btn.classList.remove('hidden');
}

export function hideEpisodeControls() {
  const btn = document.getElementById('episodeSelectBtn');
  if (btn) btn.classList.add('hidden');
}

export function openEpisodeSelector() {
  if (!currentMeta) return;

  const seasonSelect = document.getElementById('seasonSelect');
  const episodeSelect = document.getElementById('episodeSelect');
  const voiceSelect = document.getElementById('voiceSelect');

  // Сезоны
  seasonSelect.innerHTML = '';
  (currentMeta.seasons || [1]).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Сезон ${s}`;
    if (s === currentMeta.currentSeason) opt.selected = true;
    seasonSelect.appendChild(opt);
  });

  // Серии (пока просто 1–20)
  episodeSelect.innerHTML = '';
  for (let i = 1; i <= 20; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Серия ${i}`;
    if (i === currentMeta.currentEpisode) opt.selected = true;
    episodeSelect.appendChild(opt);
  }

  // Озвучки
  voiceSelect.innerHTML = '';
  (currentMeta.voices || []).forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (v === currentMeta.currentVoice) opt.selected = true;
    voiceSelect.appendChild(opt);
  });

  if (!currentMeta.voices?.length) {
    voiceSelect.parentElement.style.display = 'none';
  } else {
    voiceSelect.parentElement.style.display = 'flex';
  }

  document.getElementById('episodeModal').classList.remove('hidden');
}

export function applyEpisodeSelection() {
  const season = Number(document.getElementById('seasonSelect').value);
  const episode = Number(document.getElementById('episodeSelect').value);
  const voice = document.getElementById('voiceSelect').value || null;

  currentMeta.currentSeason = season;
  currentMeta.currentEpisode = episode;
  currentMeta.currentVoice = voice;

  // TODO: здесь будет реальная смена серии через postMessage или перезагрузку iframe
  console.log('[playerCapture] apply', { season, episode, voice });

  closeModal('episodeModal');
  alert(`Выбрано: Сезон ${season}, Серия ${episode}${voice ? ', ' + voice : ''}\n(пока только визуально, смена серии будет в следующем этапе)`);
}

// Делаем функции глобальными, чтобы onclick работал
window.openEpisodeSelector = openEpisodeSelector;
window.applyEpisodeSelection = applyEpisodeSelection;