const simpleGit = require('simple-git');
const { exec } = require('child_process');
const config = require('../config');

function buildAuthRepoUrl() {
  if (!config.update.repoUrl) throw new Error('GITHUB_REPO_URL не задан');
  const url = new URL(config.update.repoUrl);
  if (config.update.accessToken) {
    url.username = 'oauth2';
    url.password = config.update.accessToken;
  }
  return url.toString();
}

async function pullLatestCode() {
  const git = simpleGit(process.cwd());
  return git.pull(buildAuthRepoUrl(), config.update.branch);
}

function reloadPm2() {
  return new Promise((resolve, reject) => {
    exec('pm2 reload partywatcher', (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout || stderr);
    });
  });
}

async function performUpdate() {
  const pullResult = await pullLatestCode();
  const reloadOutput = await reloadPm2();
  return { pullResult, reloadOutput };
}

module.exports = { performUpdate };