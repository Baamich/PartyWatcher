(function () {
  // Параметры ссылки (все, кроме key, необязательные), смотри главу «Стилизация чата» в документации.
  const params = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
  const key = params.get('key') || '';
  const fadeSec = Math.max(0, parseInt(params.get('fade'), 10) || 0);
  const maxMsgs = Math.min(100, Math.max(5, parseInt(params.get('max'), 10) || 30));

  const root = document.documentElement;
  const box = document.getElementById('chat');
  const HEX = /^[0-9a-f]{6}$/i;
  const setVar = (k, v) => root.style.setProperty(k, v);
  const rangeParam = (name, min, max) => {
    const n = parseInt(params.get(name), 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };

  // ---- раскладка ----
  const layoutParam = params.get('layout');
  const layout = layoutParam === 'bar' || layoutParam === 'row' ? layoutParam : 'list';
  if (layout !== 'list') box.classList.add('layout-' + layout);
  if (params.get('valign') === 'top') box.classList.add('top');
  if (params.get('src') === '0') box.classList.add('nosrc');

  const alignParam = params.get('align');
  if (alignParam === 'right') { setVar('--align', 'flex-end'); setVar('--talign', 'right'); }
  else if (alignParam === 'center') { setVar('--align', 'center'); setVar('--talign', 'center'); }

  const maxw = rangeParam('maxw', 20, 100);
  if (maxw !== null) setVar('--maxw', maxw + '%');
  const opacity = rangeParam('opacity', 10, 100);
  if (opacity !== null) setVar('--op', String(opacity / 100));

  // ---- текст ----
  const size = rangeParam('size', 10, 80);
  if (size !== null) setVar('--fs', size + 'px');

  const font = params.get('font') || '';
  if (/^[\p{L}\p{N} _-]{1,40}$/u.test(font)) {
    setVar('--font', `"${font}", 'Segoe UI', system-ui, sans-serif`);
  }

  const weight = rangeParam('weight', 100, 900);
  if (weight !== null) setVar('--weight', String(weight));
  if (params.get('italic') === '1') setVar('--italic', 'italic');
  const ls = rangeParam('ls', 0, 10);
  if (ls !== null) setVar('--ls', ls + 'px');
  const lh = rangeParam('lh', 100, 200);
  if (lh !== null) setVar('--lh', String(lh / 100));

  const color = params.get('color') || '';
  if (HEX.test(color)) setVar('--text', '#' + color);
  if (params.get('shadow') === '0') setVar('--text-shadow', 'none');

  const stroke = params.get('stroke') || '';
  if (HEX.test(stroke)) {
    setVar('--stroke-c', '#' + stroke);
    setVar('--stroke-w', (rangeParam('strokew', 1, 6) ?? 2) + 'px');
  }

  // ---- сообщение ----
  const bg = params.get('bg') || '';
  const bg2 = params.get('bg2') || '';
  if (HEX.test(bg)) {
    const rawAlpha = parseInt(params.get('bgalpha'), 10);
    const alpha = (Number.isFinite(rawAlpha) ? Math.min(100, Math.max(0, rawAlpha)) : 60) / 100;
    const rgba = (h) => `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`;
    setVar('--msg-bg', HEX.test(bg2) ? `linear-gradient(135deg, ${rgba(bg)}, ${rgba(bg2)})` : rgba(bg));
    const blur = rangeParam('blur', 1, 40);
    if (blur !== null) setVar('--blur', blur + 'px');
  }

  const radius = rangeParam('radius', 0, 40);
  if (radius !== null) setVar('--radius', radius + 'px');
  const pad = rangeParam('pad', 0, 40);
  if (pad !== null) setVar('--pad', `${Math.round(pad / 4)}px ${pad}px`);
  const gap = rangeParam('gap', 0, 60);
  if (gap !== null) setVar('--gap', gap + 'px');

  const bc = params.get('bc') || '';
  if (HEX.test(bc)) {
    setVar('--bc', '#' + bc);
    setVar('--bw', (rangeParam('bw', 1, 6) ?? 1) + 'px');
  }

  const stripe = params.get('stripe') || '';
  if (HEX.test(stripe)) {
    setVar('--stripe-c', '#' + stripe);
    setVar('--stripe-w', (rangeParam('stripew', 1, 12) ?? 4) + 'px');
  }

  const glow = params.get('glow') || '';
  if (HEX.test(glow)) setVar('--glow', `0 0 ${rangeParam('glows', 2, 40) ?? 12}px #${glow}`);

  // ---- ники ----
  const owner = params.get('owner') || '';
  if (HEX.test(owner)) setVar('--owner-bg', '#' + owner);
  if (params.get('ncaps') === '1') setVar('--ncaps', 'uppercase');
  const nickAuto = params.get('nickmode') === 'auto';
  const nickPlate = params.get('nickplate') === '1';

  // ---- анимация ----
  const animParam = params.get('anim');
  if (animParam === 'pop') setVar('--anim', 'msg-pop');
  else if (animParam === 'fade') setVar('--anim', 'msg-fade');
  else if (animParam === 'none') setVar('--anim', 'none');

  function showError(text) {
    box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'msg';
    row.textContent = text;
    box.appendChild(row);
  }

  if (!key) {
    showError(t('overlay.noKey'));
    return;
  }

  // тот же цвет, что у ников на сайте
  function autoColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
  }

  function addMessage(msg) {
    if (!msg || msg.deleted) return;

    const row = document.createElement('div');
    row.className = 'msg';
    row.dataset.id = msg._id;

    if (msg.external && msg.source) {
      const s = document.createElement('span');
      s.className = 'src';
      s.textContent = msg.source;
      row.appendChild(s);
    }

    const nick = document.createElement('span');
    nick.className = 'nick' + (msg.isOwner ? ' nick--owner' : '');
    nick.textContent = I18N.sysName(msg.senderUsername);

    if (!msg.isOwner) {
      let c = null;
      if (/^#[0-9a-f]{6}$/i.test(msg.nickColor || '')) c = msg.nickColor;
      else if (nickAuto) c = autoColor(String(msg.senderUsername || ''));

      if (nickPlate) {
        nick.classList.add('plate');
        nick.style.background = c || 'rgba(255, 255, 255, 0.22)';
        if (c) nick.style.color = '#0b0b0f';
      } else if (c) {
        nick.style.color = c;
      }
    }
    row.appendChild(nick);

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ': ';
    row.appendChild(sep);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = msg.text;
    row.appendChild(text);

    // плоская плашка показывает только последнее сообщение
    if (layout === 'bar') while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(row);

    while (box.children.length > maxMsgs) box.removeChild(box.firstChild);

    if (fadeSec > 0) {
      setTimeout(() => {
        row.classList.add('out');
        setTimeout(() => row.remove(), 700);
      }, fadeSec * 1000);
    }
  }

  // в OBS сокет сам переподключается
  const socket = io('/chat', { reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });

  socket.on('connect', () => socket.emit('chat:join', { chatKey: key }));

  socket.on('chat:history', (list) => {
    box.innerHTML = '';
    if (fadeSec === 0) (list || []).forEach(addMessage); // при fade старую историю не показываем
  });
  socket.on('chat:message', addMessage);
  socket.on('chat:message-deleted', ({ messageId }) => {
    box.querySelectorAll('[data-id="' + CSS.escape(String(messageId)) + '"]').forEach((el) => el.remove());
  });
  socket.on('chat:cleared', () => { box.innerHTML = ''; });
  socket.on('chat:overlay-error', (e) => showError((e && e.error) || t('overlay.badKey')));
})();