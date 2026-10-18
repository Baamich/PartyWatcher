// Пускать ли канал стримера в поисковики (Google, Яндекс, Bing): noindex на странице и нет в sitemap.xml, если
//  - стример выключил галочку «Показывать канал в поисковиках» (User.searchIndex, по умолчанию включена);
//  - эфир 18+ сейчас или был за последние ADULT_DAYS дней (JMStV: 18+ в поиск не отдаём);
//  - мало эфиров. Засчитывается эфир от MIN_SEC; в поиске, если в этом месяце уже NEED эфиров, или канал
//    «перенёс» поиск с прошлого месяца: CARRY_NEW эфиров за месяц — канал в поиске и весь следующий месяц,
//    дальше для переноса хватает CARRY_KEEP в месяц; меньше — перенос теряется, снова с NEED (и CARRY_NEW).
// Счётчик — User.seo { m: 'YYYY-MM' (UTC), n, carry, adultAt }: пишет rtmpServer в конце эфира, а смена месяца
// считается при чтении (current) — без задач по расписанию.
const User = require('../models/User');
const StreamSession = require('../models/StreamSession');
const { isAdultStream } = require('./adultContent');

const MIN_SEC = 30 * 60;
const NEED = 5;
const CARRY_NEW = 12;
const CARRY_KEEP = 8;
const ADULT_DAYS = 30;
const DAY = 24 * 3600 * 1000;

// поля User, нужные для решения
const FIELDS = 'streamerNameLower searchIndex streamAdult streamTitle seo';

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
function shiftMonth(m, d) {
  const [y, mo] = m.split('-').map(Number);
  const x = new Date(Date.UTC(y, mo - 1 + d, 1));
  return x.toISOString().slice(0, 7);
}

// состояние на текущий месяц: прошедшие месяцы закрываются по порядку (месяц без эфиров — 0)
function current(seo, now = Date.now()) {
  const m = monthOf(now);
  let s = { m: seo && seo.m ? seo.m : m, n: (seo && seo.n) || 0, carry: !!(seo && seo.carry) };
  if (s.m > m) return { m, n: 0, carry: false }; // часы сервера ушли назад
  for (let i = 0; s.m < m && i < 3; i++) {
    s = { m: shiftMonth(s.m, 1), n: 0, carry: s.n >= (s.carry ? CARRY_KEEP : CARRY_NEW) };
  }
  if (s.m < m) s = { m, n: 0, carry: false }; // эфиров не было несколько месяцев
  return s;
}

function adultRecently(u, now) {
  if (isAdultStream(u)) return true;
  const at = u.seo && u.seo.adultAt;
  return !!at && now - new Date(at).getTime() < ADULT_DAYS * DAY;
}

function isIndexable(u, now = Date.now()) {
  if (!u || !u.streamerNameLower) return false;
  if (u.searchIndex === false || adultRecently(u, now)) return false;
  const s = current(u.seo, now);
  return s.carry || s.n >= NEED;
}

// для студии: в поиске ли канал и сколько ещё эфиров нужно в этом месяце
function status(u, now = Date.now()) {
  const s = current(u && u.seo, now);
  return {
    indexed: isIndexable(u, now),
    off: !!u && u.searchIndex === false,
    adult: !!u && adultRecently(u, now),
    streams: s.n,
    need: s.carry ? 0 : Math.max(0, NEED - s.n),
    minMinutes: MIN_SEC / 60,
  };
}

// конец эфира (rtmpServer.setLiveState): засчитать эфир, запомнить 18+
async function onStreamEnd(userId, sec, adult) {
  const u = await User.findById(userId).select('seo').lean();
  const s = current(u && u.seo);
  if (sec >= MIN_SEC) s.n += 1;
  const adultAt = adult ? new Date() : (u && u.seo && u.seo.adultAt) || null;
  await User.updateOne({ _id: userId }, { $set: { seo: { ...s, adultAt } } });
}

// один раз для стримеров без счётчика: эфиры этого и прошлого месяца из StreamSession (они живут 40 дней)
async function backfill() {
  const users = await User.find({ streamerNameLower: { $ne: null }, 'seo.m': { $exists: false } }).select('_id').lean();
  if (!users.length) return;
  const m = monthOf(Date.now());
  const pm = shiftMonth(m, -1);
  const rows = await StreamSession.aggregate([
    { $match: { endedAt: { $gte: new Date(pm + '-01T00:00:00Z') }, sec: { $gte: MIN_SEC } } },
    { $group: { _id: { u: '$streamerId', m: { $dateToString: { format: '%Y-%m', date: '$endedAt' } } }, n: { $sum: 1 } } },
  ]);
  const count = new Map(rows.map((r) => [`${r._id.u}|${r._id.m}`, r.n]));
  const ops = users.map((u) => {
    const s = current({ m: pm, n: count.get(`${u._id}|${pm}`) || 0, carry: false });
    s.n = count.get(`${u._id}|${m}`) || 0;
    return { updateOne: { filter: { _id: u._id, 'seo.m': { $exists: false } }, update: { $set: { seo: { ...s, adultAt: null } } } } };
  });
  for (let i = 0; i < ops.length; i += 500) await User.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  console.log(`[searchIndex] счётчик эфиров заполнен у ${ops.length} стримеров`);
}

// эфир начался/закончился: сказать поисковикам, если канал в поиске. Через 90 с — к этому времени страница
// стримера (кэш 60 с в services/seo.js) уже в новом состоянии, а у эфира есть кадр для значка LIVE
const NOTIFY_DELAY = 90 * 1000;
function notifyLater(userId, kind) {
  setTimeout(async () => {
    try {
      const u = await User.findById(userId).select(FIELDS + ' isLive').lean();
      if (!u || !isIndexable(u) || (kind === 'start' && !u.isLive)) return;
      require('./searchPing').streamChanged(u.streamerNameLower, kind);
    } catch (e) {
      console.warn('[searchIndex] notify', e.message);
    }
  }, NOTIFY_DELAY).unref();
}

module.exports = { FIELDS, MIN_SEC, NEED, current, isIndexable, status, onStreamEnd, backfill, notifyLater };
