// Главная точка входа для режима захвата плеера

import { createIframePlayer } from './iframeManager.js';
import { detectMeta } from './detector.js';
import { showEpisodeControls, hideEpisodeControls } from './controls.js';

export async function renderPlayerCapture(video, { isOwner, container }) {
  container.innerHTML = '';

  // 1. Пытаемся определить сезон/серию/озвучку
  let meta = video.meta || {};
  try {
    const detected = await detectMeta(video.url);
    if (detected) {
      meta = { ...meta, ...detected };
    }
  } catch (e) {
    console.warn('[playerCapture] detect failed', e);
  }

  // 2. Создаём iframe
  const iframe = createIframePlayer(video.url, container);

  // 3. Если есть данные — показываем кнопку хосту
  if (isOwner && (meta.seasons?.length || meta.voices?.length)) {
    showEpisodeControls(meta);
  } else {
    hideEpisodeControls();
  }

  return {
    type: 'player_capture',
    iframe,
    meta,
    // заглушки под будущую синхронизацию
    getCurrentPosition: () => 0,
    getIsPlayingNow: () => false,
    doPlayPause: () => {},
    seekTo: () => {},
  };
}