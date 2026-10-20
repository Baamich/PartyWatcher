// /alerts — оверлей алертов OBS и боты стримера: подключение по ключу событий (студия → 🔔 События).
// Получают 'alert' (что показать) и 'event' (сырое событие, в т.ч. покупка награды).
// Виджеты OBS (студия → ⏱️ Виджеты) входят по тому же ключу: 'widget:join' → снимок, дальше widget:update/remove/stats
const AlertSettings = require('../models/AlertSettings');
const alerts = require('../services/alerts');
const widgets = require('../services/widgets');
const safeHandlers = require('./safeHandlers');

const KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;

module.exports = function registerAlertsSocket(io) {
  const nsp = io.of('/alerts');
  alerts.init(nsp);
  widgets.init(nsp);

  nsp.on('connection', (socket) => {
    safeHandlers(socket, 'alertsSocket');
    let joined = null;
    let widgetsOf = null;
    let tries = 0;
    let creditsAt = 0;

    // ключ → канал (null — не подошёл). Больше 5 попыток с одного сокета — перебор ключей
    async function channelByKey(key) {
      if (++tries > 5) { socket.disconnect(true); return null; }
      const k = String(key || '').trim();
      const doc = KEY_RE.test(k) ? await AlertSettings.findOne({ key: k }).select('streamerNameLower').lean() : null;
      return doc?.streamerNameLower || null;
    }

    socket.on('alerts:join', async ({ key } = {}) => {
      const channel = await channelByKey(key);
      if (!channel) return socket.emit('alerts:error', { error: 'bad key' });
      if (joined) socket.leave(alerts.room(joined));
      joined = channel;
      socket.join(alerts.room(joined));
      socket.emit('alerts:ready', { channel: joined });
    });

    // { key } — снимок всех виджетов канала (виджет сам выбирает свой по id)
    socket.on('widget:join', async ({ key } = {}) => {
      const channel = await channelByKey(key);
      if (!channel) return socket.emit('widget:error', { error: 'bad key' });
      if (widgetsOf && widgetsOf !== channel) socket.leave(widgets.room(widgetsOf));
      widgetsOf = channel;
      const snap = await widgets.join(socket, channel);
      if (!snap) return socket.emit('widget:error', { error: 'bad key' });
      socket.emit('widget:init', snap);
    });

    // титры: кто был в эфире (не чаще раза в 5 с с одного сокета)
    socket.on('widget:credits', async (_ = {}, ack) => {
      if (typeof ack !== 'function' || !widgetsOf) return;
      const now = Date.now();
      if (now - creditsAt < 5000) return ack({ error: 'too often' });
      creditsAt = now;
      ack({ credits: await widgets.credits(widgetsOf) });
    });
  });
};
