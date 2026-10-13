// Статистика для админки. На запрос — только счётчики в памяти (микросекунды), в базу — раз в минуту пачкой:
//  - ServerStat: по часам — запросы, страницы, разделы /api, ошибки, время ответа, CPU, память, сокеты;
//  - VisitDay: посетитель за сутки (один документ, повторные заходы только увеличивают счётчики),
//    Visitor: когда посетитель пришёл впервые (новые/вернувшиеся);
//  - UserSeen и User.lastSeenAt/lastIp: с каких IP и устройств заходил аккаунт (бан IP/устройства);
//  - ServerLive: текущая нагрузка и последние 6 часов по минутам.
// Статика, сокеты, /media и упреждающая загрузка страниц не считаются.
const os = require('os');
const ServerStat = require('../models/ServerStat');
const ServerLive = require('../models/ServerLive');
const VisitDay = require('../models/VisitDay');
const Visitor = require('../models/Visitor');
const UserSeen = require('../models/UserSeen');
const User = require('../models/User');
const perf = require('./perf');
const { clientIp, deviceIds, parseUA, visitorKey } = require('./clientInfo');

const FLUSH_MS = 60 * 1000;
const SAMPLE_MS = 10 * 1000;
const MAX_KEYS = 20000; // посетителей за минуту — больше не держим (защита памяти)
const MINUTES_KEEP = 360;

let io = null;
const startedAt = new Date();

// ---------- счётчики текущей минуты ----------
function emptyBucket() {
  return { req: 0, pages: 0, api: 0, s4: 0, s5: 0, durSum: 0, durN: 0, groups: {}, paths: {} };
}
let cur = emptyBucket();
let visits = new Map(); // key → данные посетителя за минуту
let seen = new Map(); // userId|ip|did → данные
let users = new Map(); // userId → { ip, at }

// разбор User-Agent — дорогой из всего, кэшируем по строке
const uaCache = new Map();
function uaInfo(headers) {
  const k = (headers['user-agent'] || '') + '|' + (headers['sec-ch-ua-model'] || '') + '|' + (headers['sec-ch-ua-platform-version'] || '');
  let v = uaCache.get(k);
  if (!v) {
    v = parseUA(headers);
    if (uaCache.size > 2000) uaCache.clear();
    uaCache.set(k, v);
  }
  return v;
}

// страница для «Популярные страницы»: шаблоны вместо имён (/streamers/:name), без query
function pagePath(p) {
  if (p === '/' || p === '/index.html') return '/';
  if (/^\/streamers\/[^/]+$/.test(p) && !/\.html$/.test(p)) return '/streamers/:name';
  if (/^\/clips\/[^/]+$/.test(p)) return '/clips/:id';
  if (p === '/news/') return '/news';
  return p.slice(0, 80);
}
const encKey = (s) => s.replace(/\./g, '．').replace(/^\$/, '＄'); // точки и $ нельзя в ключах Mongo

const isPrefetch = (req) => /prefetch|prerender/i.test(String(req.headers['sec-purpose'] || req.headers.purpose || ''));

function record(req, res, t0) {
  const path = req.originalUrl.split('?')[0];
  const isApi = path.startsWith('/api/');
  const ct = String(res.getHeader('Content-Type') || '');
  const isPage = !isApi && req.method === 'GET' && res.statusCode < 400 && /text\/html/.test(ct) && !isPrefetch(req);
  if (!isApi && !isPage) return;

  cur.req++;
  if (res.statusCode >= 500) cur.s5++;
  else if (res.statusCode >= 400) cur.s4++;
  if (isPage) {
    cur.pages++;
    const k = encKey(pagePath(path));
    cur.paths[k] = (cur.paths[k] || 0) + 1;
  } else {
    cur.api++;
    const g = (path.split('/')[2] || 'other').toLowerCase();
    const gk = /^[a-z0-9-]{1,30}$/.test(g) ? g : 'other';
    cur.groups[gk] = (cur.groups[gk] || 0) + 1;
    cur.durSum += Number(process.hrtime.bigint() - t0) / 1e6;
    cur.durN++;
  }

  const ip = clientIp(req);
  const ids = deviceIds(req);
  const ua = uaInfo(req.headers);
  const key = visitorKey(ip, ids, req.headers['user-agent'] || '');
  const now = Date.now();
  const userId = req.user && req.user.id ? String(req.user.id) : '';

  let v = visits.get(key);
  if (!v) {
    if (visits.size >= MAX_KEYS) return;
    v = { first: now, hits: 0, pages: 0, api: 0 };
    visits.set(key, v);
  }
  v.last = now;
  v.hits++;
  if (isPage) v.pages++;
  else v.api++;
  v.ip = ip;
  v.country = String(req.headers['cf-ipcountry'] || '').slice(0, 2);
  v.did = ids.did;
  v.hw = ids.hw;
  v.ua = ua;
  if (userId) {
    v.userId = userId;
    v.username = req.user.username || '';
    const sk = userId + '|' + ip + '|' + ids.did;
    const s = seen.get(sk) || { userId, ip, did: ids.did, hits: 0 };
    s.hw = ids.hw;
    s.name = ua.name;
    s.country = v.country;
    s.hits++;
    s.last = now;
    if (seen.size < MAX_KEYS) seen.set(sk, s);
    users.set(userId, { ip, at: now });
  }
}

function middleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    try { record(req, res, t0); } catch (e) { console.warn('[analytics]', e.message); }
  });
  next();
}

// ---------- CPU и память ----------
const cores = os.cpus().length || 1;
function sysTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}
let prevProc = process.cpuUsage();
let prevAt = process.hrtime.bigint();
let prevSys = sysTimes();
const cpu = { procSum: 0, sysSum: 0, n: 0, procMax: 0, sysMax: 0, proc: 0, sys: 0 };
function sample() {
  const nowAt = process.hrtime.bigint();
  const us = Number(nowAt - prevAt) / 1000;
  const pu = process.cpuUsage(prevProc);
  const sys = sysTimes();
  const dTotal = sys.total - prevSys.total;
  const proc = us > 0 ? Math.min(100, ((pu.user + pu.system) / us / cores) * 100) : 0;
  const all = dTotal > 0 ? Math.max(0, Math.min(100, (1 - (sys.idle - prevSys.idle) / dTotal) * 100)) : 0;
  prevProc = process.cpuUsage();
  prevAt = nowAt;
  prevSys = sys;
  cpu.proc = proc;
  cpu.sys = all;
  cpu.procSum += proc;
  cpu.sysSum += all;
  cpu.n++;
  cpu.procMax = Math.max(cpu.procMax, proc);
  cpu.sysMax = Math.max(cpu.sysMax, all);
}

let minutes = [];
const round1 = (x) => Math.round(x * 10) / 10;

// ---------- запись в базу ----------
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const knownVisitors = new Set(); // кому уже обновили Visitor сегодня (раз в сутки достаточно)
let knownDay = dayOf(Date.now());

async function flush() {
  const b = cur;
  const v = visits;
  const s = seen;
  const u = users;
  cur = emptyBucket();
  visits = new Map();
  seen = new Map();
  users = new Map();

  const now = Date.now();
  const hour = new Date(Math.floor(now / 3600000) * 3600000);
  const mem = process.memoryUsage();
  const rss = Math.round(mem.rss / 1048576);
  const loop = perf.loopStats();
  const sockets = io ? io.engine.clientsCount : 0;
  const n = cpu.n || 1;
  const procAvg = cpu.n ? cpu.procSum / n : cpu.proc;
  const sysAvg = cpu.n ? cpu.sysSum / n : cpu.sys;

  const inc = {
    req: b.req, pages: b.pages, api: b.api, s4: b.s4, s5: b.s5, durSum: Math.round(b.durSum), durN: b.durN,
    cpuProcSum: round1(procAvg), cpuSysSum: round1(sysAvg), cpuN: 1, rssSum: rss,
  };
  for (const [k, c] of Object.entries(b.groups)) inc['groups.' + k] = c;
  for (const [k, c] of Object.entries(b.paths)) inc['paths.' + k] = c;
  const max = { cpuProcMax: round1(cpu.procMax || procAvg), cpuSysMax: round1(cpu.sysMax || sysAvg), rssMax: rss, loopMax: loop.p99, sockMax: sockets };
  Object.assign(cpu, { procSum: 0, sysSum: 0, n: 0, procMax: 0, sysMax: 0 });

  minutes.push({ t: now, p: round1(procAvg), s: round1(sysAvg), r: rss });
  if (minutes.length > MINUTES_KEEP) minutes = minutes.slice(-MINUTES_KEEP);

  const jobs = [
    ServerStat.updateOne({ hour }, { $inc: inc, $max: max }, { upsert: true }),
    ServerLive.updateOne(
      { _id: 'main' },
      {
        $set: {
          at: new Date(now), startedAt, node: process.version, cores,
          cpuProc: round1(cpu.proc), cpuSys: round1(cpu.sys), load1: round1(os.loadavg()[0]),
          rss, heap: Math.round(mem.heapUsed / 1048576),
          memTotal: Math.round(os.totalmem() / 1048576), memFree: Math.round(os.freemem() / 1048576),
          loopP99: loop.p99, sockets, minutes,
        },
      },
      { upsert: true },
    ),
  ];

  if (dayOf(now) !== knownDay) {
    knownDay = dayOf(now);
    knownVisitors.clear();
  }

  if (v.size) {
    const dayOps = [];
    const visitorOps = [];
    for (const [key, x] of v) {
      const set = {
        lastAt: new Date(x.last), ip: x.ip, country: x.country, did: x.did || '', hw: x.hw || '',
        type: x.ua.type, os: x.ua.os, browser: x.ua.browser, name: x.ua.name,
      };
      if (x.userId) { set.userId = x.userId; set.username = x.username; }
      dayOps.push({
        updateOne: {
          filter: { day: dayOf(x.first), key },
          update: { $set: set, $setOnInsert: { firstAt: new Date(x.first) }, $inc: { hits: x.hits, pages: x.pages, api: x.api } },
          upsert: true,
        },
      });
      if (!knownVisitors.has(key)) {
        if (knownVisitors.size < 200000) knownVisitors.add(key);
        visitorOps.push({
          updateOne: {
            filter: { key },
            update: { $setOnInsert: { firstAt: new Date(x.first), bot: x.ua.type === 'bot' }, $set: { lastAt: new Date(x.last) } },
            upsert: true,
          },
        });
      }
    }
    jobs.push(VisitDay.bulkWrite(dayOps, { ordered: false }));
    if (visitorOps.length) jobs.push(Visitor.bulkWrite(visitorOps, { ordered: false }));
  }

  if (s.size) {
    jobs.push(UserSeen.bulkWrite([...s.values()].map((x) => ({
      updateOne: {
        filter: { userId: x.userId, ip: x.ip, did: x.did },
        update: { $set: { hw: x.hw || '', name: x.name, country: x.country, lastAt: new Date(x.last) }, $setOnInsert: { firstAt: new Date(x.last) }, $inc: { hits: x.hits } },
        upsert: true,
      },
    })), { ordered: false }));
  }
  if (u.size) {
    jobs.push(User.bulkWrite([...u].map(([id, x]) => ({
      updateOne: { filter: { _id: id }, update: { $set: { lastSeenAt: new Date(x.at), lastIp: x.ip } } },
    })), { ordered: false }));
  }

  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.warn('[analytics] запись:', r.reason?.message || r.reason);
}

let started = false;
async function start(ioServer) {
  if (started) return;
  started = true;
  io = ioServer || null;
  try {
    const live = await ServerLive.findById('main').select('minutes').lean();
    if (live?.minutes?.length) minutes = live.minutes.filter((m) => now() - m.t < MINUTES_KEEP * 60000);
  } catch (_) {}
  setInterval(sample, SAMPLE_MS).unref();
  setInterval(() => { flush().catch((e) => console.warn('[analytics] flush', e.message)); }, FLUSH_MS).unref();
}
const now = () => Date.now();

module.exports = { middleware, start };
