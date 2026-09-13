const { exec } = require('child_process');
const config = require('../config');

const status = { state: 'idle', log: [], updatedAt: null };
const HASH_RE = /^[0-9a-f]{7,40}$/i;

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

async function performUpdate(targetHash) {
  if (targetHash && !HASH_RE.test(targetHash)) {
    throw new Error('Некорректный хэш коммита');
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

    status.log.push('pm2 reload partywatcher...');
    status.log.push(await run('pm2 reload partywatcher'));

    status.state = 'done';
  } catch (err) {
    status.state = 'error';
    status.log.push('ОШИБКА: ' + err.message);
  }
}

function getStatus() {
  return status;
}

module.exports = { performUpdate, getStatus, getCommits };