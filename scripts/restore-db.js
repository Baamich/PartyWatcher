// Восстановление базы из копии scripts/backup-db.js.
//   node scripts/restore-db.js ~/pw-backups/pw-2026-10-14-04-00.pwb --yes   — из файла
//   node scripts/restore-db.js --gist latest --yes                           — из самого свежего Gist (или --gist <id>)
//   --to "<uri>" — куда восстанавливать (по умолчанию MONGO_URI из .env); --check — только проверить, что копия
//   расшифровывается, ничего не трогая. ⚠️ Без --check коллекции в базе ЗАМЕНЯЮТСЯ данными копии (mongorestore --drop)
require('dotenv').config();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const KEY = process.env.BACKUP_KEY;
const TOKEN = process.env.GITHUB_TOKEN;
const TO = opt('--to') || process.env.MONGO_URI;
const API = 'https://api.github.com';
const DESC = 'PartyWatcher DB backup ';

function decrypt(buf, pass) {
  if (buf.subarray(0, 4).toString() !== 'PWB1') throw new Error('это не копия PartyWatcher (нет метки PWB1)');
  const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(32, 48);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(48)), d.final()]); } catch { throw new Error('не расшифровалось: другой BACKUP_KEY или файл повреждён'); }
}

async function gh(url, raw) {
  const res = await fetch(raw ? url : API + url, { signal: AbortSignal.timeout(120000), headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub ${url}: ${res.status}`);
  return raw ? res.text() : res.json();
}

async function fromGist(id) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN не задан');
  if (id === 'latest') {
    const list = await gh('/gists?per_page=100');
    // недогруженные копии (« (загружается)») не берём
    const g = list.filter((x) => String(x.description || '').startsWith(DESC) && !String(x.description).endsWith(' (загружается)'))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!g) throw new Error('копий в Gist нет');
    id = g.id;
    console.log('[restore] самая свежая копия:', g.description);
  }
  const gist = await gh('/gists/' + id);
  const manifest = JSON.parse(await gh(gist.files['backup.json'].raw_url, true));
  let b64 = '';
  for (let i = 1; i <= manifest.parts; i++) {
    const f = gist.files[`part-${String(i).padStart(3, '0')}.txt`];
    if (!f) throw new Error('в Gist нет части ' + i);
    b64 += (await gh(f.raw_url, true)).trim();
  }
  const enc = Buffer.from(b64, 'base64');
  if (crypto.createHash('sha256').update(enc).digest('hex') !== manifest.sha256) throw new Error('контрольная сумма не сошлась');
  return enc;
}

function restore(archive) {
  return new Promise((resolve, reject) => {
    const p = spawn('mongorestore', ['--uri=' + TO, '--archive', '--gzip', '--drop'], { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('mongorestore ' + code))));
    p.stdin.end(archive);
  });
}

(async () => {
  if (!KEY) throw new Error('BACKUP_KEY не задан');
  const gistId = opt('--gist');
  const file = args.find((a) => !a.startsWith('--') && a !== gistId && a !== opt('--to'));
  if (!gistId && !file) throw new Error('укажи файл копии или --gist latest');
  const enc = gistId ? await fromGist(gistId) : fs.readFileSync(file);
  const archive = decrypt(enc, KEY);
  console.log(`[restore] копия расшифрована: ${Math.round(archive.length / 1024)} КБ`);
  if (args.includes('--check')) return console.log('[restore] проверка прошла, база не тронута');
  if (!args.includes('--yes')) throw new Error('добавь --yes: коллекции в базе будут заменены данными копии');
  await restore(archive);
  console.log('[restore] готово');
})().catch((e) => {
  console.error('[restore] ОШИБКА:', e.message);
  process.exit(1);
});
