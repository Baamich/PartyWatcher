// Правила чата канала: перед первым сообщением зритель видит правила сайта + стримера и жмёт «Согласиться».
// Согласие — подписанная отметка у зрителя в localStorage (pw_chat_rules), без записи в базу:
// «время.подпись» от (пользователь, канал, версия правил, время). Подписан на канал — отметка бессрочная,
// не подписан — действует сутки. Поменялись правила стримера или сайта — отметка больше не подходит
const crypto = require('crypto');
const config = require('../config');

// правила сайта в плашке (common.chatRules.site*) поменялись по смыслу — подними, и все примут заново
const SITE_RULES_V = 1;
const MAX_LEN = 1000;
const DAY = 24 * 60 * 60 * 1000;

const versionOf = (text) => crypto.createHash('sha1').update(SITE_RULES_V + '\n' + (text || '')).digest('hex').slice(0, 12);
const sig = (userId, room, ver, at) =>
  crypto.createHmac('sha256', config.jwt.secret).update(`chat-rules|${userId}|${room}|${ver}|${at}`).digest('base64url').slice(0, 22);

function sign(userId, room, ver, at = Date.now()) {
  return `${at}.${sig(userId, room, ver, at)}`;
}

// время согласия из отметки или 0 (чужая, старая версия правил, подделка)
function acceptedAt(token, userId, room, ver) {
  const m = /^(\d{10,15})\.([\w-]{22})$/.exec(String(token || ''));
  if (!m) return 0;
  const at = Number(m[1]);
  if (at > Date.now() + 60000) return 0;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(sig(userId, room, ver, at));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? at : 0;
}

// согласие ещё действует: подписчику — всегда, остальным — сутки
const stillValid = (at, followed) => !!at && (followed || Date.now() - at < DAY);

// текст из студии: обрезаем пробелы, не больше 30 строк, пустые строки подряд схлопываем
function clean(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().split('\n').slice(0, 30).join('\n');
}

module.exports = { MAX_LEN, versionOf, sign, acceptedAt, stillValid, clean };
