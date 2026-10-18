// services/adultContent.js — видео 18+ (порно) по адресу ссылки.
// Такие комнаты никогда не показываются в публичном списке, создавать и открывать их могут только админ и друзья
// (services/roles.js), при входе сайт ещё спрашивает возраст (room.js → ensureAdult).
// Только имя хоста: сам сайт не открываем, сервер не нагружаем.

const ADULT_HOSTS = [
  'pornhub.com', 'pornhub.org', 'pornhubpremium.com', 'xvideos.com', 'xvideos2.com', 'xvideos.red', 'xnxx.com', 'xnxx.tv',
  'xhamster.com', 'xhamster.desi', 'xhamster2.com', 'xhamsterlive.com', 'redtube.com', 'youporn.com', 'tube8.com',
  'spankbang.com', 'eporner.com', 'beeg.com', 'txxx.com', 'hqporner.com', 'motherless.com', 'porntrex.com',
  '4tube.com', 'fuq.com', 'tnaflix.com', 'empflix.com', 'drtuber.com', 'sunporno.com', 'ixxx.com', 'porn.com',
  'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'cam4.com', 'myfreecams.com',
  'camsoda.com', 'livejasmin.com', 'manyvids.com', 'clips4sale.com', 'brazzers.com', 'realitykings.com', 'bangbros.com',
  'nhentai.net', 'hanime.tv', 'rule34.xxx', 'rule34video.com', 'e-hentai.org', 'thisvid.com', 'daftsex.com',
  'sex.com', 'porno365.best', 'pornolab.net', 'rusporn.porn', 'xcadr.online',
  // CDN этих сайтов: прямая ссылка на файл/плейлист (тип «Прямая ссылка») иначе не распознавалась как 18+
  'phncdn.com', 'xvideos-cdn.com', 'xnxx-cdn.com', 'xhcdn.com', 'xhpingcdn.com', 'xhamster.one', 'rdtcdn.com',
  'ypncdn.com', 'tube8cdn.com', 'sb-cd.com', 'spankbang.party', 'eporner.net', 'tnaflix.org', 'motherlessmedia.com',
];
// слова в имени хоста (не «sex»: попадут sussex/essex и подобное)
const ADULT_WORDS = /porn|xxx|hentai/i;

function hostOf(url) {
  try {
    return new URL(String(url || '').trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isAdultUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (ADULT_WORDS.test(host)) return true;
  return ADULT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// эфир 18+ (эротические сцены, не порно): метка стримера в студии (User.streamAdult) или «18+» в названии эфира —
// условия разрешают оба способа. До плеера — окно возраста (streamer.js), на главной каталога такого эфира нет
const ADULT_TITLE = /(^|[^\d])18\s*\+/;
const isAdultStream = (u) => !!(u && (u.streamAdult || ADULT_TITLE.test(u.streamTitle || '')));

// видит ли зритель эфиры 18+ в каталогах: аккаунт — хоть раз подтвердил возраст в окне «Тебе есть 18?»
// (User.adultConfirmed, не отменяется — признак из запроса не берём), гость — отметка того же окна на устройстве (?adult=1).
// Подтвердившие запоминаются в памяти: подтверждение не отменяется, а неподтвердившего спрашиваем у базы заново
const adultSeen = new Set();
async function seesAdultStreams(req) {
  if (!req.user) return req.query?.adult === '1';
  const id = String(req.user.id);
  if (adultSeen.has(id)) return true;
  const u = await require('../models/User').findById(id).select('adultConfirmed -_id').lean();
  if (!u?.adultConfirmed) return false;
  if (adultSeen.size > 20000) adultSeen.clear();
  adultSeen.add(id);
  return true;
}

module.exports = { isAdultUrl, isAdultStream, seesAdultStreams };
