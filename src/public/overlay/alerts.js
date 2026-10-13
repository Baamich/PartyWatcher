// Оверлей алертов для OBS: /overlay/alerts.html?key=<ключ событий из студии>.
// Алерты идут по очереди: следующий — после того, как предыдущий плавно исчез
(function () {
  const key = new URLSearchParams(location.search).get('key') || '';
  const stage = document.getElementById('stage');
  const err = document.getElementById('err');
  const queue = [];
  let busy = false;

  const showError = (k) => { err.textContent = t(k); err.hidden = false; };
  if (!key) return showError('alerts.overlay.noKey');

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    const a = queue.shift();
    const text = a.text || t('alerts.default.' + a.event);
    PWAlertRender.show(stage, { ...a, text }, { onDone: () => { busy = false; setTimeout(next, 300); } });
  }

  const socket = io('/alerts', { reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
  socket.on('connect', () => socket.emit('alerts:join', { key }));
  socket.on('alerts:ready', () => { err.hidden = true; });
  socket.on('alerts:error', () => showError('alerts.overlay.badKey'));
  socket.on('alert', (a) => {
    if (!a || !a.event) return;
    if (queue.length > 30) queue.shift(); // поток событий — старые не копим бесконечно
    queue.push(a);
    next();
  });
})();
