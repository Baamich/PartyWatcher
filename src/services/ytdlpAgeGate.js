// ytdlpAgeGate.js
const { execFile } = require('child_process');

function extractYoutubeDirect(videoUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      ['-f', 'best[ext=mp4]/best', '--no-playlist', '--dump-json', videoUrl],
      { maxBuffer: 1024 * 1024 * 20, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.slice(0, 300) || err.message));
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