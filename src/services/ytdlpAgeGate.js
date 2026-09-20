// ytdlpAgeGate.js
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/home/ubuntu/PartyWatcher/yt-cookies.txt';

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
            const msg = (stderr || err.message || '').slice(0, 800);
            console.error('[ytdlpAgeGate] yt-dlp stderr:\n', msg);
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