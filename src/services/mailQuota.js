// Лимиты писем бесплатного Resend: 100 в сутки и 3000 в месяц. Считаем сами, в базе (переживает перезапуск).
// Письма подтверждения регистрации — не больше MAIL_REG_DAILY (75) в сутки: остаток суток всегда остаётся для
// сброса пароля и писем поддержки. Сутки и месяц — по UTC. Сказал SMTP «лимит» раньше нашего счёта — считаем
// сутки исчерпанными (markFull). Без настроенной почты (локально) лимитов нет.
const MailQuota = require('../models/MailQuota');

const num = (v, d) => (Number(v) > 0 ? Math.floor(Number(v)) : d);
const DAILY = num(process.env.MAIL_DAILY_LIMIT, 100);
const MONTHLY = num(process.env.MAIL_MONTHLY_LIMIT, 3000);
const REG_DAILY = Math.min(DAILY, num(process.env.MAIL_REG_DAILY, 75));

let clock = () => Date.now(); // тесты подменяют время (setClock)
const dayId = () => 'd:' + new Date(clock()).toISOString().slice(0, 10);
const monthId = () => 'm:' + new Date(clock()).toISOString().slice(0, 7);
const configured = () => !!process.env.SMTP_HOST && !!process.env.MAIL_FROM;

// запись счётчика есть всегда (upsert), а прибавляем только если условие выполнено — атомарно, без гонок
async function bump(id, cond, inc, keepDays) {
  try {
    await MailQuota.updateOne({ _id: id }, { $setOnInsert: { total: 0, reg: 0, exp: new Date(clock() + keepDays * 86400000) } }, { upsert: true });
  } catch (e) {
    if (e.code !== 11000) throw e; // две вставки одновременно — запись уже есть
  }
  const r = await MailQuota.updateOne({ _id: id, ...cond }, { $inc: inc });
  return r.modifiedCount === 1;
}

// kind: 'reg' — подтверждение регистрации; 'other' — сброс пароля, поддержка. true — письмо можно отправлять
async function take(kind) {
  if (!configured()) return true;
  const reg = kind === 'reg';
  const day = dayId();
  const okDay = await bump(day, { total: { $lt: DAILY }, ...(reg && { reg: { $lt: REG_DAILY } }) }, { total: 1, ...(reg && { reg: 1 }) }, 40);
  if (!okDay) return false;
  if (await bump(monthId(), { total: { $lt: MONTHLY } }, { total: 1 }, 400)) return true;
  await MailQuota.updateOne({ _id: day }, { $inc: { total: -1, ...(reg && { reg: -1 }) } }); // месяц исчерпан — возвращаем
  return false;
}

// письмо не ушло по другой причине (сеть, ключ) — место в лимите возвращаем
async function giveBack(kind) {
  if (!configured()) return;
  const reg = kind === 'reg';
  await MailQuota.updateOne({ _id: dayId(), total: { $gt: 0 } }, { $inc: { total: -1, ...(reg && { reg: -1 }) } });
  await MailQuota.updateOne({ _id: monthId(), total: { $gt: 0 } }, { $inc: { total: -1 } });
}

// сколько писем регистрации ещё можно отправить сегодня
async function regLeft() {
  if (!configured()) return Infinity;
  const [d, m] = await Promise.all([MailQuota.findById(dayId()).lean(), MailQuota.findById(monthId()).lean()]);
  return Math.max(0, Math.min(REG_DAILY - (d?.reg || 0), DAILY - (d?.total || 0), MONTHLY - (m?.total || 0)));
}

// SMTP ответил «лимит» — до конца суток больше не пробуем
async function markFull() {
  await bump(dayId(), {}, {}, 40);
  await MailQuota.updateOne({ _id: dayId() }, { $set: { total: DAILY, reg: REG_DAILY } });
  console.warn('[mail-quota] почтовый сервис сообщил о лимите — до конца суток (UTC) писем больше не отправляем');
}

// ответ SMTP про исчерпанный лимит (Resend: «daily sending quota», 429 у API)
const isQuotaError = (e) => /quota|daily limit|sending limit|rate limit|too many/i.test(String((e && (e.response || e.message)) || ''));

async function stats() {
  const [d, m] = await Promise.all([MailQuota.findById(dayId()).lean(), MailQuota.findById(monthId()).lean()]);
  return { day: d?.total || 0, reg: d?.reg || 0, month: m?.total || 0, DAILY, REG_DAILY, MONTHLY };
}

module.exports = { take, giveBack, regLeft, markFull, isQuotaError, stats, DAILY, MONTHLY, REG_DAILY, setClock: (fn) => { clock = fn; } };
