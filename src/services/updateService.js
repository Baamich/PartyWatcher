// src/services/updateService.js
const simpleGit = require('simple-git');
const { exec } = require('child_process');
const config = require('../config');

const status = { state: 'idle', log: [], updatedAt: null };

function buildAuthRepoUrl() {
  if (!config.update.repoUrl) throw new Error('GITHUB_REPO_URL не задан');
  const url = new URL(config.update.repoUrl);
  if (config.update.accessToken) {
    url.username = 'oauth2';
    url.password = config.update.accessToken;
  }
  return url.toString();
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: process.cwd() }, (err, stdout, stderr) => {
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
    status.log.push('git pull...');
    const git = simpleGit(process.cwd());
    const pullResult = await git.pull(buildAuthRepoUrl(), config.update.branch);
    status.log.push(JSON.stringify(pullResult.summary || pullResult));

    status.log.push('npm install...');
    status.log.push(await run('npm install --omit=dev'));

    status.log.push('pm2 reload...');
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