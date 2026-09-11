const { exec } = require('child_process');
const config = require('../config');

const status = { state: 'idle', log: [], updatedAt: null };

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout || stderr);
    });
  });
}

async function performUpdate() {
  status.state = 'running';
  status.log = [];
  status.updatedAt = new Date();

  try {
    status.log.push('git fetch origin...');
    status.log.push(await run(`git fetch origin ${config.update.branch}`));

    status.log.push(`git reset --hard origin/${config.update.branch}...`);
    status.log.push(await run(`git reset --hard origin/${config.update.branch}`));

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

module.exports = { performUpdate, getStatus };