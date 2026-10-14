// GET /api/admin/logs — логи сервера для админки (раздел «📜 Логи»): хвосты файлов pm2 обоих процессов
// (сайт и админка, out + error), строки «время уровень [тег] текст» (services/logTime.js), склеенные по времени.
// Фильтры: proc=all|site|admin, level=all|warn|error, tag=<тег>, group=<GROUPS>, q=<текст>, since=<минут>,
// order=desc|asc. Строки без времени (до обновления) — без даты, в конце. Только админ; секретов в логах нет
// (почты замаскированы, токенов и ключей сайт не пишет)
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const router = express.Router();
const LOG_DIR = path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'logs');
const TAIL_BYTES = 2 * 1024 * 1024; // с конца каждого файла
const LIMIT = 500;
const LINE_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (INF|WRN|ERR|DBG) ?(.*)$/;
const TAG_RE = /^\[([^\]]{1,40})\]/;
// быстрые группы тегов (кнопки в окне логов)
const GROUPS = {
  live: /^(rtmp|live|clips?|chatBus|chat|raid|points|vods?|vod-cleanup|thumbnail|stats|alerts)\b/i,
  capture: /^(player-?capture|capture|capture-client|stream-relay|kodik|ytdlp|youtube-capture|dropdown|viewer|player)\b/i,
  mail: /^(mailer|support|auth|reg-queue|mail-quota)\b/i,
  security: /^(csp|bans?|unhandledRejection|uncaughtException)\b/i,
  server: /^(assets|perf|server|mongo|analytics|cleanup|categories|news|streamers|admin)\b/i,
};

function logFiles() {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return []; }
  return names
    .map((n) => ({ n, m: /^(partywatcher(?:-admin)?)-(out|error)(?:-\d+)?\.log$/.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ file: path.join(LOG_DIR, x.n), proc: x.m[1] === 'partywatcher' ? 'site' : 'admin', stream: x.m[2] }));
}

function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // первая строка обрезана
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parse({ file, proc, stream }) {
  const out = [];
  let last = null;
  let seq = 0;
  for (const line of tail(file)) {
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (m) {
      last = { t: m[1], lv: m[2], msg: m[3], proc, seq: seq++ };
      out.push(last);
    } else if (last && last.t && /^(\s|at |\}|\])/.test(line)) {
      last.msg += '\n' + line; // продолжение записи: стек ошибки, многострочный объект
    } else {
      last = { t: null, lv: stream === 'error' ? 'ERR' : 'INF', msg: line, proc, seq: seq++ }; // старый формат — без времени
      out.push(last);
    }
  }
  for (const e of out) {
    const tm = TAG_RE.exec(e.msg);
    e.tag = tm ? tm[1] : '';
    if (e.msg.length > 4000) e.msg = e.msg.slice(0, 4000) + ' …';
  }
  return out;
}

// разбор всех файлов держим 3 с: смена фильтров в окне не перечитывает мегабайты каждый раз
let cache = { at: 0, items: [] };
function allEntries() {
  if (Date.now() - cache.at < 3000) return cache.items;
  const items = [];
  for (const f of logFiles()) items.push(...parse(f));
  cache = { at: Date.now(), items };
  return items;
}

router.get('/logs', auth, adminOnly, (req, res) => {
  const proc = ['site', 'admin'].includes(req.query.proc) ? req.query.proc : 'all';
  const level = ['warn', 'error'].includes(req.query.level) ? req.query.level : 'all';
  const tag = String(req.query.tag || '').slice(0, 40);
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  const since = Math.max(0, Math.min(60 * 24 * 30, Number(req.query.since) || 0));
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  const group = GROUPS[req.query.group] || null;

  const from = since ? new Date(Date.now() - since * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
  const base = allEntries().filter((e) => (proc === 'all' || e.proc === proc) && (!from || (e.t && e.t >= from)));
  // теги — по выборке до фильтров тега/уровня/поиска: видно, что вообще есть за период
  const tags = {};
  for (const e of base) if (e.tag) tags[e.tag] = (tags[e.tag] || 0) + 1;

  const items = base.filter((e) =>
    (level === 'all' || (level === 'warn' ? e.lv === 'WRN' || e.lv === 'ERR' : e.lv === 'ERR')) &&
    (!tag || e.tag === tag) &&
    (!group || group.test(e.tag)) &&
    (!q || e.msg.toLowerCase().includes(q)));
  // по времени; без времени (старые) — в конце; одинаковое время — в порядке файла
  items.sort((a, b) => (a.t && b.t ? (a.t < b.t ? -1 : a.t > b.t ? 1 : a.seq - b.seq) : a.t ? -1 : b.t ? 1 : a.seq - b.seq));
  if (order === 'desc') {
    const timed = items.filter((e) => e.t).reverse();
    items.splice(0, items.length, ...timed, ...items.filter((e) => !e.t));
  }
  res.json({
    total: items.length,
    items: items.slice(0, LIMIT).map(({ t, lv, msg, proc: p, tag: tg }) => ({ t, lv, msg, proc: p, tag: tg })),
    tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    files: logFiles().length,
  });
});

module.exports = router;
