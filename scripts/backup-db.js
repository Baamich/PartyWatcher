// Резервная копия базы: mongodump (весь архив, gzip) → шифрование AES-256-GCM ключом BACKUP_KEY →
//   1) файл в BACKUP_DIR (по умолчанию ~/pw-backups), хранятся последние BACKUP_KEEP (7);
//   2) секретный Gist на GitHub (токен GITHUB_TOKEN, право gist): каждая копия — свой Gist, частями по 900 КБ,
//      старше BACKUP_KEEP дней удаляются. GitHub видит только шифротекст: без BACKUP_KEY копию не прочитать.
// Запуск: node scripts/backup-db.js (cron — раз в сутки). Восстановление — scripts/restore-db.js.
// ⚠️ BACKUP_KEY храни ещё где-то кроме сервера (менеджер паролей): без него копии бесполезны.
require('dotenv').config();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = process.env.BACKUP_KEY;
const URI = process.env.MONGO_URI;
const TOKEN = process.env.GITHUB_TOKEN;
const DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'pw-backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
const PART = 900 * 1024; // часть Gist меньше 1 МБ — API отдаёт её целиком
const DESC = 'PartyWatcher DB backup ';
const PENDING = ' (загружается)'; // пока не загружены все части: restore такую копию не берёт, старые недогруженные удаляются
const API = 'https://api.github.com';

const MAGIC = Buffer.from('PWB1');

function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

function dump() {
  return new Promise((resolve, reject) => {
    const p = spawn('mongodump', ['--uri=' + URI, '--archive', '--gzip', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    p.on('error', reject);
    // в ошибке mongodump может быть адрес базы с паролем — его не выводим
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('mongodump ' + code + ': ' + err.replace(/mongodb(\+srv)?:\/\/[^\s"']+/g, '<uri>')))));
  });
}

async function gh(method, url, body) {
  const res = await fetch(API + url, {
    signal: AbortSignal.timeout(120000), // зависший запрос не держит скрипт вечно
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function toGist(enc, stamp) {
  const b64 = enc.toString('base64');
  const parts = [];
  for (let i = 0; i < b64.length; i += PART) parts.push(b64.slice(i, i + PART));
  const manifest = { v: 1, stamp, bytes: enc.length, sha256: crypto.createHash('sha256').update(enc).digest('hex'), parts: parts.length };
  const gist = await gh('POST', '/gists', {
    description: DESC + stamp + PENDING,
    public: false,
    files: { 'backup.json': { content: JSON.stringify(manifest, null, 2) } },
  });
  try {
    // части — по одной: запрос в несколько МБ GitHub может не принять
    for (let i = 0; i < parts.length; i++) {
      const t = Date.now();
      await gh('PATCH', '/gists/' + gist.id, { files: { [`part-${String(i + 1).padStart(3, '0')}.txt`]: { content: parts[i] } } });
      console.log(`[backup] часть ${i + 1}/${parts.length} загружена (${Math.round((Date.now() - t) / 1000)} с)`);
    }
    await gh('PATCH', '/gists/' + gist.id, { description: DESC + stamp }); // готово — теперь restore её видит
  } catch (e) {
    await gh('DELETE', '/gists/' + gist.id).catch(() => {}); // недогруженную копию не оставляем
    throw e;
  }
  // старые копии: каждая — свой Gist, удаляем старше KEEP дней; недогруженные (прерванный запуск) — старше часа
  const cutoff = Date.now() - KEEP * 86400000;
  for (let page = 1; page <= 10; page++) {
    const list = await gh('GET', `/gists?per_page=100&page=${page}`);
    for (const g of list) {
      const d = String(g.description || '');
      const age = new Date(g.created_at).getTime();
      const stale = d.endsWith(PENDING) ? age < Date.now() - 3600000 : age < cutoff;
      if (g.id !== gist.id && d.startsWith(DESC) && stale) {
        await gh('DELETE', '/gists/' + g.id);
        console.log('[backup] удалён старый Gist', g.description);
      }
    }
    if (list.length < 100) break;
  }
  return { id: gist.id, parts: parts.length };
}

function toDisk(enc, stamp) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `pw-${stamp}.pwb`);
  fs.writeFileSync(file, enc, { mode: 0o600 });
  const old = fs.readdirSync(DIR).filter((f) => /^pw-.*\.pwb$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.unlinkSync(path.join(DIR, f));
  return file;
}

(async () => {
  if (!URI) throw new Error('MONGO_URI не задан');
  if (!KEY || KEY.length < 16) throw new Error('BACKUP_KEY не задан (или короче 16 символов) — без шифрования копию не делаем');
  const t = Date.now();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16); // 2026-10-14-04-00
  const raw = await dump();
  const enc = encrypt(raw, KEY);
  const file = toDisk(enc, stamp);
  console.log(`[backup] ${stamp}: архив ${Math.round(raw.length / 1024)} КБ → ${file}`);
  if (TOKEN) console.log(`[backup] загружаю в Gist (${Math.ceil(enc.length * 4 / 3 / PART)} част., может занять пару минут)…`);
  if (TOKEN) {
    const g = await toGist(enc, stamp);
    console.log(`[backup] в Gist ${g.id}: ${g.parts} част., ${Math.round((Date.now() - t) / 1000)} с`);
  } else {
    console.warn('[backup] GITHUB_TOKEN не задан — копия только на диске');
  }
})().catch((e) => {
  console.error('[backup] ОШИБКА:', e.message);
  process.exit(1);
});
