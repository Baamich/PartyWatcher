// История аккаунта (models/AccountEvent): кто, когда и с какого IP/устройства сменил почту, логин, пароль и т.д.
// Запись не должна ломать само действие — ошибки только в лог
const AccountEvent = require('../models/AccountEvent');
const { clientIp, parseUA } = require('./clientInfo');

// record(userId, 'email', { from, to, by }, req) — req нужен для IP и устройства (можно не передавать)
function record(userId, type, data = {}, req = null) {
  const doc = {
    userId,
    type,
    from: String(data.from || '').slice(0, 200),
    to: String(data.to || '').slice(0, 200),
    by: String(data.by || '').slice(0, 64),
  };
  if (req) {
    doc.ip = clientIp(req);
    doc.device = parseUA(req.headers || {}).name || '';
  }
  // владельцу — уведомление в колокольчик (смена пароля, почты, логина…), services/notify.js
  require('./notify').accountEvent(userId, type, data).catch(() => {});
  return AccountEvent.create(doc).catch((e) => console.error('[accountLog]', type, e.message));
}

// для админки: события по порядку + то, с чего всё началось (первая почта и логин — «было» у самой ранней смены)
async function historyOf(user) {
  const events = await AccountEvent.find({ userId: user._id }).sort({ at: 1 }).limit(300).lean();
  const firstOf = (type, current) => {
    const e = events.find((x) => x.type === type && x.from);
    return e ? e.from : current;
  };
  return {
    first: {
      at: user.createdAt,
      email: firstOf('email', user.email),
      username: firstOf('username', user.username),
      ip: user.regIp || '',
      device: user.regDevice || '',
    },
    events: events.map((e) => ({ type: e.type, from: e.from, to: e.to, by: e.by, ip: e.ip, device: e.device, at: e.at })),
  };
}

module.exports = { record, historyOf };
