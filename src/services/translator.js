// services/translator.js
// Машинный перевод текста (новости). Провайдер:
//   DEEPL_API_KEY задан → DeepL API (ключ с «:fx» — бесплатный тариф, 500 тыс. символов в месяц);
//   иначе → MyMemory без ключа (около 5 тыс. символов в день, с MYMEMORY_EMAIL — около 50 тыс.).
// Хосты фиксированные (не из запроса), поэтому SSRF-проверка не нужна.
const DEEPL_KEY = process.env.DEEPL_API_KEY || '';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const TIMEOUT_MS = 15000;

const DEEPL_TARGET = { en: 'EN-GB', ru: 'RU' };

function providerName() {
  return DEEPL_KEY ? 'deepl' : 'mymemory';
}

async function deepl(texts, from, to) {
  const host = DEEPL_KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await fetch(host + '/v2/translate', {
    method: 'POST',
    headers: { Authorization: 'DeepL-Auth-Key ' + DEEPL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, source_lang: from.toUpperCase(), target_lang: DEEPL_TARGET[to] || to.toUpperCase(), preserve_formatting: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('DeepL HTTP ' + r.status);
  const data = await r.json();
  return (data.translations || []).map((x) => x.text || '');
}

// MyMemory принимает до 500 байт за запрос: режем по строкам и предложениям
function chunks(text, max = 450) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.length <= max) { out.push(line); continue; }
    let cur = '';
    for (const part of line.split(/(?<=[.!?…])\s+/)) {
      if ((cur + ' ' + part).trim().length > max && cur) { out.push(cur); cur = ''; }
      if (part.length > max) { for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max)); continue; }
      cur = (cur ? cur + ' ' : '') + part;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function myMemoryOne(text, from, to) {
  if (!text.trim()) return text;
  const qs = new URLSearchParams({ q: text, langpair: `${from}|${to}` });
  if (MYMEMORY_EMAIL) qs.set('de', MYMEMORY_EMAIL);
  const r = await fetch('https://api.mymemory.translated.net/get?' + qs, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const data = await r.json();
  if (Number(data.responseStatus) !== 200) throw new Error('MyMemory: ' + String(data.responseDetails || data.responseStatus).slice(0, 120));
  return decodeEntities(data.responseData?.translatedText || '');
}

async function myMemory(texts, from, to) {
  const out = [];
  for (const text of texts) {
    // переносы строк сохраняем: переводим кусками и склеиваем по тем же местам
    const parts = [];
    for (const line of String(text).split('\n')) {
      const pieces = [];
      for (const c of chunks(line)) pieces.push(await myMemoryOne(c, from, to));
      parts.push(pieces.join(' '));
    }
    out.push(parts.join('\n'));
  }
  return out;
}

// texts: массив строк → массив переводов (тот же порядок)
async function translate(texts, from, to) {
  if (from === to) return texts.slice();
  return DEEPL_KEY ? deepl(texts, from, to) : myMemory(texts, from, to);
}

// язык текста грубо: есть кириллица — русский, иначе английский
function detectLang(text) {
  const s = String(text || '');
  const cyr = (s.match(/[А-Яа-яЁё]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return cyr >= lat * 0.3 && cyr > 0 ? 'ru' : 'en';
}

module.exports = { translate, detectLang, providerName };
