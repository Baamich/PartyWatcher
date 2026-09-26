function getQueryFromUrl() {
  return new URLSearchParams(location.search).get('q') || '';
}

async function runSearch() {
  const q = (document.getElementById('searchQueryInput')?.value || '').trim();
  if (!q) return;
  history.replaceState(null, '', `/streams/search.html?q=${encodeURIComponent(q)}`);
  await performSearch(q);
}

function handleSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSearch();
  }
}

async function performSearch(q) {
  const heading = document.getElementById('resultsHeading');
  const grid = document.getElementById('resultsGrid');
  heading.textContent = `Возможно, вы имели в виду:`;

  try {
    const results = await api('/streamers?q=' + encodeURIComponent(q) + '&limit=20');
    renderStreamersList(grid, results, `По запросу «${q}» никого не нашли`);
  } catch (err) {
    console.warn('[performSearch]', err.message);
  }
}

async function init() {
  const q = getQueryFromUrl();
  document.getElementById('searchQueryInput').value = q;
  if (q) await performSearch(q);
  initMeName();
}

init();