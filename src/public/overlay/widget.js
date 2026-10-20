// Виджет для OBS: /overlay/widget.html?key=<ключ событий>&w=<id виджета>[&lang=ru|en].
// Настройки и состояние приходят по сокету /alerts и меняются на лету — перезагружать источник в OBS не нужно
(function () {
  const params = new URLSearchParams(location.search);
  const key = params.get('key') || '';
  const wid = params.get('w') || '';
  const stage = document.getElementById('stage');
  const err = document.getElementById('err');
  let view = null;

  const showError = (k) => { err.textContent = t(k); err.hidden = false; };
  if (!key || !wid) return showError('widgets.overlay.noKey');

  const socket = io('/alerts', { transports: ['websocket', 'polling'], tryAllTransports: true, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
  const credits = () => new Promise((resolve) => socket.timeout(8000).emit('widget:credits', {}, (e, r) => resolve(e ? null : r?.credits || null)));

  function place(w) {
    stage.className = (w.style.align === 'center' ? '' : w.style.align) + (w.type === 'credits' ? ' fill' : '');
  }
  function show(w, now) {
    if (!view) view = PWWidgetRender.create(stage, { credits });
    place(w);
    view.set(w, now);
  }

  socket.on('connect', () => socket.emit('widget:join', { key }));
  socket.on('widget:error', () => showError('widgets.overlay.badKey'));
  socket.on('widget:init', (d) => {
    const w = (d?.widgets || []).find((x) => x.id === wid);
    if (!w) {
      view?.destroy();
      view = null;
      return showError('widgets.overlay.gone');
    }
    err.hidden = true;
    if (!view) view = PWWidgetRender.create(stage, { credits });
    view.ctx({ live: d.live, stats: d.stats, last: d.last || {} }, d.now);
    show(w, d.now);
  });
  socket.on('widget:update', (d) => {
    if (d?.widget?.id !== wid) return;
    err.hidden = true;
    show(d.widget, d.now);
  });
  socket.on('widget:remove', (d) => {
    if (d?.id !== wid) return;
    view?.destroy();
    view = null;
    showError('widgets.overlay.gone');
  });
  socket.on('widget:last', (d) => view?.ctx({ last: d.last || {} }, d.now));
  socket.on('widget:stats', (d) => view?.ctx({ ...(d.live && { live: d.live }), ...(d.stats && { stats: d.stats }) }, d.now));
})();
