require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gist = require('./gist');

const CLOUDFLARED_PATH = process.env.CLOUDFLARED_PATH || 'cloudflared';
const LOCAL_URL = process.env.TUNNEL_LOCAL_URL || 'http://localhost:3000';
const OUTPUT_FILE = path.join(process.cwd(), 'tunnel-url.txt');

const URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

let captured = false;

function handleOutput(chunk) {
  const text = chunk.toString();
  process.stdout.write(text); // сырой вывод cloudflared показываем как есть

  if (captured) return;

  const match = text.match(URL_REGEX);
  if (match) {
    captured = true;
    onUrlCaptured(match[0]);
  }
}

async function onUrlCaptured(url) {
  fs.writeFileSync(OUTPUT_FILE, url + '\n', 'utf8');
  console.log('\n[tunnel] URL сохранён в', OUTPUT_FILE);
  console.log('[tunnel] >>>', url, '<<<\n');

  try {
    const gistUrl = await gist.pushUrl(url);
    console.log('[tunnel] Также сохранён в Gist:', gistUrl, '\n');
  } catch (err) {
    console.error('[tunnel] Не удалось обновить Gist:', err.message);
  }
}

const cloudflared = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', LOCAL_URL]);

cloudflared.stdout.on('data', handleOutput);
cloudflared.stderr.on('data', handleOutput); // cloudflared обычно пишет URL именно в stderr

cloudflared.on('close', (code) => {
  console.log(`[tunnel] cloudflared завершился с кодом ${code}`);
  captured = false;
});

process.on('SIGINT', () => {
  cloudflared.kill();
  process.exit();
});