require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gist = require('./gist');

const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH || 'cloudflared';
const LOCAL_URL = process.env.TUNNEL_LOCAL_URL || 'http://localhost:3000';

// имя туннеля — влияет на имя файла и ключ в Gist, чтобы основной и админский
// туннели не затирали друг друга; по умолчанию — старое поведение (main)
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'main';
const OUTPUT_FILE = path.join(process.cwd(), `tunnel-${TUNNEL_NAME}-url.txt`);

const URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

let captured = false;

function handleOutput(chunk) {
  const text = chunk.toString();
  process.stdout.write(`[${TUNNEL_NAME}] ${text}`);

  if (captured) return;

  const match = text.match(URL_REGEX);
  if (match) {
    captured = true;
    onUrlCaptured(match[0]);
  }
}

async function onUrlCaptured(url) {
  fs.writeFileSync(OUTPUT_FILE, url + '\n', 'utf8');
  console.log(`\n[tunnel:${TUNNEL_NAME}] URL сохранён в`, OUTPUT_FILE);
  console.log(`[tunnel:${TUNNEL_NAME}] >>>`, url, '<<<\n');

  try {
    const gistUrl = await gist.pushUrl(url, TUNNEL_NAME); // второй аргумент — см. примечание ниже
    console.log(`[tunnel:${TUNNEL_NAME}] Также сохранён в Gist:`, gistUrl, '\n');
  } catch (err) {
    console.error(`[tunnel:${TUNNEL_NAME}] Не удалось обновить Gist:`, err.message);
  }
}

const cloudflared = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', LOCAL_URL]);

cloudflared.stdout.on('data', handleOutput);
cloudflared.stderr.on('data', handleOutput);

cloudflared.on('close', (code) => {
  console.log(`[tunnel:${TUNNEL_NAME}] cloudflared завершился с кодом ${code}`);
  captured = false;
});

process.on('SIGINT', () => {
  cloudflared.kill();
  process.exit();
});