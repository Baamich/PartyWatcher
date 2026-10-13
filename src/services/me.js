// Ответ /api/auth/me — общий для роута и для страниц (pages.js кладёт его прямо в HTML,
// чтобы страница не ждала отдельный запрос). null — пользователя больше нет
const User = require('../models/User');
const { TERMS_VERSION } = require('./terms');

async function meOf(userId) {
  const user = await User.findById(userId).select('username role streamerName adultConfirmed showAdult termsVersion').lean();
  if (!user) return null;
  return {
    id: user._id,
    username: user.username,
    role: user.role,
    streamerName: user.streamerName || null,
    adultConfirmed: !!user.adultConfirmed,
    showAdult: !!user.adultConfirmed && !!user.showAdult,
    // false — условия пользования не приняты или изменились: страница покажет окно (js/terms-gate.js)
    termsOk: user.termsVersion === TERMS_VERSION,
    termsChanged: !!user.termsVersion && user.termsVersion !== TERMS_VERSION,
  };
}

module.exports = { meOf };
