// /alerts — оверлей алертов OBS и боты стримера: подключение по ключу событий (студия → 🔔 События).
// Получают 'alert' (что показать) и 'event' (сырое событие, в т.ч. покупка награды)
const AlertSettings = require('../models/AlertSettings');
const alerts = require('../services/alerts');
const safeHandlers = require('./safeHandlers');

module.exports = function registerAlertsSocket(io) {
  const nsp = io.of('/alerts');
  alerts.init(nsp);

  nsp.on('connection', (socket) => {
    safeHandlers(socket, 'alertsSocket');
    let joined = null;
    let tries = 0;

    socket.on('alerts:join', async ({ key } = {}) => {
      if (++tries > 5) return socket.disconnect(true); // перебор ключей
      const k = String(key || '').trim();
      const doc = /^[A-Za-z0-9_-]{20,80}$/.test(k) ? await AlertSettings.findOne({ key: k }).select('streamerNameLower').lean() : null;
      if (!doc) return socket.emit('alerts:error', { error: 'bad key' });
      if (joined) socket.leave(alerts.room(joined));
      joined = doc.streamerNameLower;
      socket.join(alerts.room(joined));
      socket.emit('alerts:ready', { channel: joined });
    });
  });
};
