// /api/admin/stats?days=1|7|30 — вся статистика админки одним запросом (окна-показатели в admin.html).
// Считается из базы (ServerStat, VisitDay, ServerLive …), поэтому работает и в отдельном админ-сервере.
// Результат держим 30 с: окно с 35 показателями не должно гонять агрегации на каждое обновление
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const User = require('../models/User');
const Room = require('../models/Room');
const ServerStat = require('../models/ServerStat');
const ServerLive = require('../models/ServerLive');
const VisitDay = require('../models/VisitDay');
const Visitor = require('../models/Visitor');
const Ban = require('../models/Ban');
const ChatMessage = require('../models/ChatMessage');
const StreamChatMessage = require('../models/StreamChatMessage');
const SupportTicket = require('../models/SupportTicket');
const StreamSession = require('../models/StreamSession');
const Follow = require('../models/Follow');
const Clip = require('../models/Clip');

const DAY = 864e5;
const CACHE_MS = 30 * 1000;
const cache = new Map(); // days → { at, data }

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const r1 = (x) => Math.round((x || 0) * 10) / 10;

// пустые корзины графика: по часам за сутки или по дням — чтобы на графике были и нулевые столбики
function buckets(days, now) {
  const out = [];
  if (days === 1) {
    const h0 = Math.floor(now / 3600000) * 3600000;
    for (let i = 23; i >= 0; i--) out.push(new Date(h0 - i * 3600000).toISOString().slice(0, 13));
  } else {
    for (let i = days - 1; i >= 0; i--) out.push(dayOf(now - i * DAY));
  }
  return out;
}

async function visitorsPart(since, chartDays, now) {
  const match = { lastAt: { $gte: since }, type: { $ne: 'bot' } };
  const [agg, bots, newVisitors, perDay, recent] = await Promise.all([
    VisitDay.aggregate([
      { $match: match },
      { $sort: { lastAt: 1 } },
      {
        $group: {
          _id: '$key',
          type: { $last: '$type' }, os: { $last: '$os' }, country: { $last: '$country' },
          browser: { $last: { $arrayElemAt: [{ $split: ['$browser', ' '] }, 0] } },
          pages: { $sum: '$pages' },
        },
      },
      {
        $facet: {
          total: [{ $count: 'n' }],
          pages: [{ $group: { _id: null, n: { $sum: '$pages' } } }],
          type: [{ $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
          os: [{ $group: { _id: '$os', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }],
          browser: [{ $group: { _id: '$browser', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }],
          country: [{ $group: { _id: '$country', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }],
        },
      },
    ]),
    VisitDay.aggregate([{ $match: { lastAt: { $gte: since }, type: 'bot' } }, { $group: { _id: '$key' } }, { $count: 'n' }]),
    Visitor.countDocuments({ firstAt: { $gte: since }, bot: { $ne: true } }),
    VisitDay.aggregate([
      { $match: { day: { $gte: dayOf(now - (chartDays - 1) * DAY) }, type: { $ne: 'bot' } } },
      { $group: { _id: '$day', n: { $sum: 1 }, pages: { $sum: '$pages' } } },
    ]),
    VisitDay.find({}).sort({ lastAt: -1 }).limit(60)
      .select('lastAt firstAt ip country type name username hits pages').lean(),
  ]);
  const f = agg[0] || {};
  const list = (arr) => (arr || []).map((x) => ({ k: x._id || '', n: x.n }));
  const byDay = new Map(perDay.map((x) => [x._id, x]));
  return {
    visitors: f.total?.[0]?.n || 0,
    pageViews: f.pages?.[0]?.n || 0,
    bots: bots[0]?.n || 0,
    newVisitors,
    devices: list(f.type),
    os: list(f.os),
    browsers: list(f.browser),
    countries: list(f.country),
    visitorsSeries: buckets(chartDays, now).map((d) => ({ t: d, v: byDay.get(d)?.n || 0 })),
    recent: recent.map((x) => ({
      at: x.lastAt, first: x.firstAt, ip: x.ip, country: x.country, type: x.type, name: x.name,
      user: x.username || '', hits: x.hits, pages: x.pages,
    })),
  };
}

async function serverPart(since, days, now) {
  const rows = await ServerStat.find({ hour: { $gte: new Date(Math.floor(since.getTime() / 3600000) * 3600000) } }).lean();
  const tot = { req: 0, pages: 0, api: 0, s4: 0, s5: 0, durSum: 0, durN: 0, sockMax: 0, loopMax: 0 };
  const groups = {};
  const paths = {};
  const series = new Map(); // корзина → суммы
  const keyOf = (d) => (days === 1 ? d.toISOString().slice(0, 13) : dayOf(d));
  for (const r of rows) {
    for (const k of ['req', 'pages', 'api', 's4', 's5', 'durSum', 'durN']) tot[k] += r[k] || 0;
    tot.sockMax = Math.max(tot.sockMax, r.sockMax || 0);
    tot.loopMax = Math.max(tot.loopMax, r.loopMax || 0);
    for (const [k, n] of Object.entries(r.groups || {})) groups[k] = (groups[k] || 0) + n;
    for (const [k, n] of Object.entries(r.paths || {})) {
      const p = k.replace(/．/g, '.').replace(/^＄/, '$');
      paths[p] = (paths[p] || 0) + n;
    }
    const b = keyOf(r.hour);
    const s = series.get(b) || { req: 0, p: 0, s: 0, n: 0, pMax: 0, sMax: 0, rss: 0, rssMax: 0 };
    s.req += r.req || 0;
    s.p += r.cpuProcSum || 0;
    s.s += r.cpuSysSum || 0;
    s.n += r.cpuN || 0;
    s.pMax = Math.max(s.pMax, r.cpuProcMax || 0);
    s.sMax = Math.max(s.sMax, r.cpuSysMax || 0);
    s.rss += r.rssSum || 0;
    s.rssMax = Math.max(s.rssMax, r.rssMax || 0);
    series.set(b, s);
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));
  const bk = buckets(days, now);
  return {
    requests: tot.req,
    apiRequests: tot.api,
    pageRequests: tot.pages,
    errors4: tot.s4,
    errors5: tot.s5,
    avgMs: tot.durN ? r1(tot.durSum / tot.durN) : 0,
    peakSockets: tot.sockMax,
    peakLoop: tot.loopMax,
    apiGroups: top(groups, 15),
    topPages: top(paths, 15),
    requestsSeries: bk.map((t) => ({ t, v: series.get(t)?.req || 0 })),
    cpuSeries: bk.map((t) => {
      const s = series.get(t);
      return { t, p: s?.n ? r1(s.p / s.n) : 0, s: s?.n ? r1(s.s / s.n) : 0 };
    }),
    memSeries: bk.map((t) => {
      const s = series.get(t);
      return { t, v: s?.n ? Math.round(s.rss / s.n) : 0 };
    }),
  };
}

async function accountsPart(since, chartDays, now) {
  const regSince = new Date(dayOf(now - (chartDays - 1) * DAY) + 'T00:00:00Z');
  const [total, fresh, active, banned, admins, regs, liveNow, streamers] = await Promise.all([
    User.estimatedDocumentCount(),
    User.countDocuments({ createdAt: { $gte: since } }),
    User.countDocuments({ lastSeenAt: { $gte: since } }),
    User.countDocuments({ $or: [{ banPerm: true }, { banUntil: { $gt: new Date(now) } }] }),
    User.countDocuments({ role: { $in: ['admin', 'owner'] } }),
    User.aggregate([
      { $match: { createdAt: { $gte: regSince } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    ]),
    User.countDocuments({ isLive: true }),
    StreamSession.distinct('streamerId', { endedAt: { $gte: since } }).then((a) => a.length).catch(() => 0),
  ]);
  const byDay = new Map(regs.map((x) => [x._id, x.n]));
  return {
    accounts: total, newAccounts: fresh, activeAccounts: active, bannedAccounts: banned, admins,
    liveNow, activeStreamers: streamers,
    regSeries: buckets(chartDays, now).map((t) => ({ t, v: byDay.get(t) || 0 })),
  };
}

async function contentPart(since) {
  const [rooms, roomsActive, roomMsgs, streamMsgs, sessions, follows, clips, supportUnread, supportNew, bans] = await Promise.all([
    Room.estimatedDocumentCount(),
    Room.countDocuments({ viewerCount: { $gt: 0 } }),
    ChatMessage.countDocuments({ createdAt: { $gte: since } }),
    StreamChatMessage.countDocuments({ createdAt: { $gte: since } }),
    StreamSession.aggregate([{ $match: { startedAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, sec: { $sum: '$sec' } } }]),
    Follow.countDocuments({ createdAt: { $gte: since } }),
    Clip.countDocuments({ createdAt: { $gte: since } }),
    SupportTicket.countDocuments({ status: 'unread' }),
    SupportTicket.countDocuments({ createdAt: { $gte: since } }),
    Ban.aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]),
  ]);
  const bk = Object.fromEntries(bans.map((b) => [b._id, b.n]));
  return {
    rooms, roomsActive,
    chatMessages: roomMsgs + streamMsgs, roomMessages: roomMsgs, streamMessages: streamMsgs,
    streams: sessions[0]?.n || 0, streamHours: r1((sessions[0]?.sec || 0) / 3600),
    follows, clips, supportUnread, supportNew,
    bans: { ip: bk.ip || 0, did: bk.did || 0, hw: bk.hw || 0 },
  };
}

async function build(days) {
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const chartDays = days === 1 ? 7 : days; // посетители и регистрации — по дням (за сутки — последняя неделя)
  const [visitors, server, accounts, content, live] = await Promise.all([
    visitorsPart(since, chartDays, now),
    serverPart(since, days, now),
    accountsPart(since, chartDays, now),
    contentPart(since),
    ServerLive.findById('main').lean(),
  ]);
  return {
    days, chartDays, at: new Date(now),
    ...visitors, ...server, ...accounts, ...content,
    live: live
      ? {
          at: live.at, startedAt: live.startedAt, node: live.node, cores: live.cores,
          cpuProc: live.cpuProc, cpuSys: live.cpuSys, load1: live.load1,
          rss: live.rss, heap: live.heap, memTotal: live.memTotal, memFree: live.memFree,
          loopP99: live.loopP99, sockets: live.sockets,
          minutes: (live.minutes || []).map((m) => ({ t: m.t, p: m.p, s: m.s })),
        }
      : null,
  };
}

router.get('/stats', auth, adminOnly, async (req, res) => {
  const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const hit = cache.get(days);
  if (hit && Date.now() - hit.at < CACHE_MS && req.query.fresh !== '1') return res.json(hit.data);
  const data = await build(days);
  cache.set(days, { at: Date.now(), data });
  res.json(data);
});

module.exports = router;
