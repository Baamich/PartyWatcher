(function () {
  const P = window.PWLayout;
  if (!P) return;

  const view = { active: false, apply };
  window.PWProView = view;

  const watched = new WeakSet();
  function watchScale(el, w) {
    if (watched.has(el)) return; // повторный apply не плодит наблюдателей
    watched.add(el);
    const set = () => el.style.setProperty('--s', Math.min(1, el.clientWidth / w) || 1);
    set();
    new ResizeObserver(set).observe(el);
  }

  function applyProfile(blocks, hasVods) {
    const row = document.getElementById('profileRow');
    let canvas = document.querySelector('.pw-canvas');
    if (!canvas) {
      canvas = document.createElement('div');
      canvas.className = 'pw-canvas';
      row.parentNode.insertBefore(canvas, row);
      row.classList.add('hidden'); // старая раскладка остаётся в DOM, но не показывается
    }
    canvas.querySelectorAll('.pw-custom').forEach((n) => n.remove()); // свои блоки пересоздаём

    const native = {
      banner: document.getElementById('banner'),
      avatar: document.getElementById('profileAvatarBtn'),
      info: document.querySelector('.profile-info'),
      vods: document.getElementById('vodSection'),
    };

    blocks.forEach((b, i) => {
      let el = native[b.type];
      if (el) el.classList.add('pw-block');
      else el = P.buildEl(b, false);
      canvas.appendChild(el); // для родных блоков это перемещение, порядок = слои
      el.style.zIndex = String(i + 1);
      P.applyVars(el, b);
      if (b.type === 'avatar') {
        const av = document.getElementById('profileAvatar');
        P.paintShape(av, b);
        P.applyFit(av, b);
      }
      if (b.type === 'banner') P.applyFit(native.banner, b);
      if (b.type === 'vods') native.vods.classList.toggle('vod-v', b.o === 'v');
    });
    document.getElementById('vodSection').classList.toggle('hidden', !hasVods);
    canvas.style.setProperty('--ch', P.canvasHeight(blocks));
    watchScale(canvas, P.WM.profile);
  }

  let liveMq = null;

  function applyLive(blocks) {
    const inner = document.querySelector('.live-strip-inner');
    if (!inner) return;
    inner.querySelectorAll(':scope > .pw-custom').forEach((n) => n.remove());
    const native = { player: document.getElementById('livePlayerWrap'), chat: document.getElementById('liveChatSide') };

    for (const b of blocks) {
      let el = native[b.type];
      if (el) el.classList.add('pw-block');
      else {
        el = P.buildEl(b, false);
        if (b.type === 'image') el.classList.add('pw-back'); // фото в эфире — только фон
        inner.appendChild(el);
      }
      P.applyVars(el, b);
      // порядок в списке = слои (фото-фон остаётся позади)
      el.style.zIndex = el.classList.contains('pw-back') ? '' : String(blocks.indexOf(b) + 1);
    }
    inner.style.setProperty('--ch', P.canvasHeight(blocks));

    if (!liveMq) {
      liveMq = window.matchMedia('(min-width: 901px)');
      const sync = () => inner.classList.toggle('pw-on', liveMq.matches);
      sync();
      liveMq.addEventListener('change', sync);
    }
    watchScale(inner, P.WM.live);
  }

  function apply(layout, hasVods) {
    const L = P.withDefaults(layout);
    view.active = true;
    applyProfile(L.profile.blocks, hasVods);
    applyLive(L.live.blocks);
  }
})();