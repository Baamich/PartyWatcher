/**
 * Пытается определить сезон / серию / озвучку по URL или HTML страницы.
 * Пока очень простой скелет. Позже добавим парсеры под rezka/kinogo/lordfilm.
 */
export async function detectMeta(url) {
  const lower = url.toLowerCase();

  // Быстрый эвристический детект по URL
  if (lower.includes('rezka') || lower.includes('hdrezka')) {
    return {
      site: 'rezka',
      seasons: [1, 2, 3],          // заглушка
      currentSeason: 1,
      currentEpisode: 1,
      voices: ['LostFilm', 'NewStudio', 'Дубляж'],
      currentVoice: 'LostFilm',
    };
  }

  if (lower.includes('kinogo') || lower.includes('kinogo.')) {
    return {
      site: 'kinogo',
      seasons: [1],
      currentSeason: 1,
      currentEpisode: 1,
      voices: [],
    };
  }

  if (lower.includes('lordfilm') || lower.includes('lordserial')) {
    return {
      site: 'lordfilm',
      seasons: [1],
      currentSeason: 1,
      currentEpisode: 1,
      voices: [],
    };
  }

  // Общий fallback — ничего не нашли
  return null;
}