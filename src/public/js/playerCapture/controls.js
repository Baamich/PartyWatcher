//controls.js (playerCapture)
let currentMeta = null;
let onEpisodeChangeCallback = null; 

export function showEpisodeControls(meta, onChange) {
  currentMeta = meta;
  onEpisodeChangeCallback = onChange || null;
  fillEpisodeSelects(meta);
  
  // Показываем панель только если мы сейчас во вкладке "Видео" и мы хост
  const hostControls = document.getElementById('hostControls');
  if (hostControls && document.body.classList.contains('view-video-only')) {
    hostControls.classList.remove('hidden');
  }
}

export function hideEpisodeControls() {
  const hostControls = document.getElementById('hostControls');
  if (hostControls) hostControls.classList.add('hidden');
}

function fillEpisodeSelects(meta) {
  const seasonSelect = document.getElementById('seasonSelect');
  const episodeSelect = document.getElementById('episodeSelect');
  const voiceSelect = document.getElementById('voiceSelect');
  const voiceRow = document.getElementById('voiceRow');

  if (!seasonSelect) return;

  // Сезоны
  seasonSelect.innerHTML = '';
  (meta.seasons || [1]).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Сезон ${s}`;
    if (s === meta.currentSeason) opt.selected = true;
    seasonSelect.appendChild(opt);
  });

  // Серии (пока 1-24)
    // Серии — рисуем ровно столько, сколько реально известно с сайта.
  // Если totalEpisodes не передан (например, это фильм, а не сериал) — не выдумываем список.
  episodeSelect.innerHTML = '';
  const totalEpisodes = meta.totalEpisodes || 1;
  for (let i = 1; i <= totalEpisodes; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Серия ${i}`;
    if (i === meta.currentEpisode) opt.selected = true;
    episodeSelect.appendChild(opt);
  }

  // Озвучки
  if (meta.voices && meta.voices.length) {
    voiceRow.style.display = 'flex';
    voiceSelect.innerHTML = '';
    meta.voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === meta.currentVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
  } else {
    voiceRow.style.display = 'none';
  }
}

export async function onEpisodeChange() {
  if (!currentMeta) return;

  const season = Number(document.getElementById('seasonSelect').value);
  const episode = Number(document.getElementById('episodeSelect').value);
  const voice = document.getElementById('voiceSelect')?.value || null;

  const changed = 
    season !== currentMeta.currentSeason ||
    episode !== currentMeta.currentEpisode ||
    voice !== currentMeta.currentVoice;

  if (!changed) return;

  currentMeta.currentSeason = season;
  currentMeta.currentEpisode = episode;
  currentMeta.currentVoice = voice;

  console.log('[playerCapture] changed to', currentMeta);

  // Отправляем событие на сервер, чтобы зрители получили системное сообщение
  if (window.socket && window.code) {
    window.socket.emit('player_capture:change', {
      code: window.code,
      season,
      episode,
      voice
    });
  }

  // реально перезагружаем плеер с новой серией
  if (onEpisodeChangeCallback) {
    try {
      await onEpisodeChangeCallback(episode);
    } catch (e) {
      console.error('[playerCapture] ошибка при смене серии:', e.message);
    }
  }
}

// Глобально
window.onEpisodeChange = onEpisodeChange;