// streaks.js — серия просмотров: сколько эфирных дней канала подряд зритель смотрел.
// День — по Москве: несколько эфиров за день считаются одним, сброс в 24:00 МСК. Эфир, начатый до полуночи, целиком
// относится к своему дню (просмотр после полуночи в том же эфире новый день не даёт).
// День засчитывается после минуты просмотра идущего эфира (chatSocket проверяет по points.watchedMs). Серия продолжается,
// если зритель смотрел прошлый эфирный день канала (StreamSession); дни, когда стример не выходил в эфир, серию не рвут.
// Пропустил — серия начинается с 1, а в этот день прежнюю можно восстановить: 3 раза в месяц (МСК) на канал.
// На рубежах 3, 5, 10, 13, 15, 20, 25, 30… зритель видит в чате «видно только вам» и может поделиться — тогда серия
// уходит в чат всем, в события (алерт OBS) и зритель получает стрим-поинты (один раз за день)
const WatchStreak = require('../models/WatchStreak');
const StreamSession = require('../models/StreamSession');

const MSK_MS = 3 * 3600 * 1000;
const RESTORES_PER_MONTH = 3;
const FIRST = [3, 5, 10, 13, 15];

const isMilestone = (n) => FIRST.includes(n) || (n >= 20 && n % 5 === 0);
// награда за то, что поделился: до 10-й серии — 100–200, с 10-й — 500
const rewardFor = (n) => (n >= 10 ? 500 : n >= 5 ? 200 : 100);
// 'YYYY-MM-DD' по Москве
const dayOf = (d) => new Date(new Date(d).getTime() + MSK_MS).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(day + 'T00:00:00Z') - MSK_MS); // 00:00 МСК этого дня
const monthOf = (day) => day.slice(0, 7);
const restoresLeft = (doc, day) => (doc?.restoreMonth === monthOf(day) ? Math.max(0, RESTORES_PER_MONTH - (doc.restoresUsed || 0)) : RESTORES_PER_MONTH);

// что показать зрителю «видно только вам» на этот день
function notices(doc, day) {
  const out = {};
  if (isMilestone(doc.count) && doc.sharedDay !== day) out.notice = { count: doc.count, points: rewardFor(doc.count) };
  if (doc.brokenDay === day && doc.lostCount >= 2) out.lost = { lost: doc.lostCount, left: restoresLeft(doc, day), max: RESTORES_PER_MONTH };
  return out;
}

// засчитать день текущего эфира (startedAt — liveStartedAt канала) → { count, notice?, lost? }
async function touch(streamerId, userId, startedAt) {
  const day = dayOf(startedAt);
  const doc = await WatchStreak.findOne({ streamerId, userId }).lean();
  // запись старого вида (до дней): последний эфир → его день
  const lastDay = doc?.lastDay || (doc?.lastStreamAt ? dayOf(doc.lastStreamAt) : null);
  if (doc && lastDay === day) return { count: doc.count, ...notices(doc, day) };

  const next = { count: 1, lastDay: day, brokenDay: doc?.brokenDay || null, lostCount: doc?.lostCount || 0 };
  if (lastDay) {
    // прошлый эфирный день канала — день последнего эфира, начатого до сегодняшних 00:00 МСК
    const prev = await StreamSession.findOne({ streamerId, startedAt: { $lt: dayStart(day) } }).sort({ startedAt: -1 }).select('startedAt').lean();
    if (!prev || lastDay >= dayOf(prev.startedAt)) next.count = (doc.count || 0) + 1; // старые эфиры уже удалены (40 дней) — не обрываем
    else {
      next.count = 1;
      next.brokenDay = day; // восстановить можно только сегодня
      next.lostCount = doc.count || 0;
    }
  }
  if (next.brokenDay && next.brokenDay !== day) { next.brokenDay = null; next.lostCount = 0; } // вчерашнее предложение сгорело
  await WatchStreak.updateOne(
    { streamerId, userId },
    { $set: { ...next, updatedAt: new Date() }, $unset: { lastStreamAt: '' } },
    { upsert: true }
  ).catch((e) => { if (e.code !== 11000) throw e; }); // две вкладки разом — вторая запись совпадёт с первой
  return { count: next.count, ...notices({ ...doc, ...next, sharedDay: doc?.sharedDay }, day) };
}

// восстановить прервавшуюся серию сегодня → { count, left, notice? } или { error: 'none' | 'limit' }
async function restore(streamerId, userId, startedAt) {
  const day = dayOf(startedAt);
  const month = monthOf(day);
  const doc = await WatchStreak.findOne({ streamerId, userId }).lean();
  if (!doc || doc.brokenDay !== day || doc.lastDay !== day || doc.lostCount < 2) return { error: 'none' };
  if (!restoresLeft(doc, day)) return { error: 'limit' };
  const count = doc.lostCount + (doc.count || 1); // прежняя серия + сегодняшний день
  // условия в запросе: двойной клик и две вкладки не потратят две попытки
  const sameMonth = doc.restoreMonth === month;
  const r = await WatchStreak.updateOne(
    { _id: doc._id, brokenDay: day, ...(sameMonth ? { restoreMonth: month, restoresUsed: { $lt: RESTORES_PER_MONTH } } : { restoreMonth: doc.restoreMonth }) },
    sameMonth
      ? { $set: { count, brokenDay: null, lostCount: 0, updatedAt: new Date() }, $inc: { restoresUsed: 1 } }
      : { $set: { count, brokenDay: null, lostCount: 0, restoreMonth: month, restoresUsed: 1, updatedAt: new Date() } }
  );
  if (!r.modifiedCount) return { error: 'none' };
  const used = sameMonth ? (doc.restoresUsed || 0) + 1 : 1;
  return { count, left: RESTORES_PER_MONTH - used, ...notices({ ...doc, count, brokenDay: null }, day) };
}

// поделиться серией сегодня: → { count, points } или null (не рубеж, другой день, уже делился)
async function share(streamerId, userId, startedAt) {
  const day = dayOf(startedAt);
  const doc = await WatchStreak.findOne({ streamerId, userId }).select('count lastDay sharedDay').lean();
  if (!doc || doc.lastDay !== day || !isMilestone(doc.count) || doc.sharedDay === day) return null;
  // условие по sharedDay — двойной клик или две вкладки не дадут награду дважды
  const r = await WatchStreak.updateOne({ _id: doc._id, sharedDay: { $ne: day } }, { $set: { sharedDay: day, updatedAt: new Date() } });
  if (!r.modifiedCount) return null;
  return { count: doc.count, points: rewardFor(doc.count) };
}

module.exports = { touch, share, restore, isMilestone, rewardFor, dayOf, RESTORES_PER_MONTH };
