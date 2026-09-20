// ytdlpAgeGate.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/home/ubuntu/PartyWatcher/yt-cookies.txt';
const CACHE_DIR = process.env.YT_CACHE_DIR || '/home/ubuntu/PartyWatcher/yt-cache';

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function runYtDlp(videoUrl, outFile, playerClient) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--remote-components', 'ejs:github',
      '--extractor-args', `youtube:player_client=${playerClient}`,
      '-o', outFile,
    ];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push(videoUrl);

    execFile(
      'yt-dlp',
      args,
      { maxBuffer: 1024 * 1024 * 50, timeout: 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').slice(0, 800)));
        resolve();
      }
    );
  });
}

function touchFile(filePath) {
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch (e) {
    console.warn('[ytdlpAgeGate] не удалось обновить mtime кэша:', e.message);
  }
}

async function extractYoutubeDirect(videoUrl) {
  const id = crypto.createHash('md5').update(videoUrl).digest('hex');
  const outFile = path.join(CACHE_DIR, `${id}.mp4`);

  // уже качали это видео раньше — отдаём из кэша мгновенно и продлеваем ему жизнь
  if (fs.existsSync(outFile)) {
    touchFile(outFile);
    return { url: `/media/yt-cache/${id}.mp4`, title: null };
  }

  const clientsToTry = ['tv', 'web_safari', 'mweb'];
  let lastErr;

  for (const client of clientsToTry) {
    try {
      await runYtDlp(videoUrl, outFile, client);
      if (fs.existsSync(outFile)) {
        console.log(`[ytdlpAgeGate] успех через client=${client}`);
        return { url: `/media/yt-cache/${id}.mp4`, title: null };
      }
    } catch (e) {
      lastErr = e;
      console.warn(`[ytdlpAgeGate] client=${client} не сработал: ${e.message.slice(0, 200)}`);
      try { fs.unlinkSync(outFile); } catch (_) {}
    }
  }

  throw lastErr || new Error('Не удалось скачать видео ни одним клиентом');
}

module.exports = { extractYoutubeDirect };