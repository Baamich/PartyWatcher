require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILENAME = process.env.GIST_FILENAME || 'partywatcher-tunnel-url.txt';
let GIST_ID = process.env.GIST_ID; // пусто при первом запуске

const API_BASE = 'https://api.github.com';

async function pushUrl(url) {
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN не задан в .env');
  }

  const body = {
    description: 'PartyWatcher — текущий адрес Cloudflare Tunnel',
    public: false,
    files: {
      [GIST_FILENAME]: { content: url },
    },
  };

  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let res;

  if (GIST_ID) {
    // обновляем существующий gist
    res = await fetch(`${API_BASE}/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  } else {
    // первый запуск — создаём новый
    res = await fetch(`${API_BASE}/gists`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }

  const data = await res.json();

  if (!GIST_ID) {
    GIST_ID = data.id;
    console.log(`\n[gist] Создан новый Gist. Сохрани в .env: GIST_ID=${GIST_ID}\n`);
  }

  return data.html_url;
}

module.exports = { pushUrl };