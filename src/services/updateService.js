const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const i18n = require('./i18n');

const status = { state: 'idle', log: [], updatedAt: null };
const HASH_RE = /^[0-9a-f]{7,40}$/i;
// имя и версия пакета идут в командную строку — пропускаем только безопасные символы
const PKG_NAME_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const PKG_RANGE_RE = /^[0-9a-z.^~<>=| *+-]+$/i;

// pm2-процессы проекта; тот, что выполняет обновление, перезапускаем последним
const PM2_APPS = ['partywatcher', 'partywatcher-admin'];

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout || stderr);
    });
  });
}

async function getCommits(limit = 100) {
  await run(`git fetch origin ${config.update.branch}`);
  const sep = '\u0001'; // редкий разделитель, чтобы не ломался на запятых/пайпах в сообщении коммита
  const out = await run(
    `git log origin/${config.update.branch} -n ${limit} --date=short --pretty=format:"%H${sep}%h${sep}%an${sep}%ad${sep}%s"`
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, author, date, message] = line.split(sep);
      return { hash, short, author, date, message };
    });
}

// служебная строка журнала: ключ словаря server.update.* — роут статуса переводит её на язык админа
// (вывод git/npm/pm2 остаётся как есть — это строки)
const L = (key, vars) => ({ k: 'server.update.' + key, v: vars });

// Проверяет, что каждая зависимость из package.json реально установлена, и доустанавливает недостающие.
// Страховка на случай, если npm install упал на середине или node_modules собран со старого package.json.
async function ensureDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')); // не require: он кэширует старую версию
  const missing = [];
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (!PKG_NAME_RE.test(name) || !PKG_RANGE_RE.test(String(range))) {
      status.log.push(L('skipDep', { name }));
      continue;
    }
    if (!fs.existsSync(path.join(process.cwd(), 'node_modules', name, 'package.json'))) {
      missing.push(`"${name}@${range}"`);
    }
  }
  if (!missing.length) {
    status.log.push(L('depsOk'));
    return;
  }
  status.log.push(L('depsMissing', { list: missing.join(' ') }));
  status.log.push(await run(`npm install --omit=dev --no-save ${missing.join(' ')}`));
}

async function restartApps() {
  const self = process.env.name; // pm2 кладёт имя приложения в env.name
  const order = [...PM2_APPS.filter((a) => a !== self), ...PM2_APPS.filter((a) => a === self)];
  for (const app of order) {
    status.log.push(`pm2 restart ${app}...`);
    if (app === self) status.state = 'done'; // после рестарта себя записать статус уже не успеем
    try {
      status.log.push(await run(`pm2 restart ${app}`));
    } catch (e) {
      // процесса может не быть (например, админка не запущена) — не повод считать обновление проваленным
      status.log.push(L('restartFailed', { app, error: e.message.slice(0, 200) }));
    }
  }
}

async function performUpdate(targetHash) {
  if (targetHash && !HASH_RE.test(targetHash)) {
    throw i18n.err('server.admin.badHash');
  }

  status.state = 'running';
  status.log = [];
  status.updatedAt = new Date();

  try {
    status.log.push('git fetch origin...');
    status.log.push(await run(`git fetch origin ${config.update.branch}`));

    const target = targetHash || `origin/${config.update.branch}`;
    status.log.push(`git reset --hard ${target}...`);
    status.log.push(await run(`git reset --hard ${target}`));

    status.log.push('npm install...');
    status.log.push(await run('npm install --omit=dev'));

    status.log.push(L('checkingDeps'));
    await ensureDependencies();

    status.log.push('pip install/upgrade yt-dlp...');
    try {
      status.log.push(await run('pip3 install --upgrade "yt-dlp[default]"'));
    } catch (e) {
      status.log.push(L('pipRetry', { error: e.message.slice(0, 150) }));
      status.log.push(await run('pip3 install --upgrade "yt-dlp[default]" --break-system-packages'));
    }

    await restartApps();

    status.state = 'done';
  } catch (err) {
    status.state = 'error';
    status.log.push(L('error', { error: err.i18nKey ? i18n.t(i18n.DEFAULT_LANG, err.i18nKey) : err.message }));
  }
}

function getStatus() {
  return status;
}

module.exports = { performUpdate, getStatus, getCommits };