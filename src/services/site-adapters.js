// services/site-adapters.js
//
// Два режима адаптера:
//
// 'schedule-table' — на самой странице сайта (не в плеере) есть таблица
//   с расписанием серий, а внутри плеера свой домен-фрейм с дропдауном,
//   где пункты имеют data-id. Пример: rezka (плеер balabolka).
//
// 'dropdown' — сезон/серия известны ТОЛЬКО из дропдаунов внутри самого
//   плеера, пункты списка различаются только текстом, без data-id,
//   и нет отдельной таблицы расписания. Пример: kinogo (плеер "allplay").
//   Плеер ищется не по домену фрейма (он может быть любым), а по
//   CSS-селектору markerSelector — во всех фреймах страницы.

module.exports = {
  rezka: {
    mode: 'schedule-table',
    playerFrameMatch: (frameUrl) =>
      frameUrl.includes('balabolka.stravers.live') && !/\/(series|films)\/.+\.html/.test(frameUrl),
    episodeDropdownTrigger: 'div[data-select="episodeType1"] .select__item',
    episodeButtonSelector: (id) => `div[data-select="episodeType1"] button.select__drop-item[data-id="${id}"]`,
    episodeListSelector: 'div[data-select="episodeType1"] button.select__drop-item',
    scheduleRowSelector: 'tr.epscape_tr',
    scheduleRowParserBody: `
      const cells = row.querySelectorAll('td');
      const fullText = cells[0]?.textContent.trim() || '';
      const countdownText = cells[3]?.textContent.trim() || '';
      const match = fullText.match(/(\\d+)\\s*сезон\\s*(\\d+)\\s*серия/i);
      return {
        season: match ? Number(match[1]) : 1,
        episode: match ? Number(match[2]) : null,
        released: countdownText === '',
      };
    `,
  },

    // kinogo2026.com — отдельное зеркало. Без прокси сервер отдаёт честный 503
  // (бан/лимит по IP), поэтому держим его отдельным объектом: свой useProxy,
  // свои таймауты антибота, и потом можно точечно поправить селекторы,
  // не трогая обычный kinogo
  kinogo2026: {
    mode: 'dropdown',
    markerSelector: '.allplay, [data-select="episodeType1"], [data-select="seasonType1"], .select__item',
    seasonDropdownTrigger: 'div[data-select="seasonType1"] .select__item, [data-select="seasonType1"]',
    seasonListContainer: 'div[data-select="seasonType1"] .select__drop, [data-select="seasonType1"] .select__drop',
    episodeDropdownTrigger: 'div[data-select="episodeType1"] .select__item, [data-select="episodeType1"]',
    episodeListContainer: 'div[data-select="episodeType1"] .select__drop, [data-select="episodeType1"] .select__drop',
    playerTabsSelector: 'ul.tabs li[data-src]',
    dropdownTimeoutMs: 4000,
    useProxy: true,
    antibotRetries: 3,
    antibotWaitMs: 8000,
  },

  kinogo: {
    mode: 'dropdown',
    markerSelector: '.allplay, [data-select="episodeType1"], [data-select="seasonType1"], .select__item',
    seasonDropdownTrigger: 'div[data-select="seasonType1"] .select__item, [data-select="seasonType1"]',
    seasonListContainer: 'div[data-select="seasonType1"] .select__drop, [data-select="seasonType1"] .select__drop',
    episodeDropdownTrigger: 'div[data-select="episodeType1"] .select__item, [data-select="episodeType1"]',
    episodeListContainer: 'div[data-select="episodeType1"] .select__drop, [data-select="episodeType1"] .select__drop',
    playerTabsSelector: 'ul.tabs li[data-src]',
    dropdownTimeoutMs: 4000,
  },

  // mg.lordfilm.md / lordserial — плеер ortified + allplay-подобные
  // дропдауны (data-select="episodeType1"). Adblocker ОБЯЗАТЕЛЬНО выключен
  // (см. isLordfilmFamily в playerCapture.routes.js): иначе режет
  // s.myangular.life и плеер/скрипты не поднимаются.
  // Вкладки плееров — .tabs-sel span (не ul.tabs li[data-src] как на kinogo),
  // поэтому playerTabsSelector здесь не ставим: фронт при отсутствии streams
  // сам перебирает, а переключение серии идёт через dropdown в iframe.
  lordfilm: {
    mode: 'dropdown',
    markerSelector:
      '.allplay, [data-select="episodeType1"], [data-select="seasonType1"], .select__item, .select__drop-item',
    seasonDropdownTrigger:
      'div[data-select="seasonType1"] .select__item, [data-select="seasonType1"]',
    seasonListContainer:
      'div[data-select="seasonType1"] .select__drop, [data-select="seasonType1"] .select__drop',
    episodeDropdownTrigger:
      'div[data-select="episodeType1"] .select__item, [data-select="episodeType1"]',
    episodeListContainer:
      'div[data-select="episodeType1"] .select__drop, [data-select="episodeType1"] .select__drop',
    // iframe плеера: api.ortified.ws / stiven-king (как в логах mg.lordfilm.md)
    playerFrameMatch: (frameUrl) =>
      /ortified\.ws|stiven-king\.com|cdn\.lordfilm/i.test(frameUrl || ''),
    dropdownTimeoutMs: 5000,
  },

  yandex: {
    mode: null,
    frameMatch: (frameUrl) => frameUrl.includes('my.mail.ru/video/embed'),
    playSelector: 'video, .player, [class*="play"]',
  },

  mailru: {
    mode: null,
    frameMatch: (frameUrl) => frameUrl.includes('my.mail.ru/video/embed'),
    playSelector: 'video, .player, [class*="play"]',
  },
};