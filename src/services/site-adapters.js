// services/site-adapters.js
module.exports = {
  rezka: {
    playerFrameMatch: (frameUrl) => frameUrl.includes('balabolka.stravers.live'),
    episodeDropdownTrigger: 'div[data-select="episodeType1"] .select__item',
    episodeButtonSelector: (id) => `div[data-select="episodeType1"] button.select__drop-item[data-id="${id}"]`,
    episodeListSelector: 'div[data-select="episodeType1"] button.select__drop-item',
    scheduleRowSelector: 'tr.epscape_tr',
    scheduleRowParser: (row) => {
      const cells = row.querySelectorAll('td');
      const fullText = cells[0]?.textContent.trim() || '';
      const countdownText = cells[3]?.textContent.trim() || '';
      const match = fullText.match(/(\d+)\s*сезон\s*(\d+)\s*серия/i);
      return {
        season: match ? Number(match[1]) : 1,
        episode: match ? Number(match[2]) : null,
        released: countdownText === '',
      };
    },
  },

  // TODO: заполнить реальными селекторами после дампа DOM
  kinogo: null,
  lordfilm: null,
};