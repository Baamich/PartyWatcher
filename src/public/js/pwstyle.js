(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PWStyle = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    layout: 'list', valign: 'bottom', align: 'left', maxw: 100, opacity: 100, gap: 6,
    size: 22, font: '', weight: 400, italic: false, ls: 0, lh: 130,
    color: 'ffffff', shadow: true, strokeOn: false, strokeC: '000000', strokeW: 2,
    bgOn: false, bg: '000000', bgalpha: 60, grad: false, bg2: '7c3aed', blur: 0,
    radius: 8, pad: 8, borderOn: false, bc: 'ffffff', bw: 1,
    stripeOn: false, stripeC: '7c3aed', stripeW: 4,
    glowOn: false, glowC: 'a855f7', glowS: 12,
    owner: 'e5484d', nickMode: 'text', nickPlate: false, nickCaps: false, showSrc: true,
    anim: 'slide', fadeOn: false, fade: 40, max: 30,
  };
  const HEX6 = /^[0-9a-f]{6}$/;
  const BOOLS = ['italic', 'shadow', 'strokeOn', 'bgOn', 'grad', 'borderOn', 'stripeOn', 'glowOn', 'nickPlate', 'nickCaps', 'showSrc', 'fadeOn'];
  const COLORS = ['color', 'bg', 'bg2', 'owner', 'strokeC', 'bc', 'stripeC', 'glowC'];

  const int = (v, min, max, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const pick = (v, list, d) => (list.includes(v) ? v : d);

  // берёт только известные поля и приводит каждое к допустимому значению
  function sanitize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const s = {};
    for (const k of Object.keys(DEFAULTS)) s[k] = src[k] === undefined ? DEFAULTS[k] : src[k];

    s.size = int(s.size, 10, 80, 22);
    s.bgalpha = int(s.bgalpha, 0, 100, 60);
    s.fade = int(s.fade, 1, 3600, 40);
    s.max = int(s.max, 5, 100, 30);
    s.blur = int(s.blur, 0, 20, 0);
    s.radius = int(s.radius, 0, 24, 8);
    s.pad = int(s.pad, 0, 20, 8);
    s.gap = int(s.gap, 0, 30, 6);
    s.strokeW = int(s.strokeW, 1, 4, 2);
    s.bw = int(s.bw, 1, 4, 1);
    s.maxw = int(s.maxw, 30, 100, 100);
    s.opacity = int(s.opacity, 20, 100, 100);
    s.ls = int(s.ls, 0, 6, 0);
    s.lh = int(s.lh, 100, 200, 130);
    s.stripeW = int(s.stripeW, 2, 12, 4);
    s.glowS = int(s.glowS, 4, 40, 12);
    s.weight = [400, 500, 700, 800].includes(Number(s.weight)) ? Number(s.weight) : 400;
    s.layout = pick(s.layout, ['list', 'bar', 'row'], 'list');
    s.valign = pick(s.valign, ['bottom', 'top'], 'bottom');
    s.align = pick(s.align, ['left', 'center', 'right'], 'left');
    s.nickMode = pick(s.nickMode, ['text', 'auto'], 'text');
    s.anim = pick(s.anim, ['slide', 'pop', 'fade', 'none'], 'slide');
    COLORS.forEach((k) => {
      const v = String(s[k] ?? '').toLowerCase().replace(/^#/, '');
      s[k] = HEX6.test(v) ? v : DEFAULTS[k];
    });
    s.font = String(s.font || '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40);
    BOOLS.forEach((k) => { s[k] = s[k] === true; });
    return s;
  }

  const isDefault = (s) => JSON.stringify(sanitize(s)) === JSON.stringify(sanitize({}));

  const api = { DEFAULTS, sanitize, isDefault };
  if (typeof document === 'undefined') return api;

  // ---------- только браузер: отрисовка превью ----------

  api.autoColor = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
  };

  api.apply = (box, st) => {
    const a = st.bgalpha / 100;
    const rgba = (h) => `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
    const set = (k, v) => box.style.setProperty(k, v);

    set('--pv-fs', st.size + 'px');
    set('--pv-font', st.font ? `"${st.font}", 'Segoe UI', system-ui, sans-serif` : "'Segoe UI', system-ui, sans-serif");
    set('--pv-text', '#' + st.color);
    set('--pv-bg', !st.bgOn ? 'transparent' : st.grad ? `linear-gradient(135deg, ${rgba(st.bg)}, ${rgba(st.bg2)})` : rgba(st.bg));
    set('--pv-owner', '#' + st.owner);
    set('--pv-shadow', st.shadow ? '0 1px 3px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)' : 'none');
    set('--pv-weight', String(st.weight));
    set('--pv-italic', st.italic ? 'italic' : 'normal');
    set('--pv-ls', st.ls + 'px');
    set('--pv-lh', String(st.lh / 100));
    set('--pv-radius', st.radius + 'px');
    set('--pv-pad', `${Math.round(st.pad / 4)}px ${st.pad}px`);
    set('--pv-gap', st.gap + 'px');
    set('--pv-maxw', st.layout === 'list' ? st.maxw + '%' : '100%');
    set('--pv-op', String(st.opacity / 100));
    set('--pv-ncaps', st.nickCaps ? 'uppercase' : 'none');
    set('--pv-sw', st.strokeOn ? st.strokeW + 'px' : '0px');
    set('--pv-sc', '#' + st.strokeC);
    set('--pv-bw', st.borderOn ? st.bw + 'px' : '0px');
    set('--pv-bc', '#' + st.bc);
    set('--pv-blur', st.bgOn ? st.blur + 'px' : '0px');
    set('--pv-glow', st.glowOn ? `0 0 ${st.glowS}px #${st.glowC}` : 'none');
    if (st.stripeOn) {
      set('--pv-stripe-w', st.stripeW + 'px');
      set('--pv-stripe-c', '#' + st.stripeC);
    } else {
      box.style.removeProperty('--pv-stripe-w');
      box.style.removeProperty('--pv-stripe-c');
    }
    set('--pv-align', { left: 'flex-start', center: 'center', right: 'flex-end' }[st.align]);
    set('--pv-talign', st.align);
    set('--pv-anim', { slide: 'pv-in', pop: 'pv-pop', fade: 'pv-fade', none: 'none' }[st.anim]);

    box.classList.toggle('pv-bar', st.layout === 'bar');
    box.classList.toggle('pv-row', st.layout === 'row');
    box.classList.toggle('pv-top', st.valign === 'top');
    box.classList.toggle('pv-nosrc', !st.showSrc);
  };

  // items: [{ owner?, nick?, text, src?, color? }]
  api.render = (box, raw, items, ownerName) => {
    const st = sanitize(raw);
    box.replaceChildren();
    api.apply(box, st);
    (st.layout === 'bar' ? items.slice(-1) : items).forEach((m) => {
      const row = document.createElement('div');
      row.className = 'pv-msg';
      if (m.src) {
        const s = document.createElement('span');
        s.className = 'pv-src';
        s.textContent = m.src;
        row.appendChild(s);
      }
      const nick = document.createElement('span');
      nick.className = 'pv-nick' + (m.owner ? ' pv-nick--owner' : '');
      nick.textContent = m.owner ? (ownerName || (typeof window !== 'undefined' && window.t ? window.t('common.streamer') : 'Стример')) : m.nick;
      if (!m.owner) {
        const c = m.color || (st.nickMode === 'auto' ? api.autoColor(m.nick) : null);
        if (st.nickPlate) {
          nick.classList.add('pv-plate');
          nick.style.background = c || 'rgba(255,255,255,.22)';
          if (c) nick.style.color = '#0b0b0f';
        } else if (c) {
          nick.style.color = c;
        }
      }
      row.append(nick, document.createTextNode(': ' + m.text));
      box.appendChild(row);
    });
  };

  return api;
});