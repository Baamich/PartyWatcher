// ytdlpAgeGate.js
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const COOKIES_PATH = path.join(__dirname, '..', 'yt-cookies.txt'); // корень проекта, а не cwd процесса

function extractYoutubeDirect(videoUrl) {
  return new Promise((resolve, reject) => {
    const args = [
        '-f', 'best[ext=mp4]/best',
        '--no-playlist',
        '--dump-json',
        '--remote-components', 'ejs:github',
        '--extractor-args', 'youtube:player_client=mweb',
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    } else {
        console.warn('[ytdlpAgeGate] yt-cookies.txt не найден — возрастные видео с реальным age-gate не откроются');
    }

    args.push(videoUrl);

    execFile(
      'yt-dlp',
      args,
      { maxBuffer: 1024 * 1024 * 20, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.slice(0, 300) || err.message;
          if (/sign in to confirm your age/i.test(msg)) {
            return reject(new Error('YouTube требует подтверждения возраста — нужны свежие куки залогиненного аккаунта (yt-cookies.txt)'));
          }
          return reject(new Error(msg));
        }
        try {
          const info = JSON.parse(stdout);
          if (!info.url) return reject(new Error('yt-dlp не вернул прямую ссылку'));
          resolve({ url: info.url, title: info.title || null });
        } catch (e) {
          reject(new Error('Не удалось распарсить ответ yt-dlp'));
        }
      }
    );
  });
}

module.exports = { extractYoutubeDirect };