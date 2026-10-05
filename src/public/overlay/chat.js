(function () {
  // Параметры ссылки (все, кроме key, необязательные):
  //   key — ключ чата; size — размер шрифта px (10–80); font — шрифт; color — цвет текста (6 символов без #)
  //   bg — цвет фона сообщения; bg2 — второй цвет (тогда фон — градиент); bgalpha — непрозрачность 0–100 (по умолчанию 60)
  //   owner — цвет плашки владельца; shadow=0 — без тени; fade — исчезновение через N сек; max — сколько сообщений (5–100)
  const params = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
  const key = params.get('key') || '';
  const fadeSec = Math.max(0, parseInt(params.get('fade'), 10) || 0);
  const maxMsgs = Math.min(100, Math.max(5, parseInt(params.get('max'), 10) || 30));

  const root = document.documentElement;
  const HEX = /^[0-9a-f]{6}$/i;

  const size = parseInt(params.get('size'), 10);
  if (size >= 10 && size <= 80) root.style.setProperty('--fs', size + 'px');

  const font = params.get('font') || '';
  if (/^[\p{L}\p{N} _-]{1,40}$/u.test(font)) {
    root.style.setProperty('--font', `"${font}", 'Segoe UI', system-ui, sans-serif`);
  }

  const color = params.get('color') || '';
  if (HEX.test(color)) root.style.setProperty('--text', '#' + color);

  const owner = params.get('owner') || '';
  if (HEX.test(owner)) root.style.setProperty('--owner-bg', '#' + owner);

  const bg = params.get('bg') || '';
  const bg2 = params.get('bg2') || '';
  if (HEX.test(bg)) {
    const rawAlpha = parseInt(params.get('bgalpha'), 10);
    const alpha = (Number.isFinite(rawAlpha) ? Math.min(100, Math.max(0, rawAlpha)) : 60) / 100;
    const rgba = (h) => `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`;
    root.style.setProperty(
      '--msg-bg',
      HEX.test(bg2) ? `linear-gradient(135deg, ${rgba(bg)}, ${rgba(bg2)})` : rgba(bg)
    );
  }

  if (params.get('shadow') === '0') root.style.setProperty('--text-shadow', 'none');

  const setVar = (k, v) => root.style.setProperty(k, v);
  const rangeParam = (name, min, max) => {
    const n = parseInt(params.get(name), 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };

  const weight = rangeParam('weight', 100, 900);
  if (weight !== null) setVar('--weight', String(weight));

  const radius = rangeParam('radius', 0, 40);
  if (radius !== null) setVar('--radius', radius + 'px');

  const pad = rangeParam('pad', 0, 40);
  if (pad !== null) setVar('--pad', `${Math.round(pad / 4)}px ${pad}px`);

  const gap = rangeParam('gap', 0, 60);
  if (gap !== null) setVar('--gap', gap + 'px');

  const stroke = params.get('stroke') || '';
  if (HEX.test(stroke)) {
    setVar('--stroke-c', '#' + stroke);
    setVar('--stroke-w', (rangeParam('strokew', 1, 6) ?? 2) + 'px');
  }

  const bc = params.get('bc') || '';
  if (HEX.test(bc)) {
    setVar('--bc', '#' + bc);
    setVar('--bw', (rangeParam('bw', 1, 6) ?? 1) + 'px');
  }

  const blur = rangeParam('blur', 1, 40);
  if (blur !== null) setVar('--blur', blur + 'px');

  if (params.get('align') === 'right') {
    setVar('--align', 'flex-end');
    setVar('--talign', 'right');
  }

  const animParam = params.get('anim');
  if (animParam === 'pop') setVar('--anim', 'msg-pop');
  else if (animParam === 'fade') setVar('--anim', 'msg-fade');
  else if (animParam === 'none') setVar('--anim', 'none');

  const box = document.getElementById('chat');

  function showError(text) {
    box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'msg';
    row.textContent = text;
    box.appendChild(row);
  }

  if (!key) {
    showError('В ссылке нет ключа (#key=...)');
    return;
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
    nick.textContent = msg.senderUsername;
    if (!msg.isOwner && /^#[0-9a-f]{6}$/i.test(msg.nickColor || '')) nick.style.color = msg.nickColor;
    row.appendChild(nick);

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ': ';
    row.appendChild(sep);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = msg.text;
    row.appendChild(text);

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
  socket.on('chat:overlay-error', (e) => showError((e && e.error) || 'Неверный ключ чата'));
})();