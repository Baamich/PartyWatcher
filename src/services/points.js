// points.js — стрим-поинты: раз в 5 минут просмотра эфира зритель забирает бонус (+50 подписчику, +10 остальным).
// «Смотрел» = был на странице канала (сокет чата) всё это время, пока шёл эфир: время входа держим в памяти.
// Покупка награды списывает поинты атомарно (баланс не уйдёт в минус даже при двойном клике)
const ChannelPoints = require('../models/ChannelPoints');
const Reward = require('../models/Reward');
const Redemption = require('../models/Redemption');
const Follow = require('../models/Follow');
const i18n = require('./i18n');

const CLAIM_MS = 5 * 60 * 1000;
const AMOUNT = { follower: 50, viewer: 10 };

// ---------- кто сейчас смотрит ----------
const watch = new Map(); // `${канал}:${userId}` → { since, sockets }
const wkey = (nameLower, userId) => nameLower + ':' + userId;
function watchJoin(nameLower, userId) {
  if (!userId) return;
  const k = wkey(nameLower, userId);
  const w = watch.get(k);
  if (w) w.sockets += 1;
  else watch.set(k, { since: Date.now(), sockets: 1 });
  if (watch.size > 100000) watch.clear();
}
function watchLeave(nameLower, userId) {
  if (!userId) return;
  const k = wkey(nameLower, userId);
  const w = watch.get(k);
  if (!w) return;
  w.sockets -= 1;
  if (w.sockets <= 0) watch.delete(k);
}

// когда можно забрать следующий бонус (null — не на странице или эфира нет).
// Считаем от позднего из: зашёл на страницу, начался эфир, забрал прошлый бонус — время на странице до эфира не идёт в зачёт
function nextClaimAt(nameLower, userId, isLive, lastClaimAt, liveStartedAt) {
  const w = watch.get(wkey(nameLower, userId));
  if (!w || !isLive) return null;
  const ms = (d) => (d ? new Date(d).getTime() || 0 : 0);
  const from = Math.max(w.since, ms(lastClaimAt), ms(liveStartedAt));
  return new Date(from + CLAIM_MS);
}

async function account(streamerId, userId) {
  return (await ChannelPoints.findOne({ streamerId, userId }).select('balance total lastClaimAt').lean()) || { balance: 0, total: 0, lastClaimAt: null };
}

// забрать бонус. streamer — { _id, streamerNameLower, isLive, liveStartedAt }. Бросает i18n.err
async function claim(streamer, userId) {
  if (!streamer.isLive) throw i18n.err('server.points.notLive');
  if (String(streamer._id) === String(userId)) throw i18n.err('server.points.own');
  const acc = await account(streamer._id, userId);
  const next = nextClaimAt(streamer.streamerNameLower, String(userId), true, acc.lastClaimAt, streamer.liveStartedAt);
  if (!next) throw i18n.err('server.points.notWatching');
  if (next.getTime() > Date.now()) throw i18n.err('server.points.tooEarly');
  const follower = !!(await Follow.exists({ followerId: userId, streamerId: streamer._id }));
  const add = follower ? AMOUNT.follower : AMOUNT.viewer;
  // условие по lastClaimAt — второй запрос в ту же секунду ничего не добавит
  const now = new Date();
  const filter = { streamerId: streamer._id, userId, $or: [{ lastClaimAt: null }, { lastClaimAt: { $lte: new Date(now - CLAIM_MS + 1000) } }] };
  let doc = null;
  try {
    doc = await ChannelPoints.findOneAndUpdate(filter, { $inc: { balance: add, total: add }, $set: { lastClaimAt: now } }, { new: true, upsert: true }).lean();
  } catch (e) {
    if (e.code === 11000) throw i18n.err('server.points.tooEarly'); // запись есть, но рано — upsert упёрся в уникальный индекс
    throw e;
  }
  return { added: add, balance: doc.balance, prevBalance: doc.balance - add, nextClaimAt: new Date(now.getTime() + CLAIM_MS) };
}

// списать цену награды; null — не хватает
async function spend(streamerId, userId, cost) {
  return ChannelPoints.findOneAndUpdate(
    { streamerId, userId, balance: { $gte: cost } },
    { $inc: { balance: -cost } },
    { new: true }
  ).lean();
}

async function refund(streamerId, userId, cost) {
  await ChannelPoints.updateOne({ streamerId, userId }, { $inc: { balance: cost } }, { upsert: true });
}

// ---------- стартовые награды (создаются один раз) ----------
const STARTERS = [
  { kind: 'highlight', slug: 'highlight', key: 'highlight', cost: 100, color: '#7c3aed', needInput: true },
  { kind: 'coinflip', slug: 'coinflip', key: 'coinflip', cost: 50, color: '#d97706', needInput: false },
  { kind: 'hello', slug: 'hello', key: 'hello', cost: 200, color: '#0ea5e9', needInput: true },
];
async function seedStarters(streamer, lang) {
  for (const s of STARTERS) {
    try {
      await Reward.create({
        streamerId: streamer._id, streamerNameLower: streamer.streamerNameLower, slug: s.slug, kind: s.kind,
        title: i18n.t(lang, 'server.rewards.starter.' + s.key + '.title'),
        description: i18n.t(lang, 'server.rewards.starter.' + s.key + '.desc'),
        cost: s.cost, color: s.color, needInput: s.needInput,
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
}

module.exports = { CLAIM_MS, AMOUNT, watchJoin, watchLeave, nextClaimAt, account, claim, spend, refund, seedStarters, Redemption };
