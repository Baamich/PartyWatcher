//controls.js (playerCapture)
let currentMeta = null;
let onEpisodeChangeCallback = null;
let onQualityChangeCallback = null;
let availableStreams = [];

export function showEpisodeControls(meta, onChange, streams, onQualityChange) {
  currentMeta = meta;
  onEpisodeChangeCallback = onChange || null;
  onQualityChangeCallback = onQualityChange || null;
  availableStreams = Array.isArray(streams) ? streams : [];
  fillEpisodeSelects(meta);
  fillQualitySelect(availableStreams, meta?.currentQuality);

  const hostControls = document.getElementById('hostControls');
  if (!hostControls) return;

  if (document.body.classList.contains('view-video-only')) {
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
  const playerSelect = document.getElementById('playerSelect');
  const playerRow = document.getElementById('playerRow');

  if (!seasonSelect) return;

  seasonSelect.innerHTML = '';
  (meta.seasons || [1]).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Сезон ${s}`;
    if (s === meta.currentSeason) opt.selected = true;
    seasonSelect.appendChild(opt);
  });

  episodeSelect.innerHTML = '';
  const totalEpisodes = meta.totalEpisodes || 1;
  for (let i = 1; i <= totalEpisodes; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Серия ${i}`;
    if (i === meta.currentEpisode) opt.selected = true;
    episodeSelect.appendChild(opt);
  }

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

  if (playerSelect && playerRow) {
    if (meta.players && meta.players.length > 1) {
      playerRow.style.display = 'flex';
      playerSelect.innerHTML = '';
      meta.players.forEach((label) => {
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        playerSelect.appendChild(opt);
      });
      if (meta.currentPlayer) {
        playerSelect.value = meta.currentPlayer;
        if (playerSelect.value !== meta.currentPlayer) {
          const found = meta.players.find(
            (p) => p.trim().toLowerCase() === String(meta.currentPlayer).trim().toLowerCase()
          );
          if (found) playerSelect.value = found;
        }
      }
    } else {
      playerRow.style.display = 'none';
    }
  }
}

function fillQualitySelect(streams, currentQuality) {
  const qualitySelect = document.getElementById('qualitySelect');
  const qualityRow = document.getElementById('qualityRow');
  if (!qualitySelect || !qualityRow) return;

  const withQuality = (streams || []).filter((s) => s && s.url && s.quality);
  if (withQuality.length < 2) {
    qualityRow.style.display = 'none';
    return;
  }

  qualityRow.style.display = 'flex';
  qualitySelect.innerHTML = '';

  // сортируем: 1080 → 720 → 480 → 360
  const sorted = [...withQuality].sort((a, b) => {
    return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0);
  });

  sorted.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.quality;
    opt.textContent = s.quality;
    qualitySelect.appendChild(opt);
  });

  const preferred = currentQuality || sorted.find((s) => parseInt(s.quality, 10) === 720)?.quality || sorted[0].quality;
  qualitySelect.value = preferred;
}

export async function onEpisodeChange() {
  if (!currentMeta) return;

  const season = Number(document.getElementById('seasonSelect').value);
  const episode = Number(document.getElementById('episodeSelect').value);
  const voice = document.getElementById('voiceSelect')?.value || null;
  const player = document.getElementById('playerSelect')?.value || null;

  const changed =
    season !== currentMeta.currentSeason ||
    episode !== currentMeta.currentEpisode ||
    voice !== currentMeta.currentVoice ||
    player !== currentMeta.currentPlayer;

  if (!changed) return;

  currentMeta.currentSeason = season;
  currentMeta.currentEpisode = episode;
  currentMeta.currentVoice = voice;
  currentMeta.currentPlayer = player;

  if (onEpisodeChangeCallback) {
    try {
      await onEpisodeChangeCallback(episode, player);
    } catch (e) {
      console.error('[playerCapture] ошибка при смене серии/плеера:', e.message);
      return;
    }
  }
}

export function onQualityChange() {
  const qualitySelect = document.getElementById('qualitySelect');
  if (!qualitySelect || !onQualityChangeCallback) return;

  const quality = qualitySelect.value;
  if (currentMeta) currentMeta.currentQuality = quality;

  try {
    onQualityChangeCallback(quality);
  } catch (e) {
    console.error('[playerCapture] ошибка смены качества:', e.message);
  }
}

window.onEpisodeChange = onEpisodeChange;
window.onQualityChange = onQualityChange;