(function () {
  const P = window.PWLayout;
  if (!P) return;

  const view = { active: false, apply };
  window.PWProView = view;

  const watched = new WeakSet();
  // ширина холста может меняться между apply (профиль шире 1100, если блоки тянутся правее) — берём её из data-cw
  function watchScale(el, w) {
    el.dataset.cw = String(w);
    const set = () => el.style.setProperty('--s', Math.min(1, el.clientWidth / Number(el.dataset.cw)) || 1);
    set();
    if (watched.has(el)) return; // повторный apply не плодит наблюдателей
    watched.add(el);
    new ResizeObserver(set).observe(el);
  }

  // ---- фон на всю страницу и бока ----
  // Фон рисуется слоем под всей страницей, но переход считается в единицах холста: на странице он стоит
  // там же относительно блоков, что и в редакторе. Бока — слева и справа от холста, во всю высоту окна
  // (закреплены при прокрутке), поверх фона страницы. Оба слоя под содержимым (z-index: -1).
  const page = { bg: null, sides: null, cw: 0, ch: 0, canvas: null, raf: 0, sig: '' };

  function layer(id, cls) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = cls;
      el.setAttribute('aria-hidden', 'true');
      document.body.prepend(el);
    }
    return el;
  }

  function layoutPage() {
    page.raf = 0;
    const { canvas, bg, sides, cw, ch } = page;
    const pageBg = document.getElementById('pwPageBg');
    const side = document.getElementById('pwSides');
    if (!canvas || !canvas.isConnected) return;
    const s = Number(getComputedStyle(canvas).getPropertyValue('--s')) || 1;
    const r = canvas.getBoundingClientRect();
    const docW = document.documentElement.clientWidth;
    const docH = Math.max(document.documentElement.scrollHeight, r.bottom + window.scrollY);
    const sig = [s, r.left, r.top + window.scrollY, docW, docH].map((n) => Math.round(n)).join(',');
    if (sig === page.sig) return; // размеры те же — маску не пересобираем
    page.sig = sig;

    if (pageBg && bg) {
      const Wu = docW / s, Hu = docH / s, Xu = (r.left + window.scrollX) / s, Yu = (r.top + window.scrollY) / s;
      const v = bg.dir !== 'h';
      // позиция и ширина перехода из долей холста — в доли всей страницы
      const pos = v ? ((Yu + (bg.pos / 100) * ch) / Hu) * 100 : ((Xu + (bg.pos / 100) * cw) / Wu) * 100;
      const soft = v ? (bg.soft * ch) / Hu : (bg.soft * cw) / Wu;
      Object.assign(pageBg.style, { width: docW + 'px', height: docH + 'px' });
      pageBg.style.setProperty('--s', s);
      P.paintBg(pageBg, { ...bg, pos, soft }, Wu, Hu);
    }
    if (side && sides) {
      const lw = Math.max(0, Math.floor(r.left)), rw = Math.max(0, Math.ceil(docW - r.right));
      side.children[0].style.width = lw + 'px';
      side.children[1].style.width = rw + 'px';
      side.style.setProperty('--s', s);
    }
  }

  const schedule = () => { if (page.on && !page.raf) page.raf = requestAnimationFrame(layoutPage); };
  let pageWatch = null;

  function applyPage(canvas, bg, sides, cw, ch) {
    Object.assign(page, { canvas, bg, sides, cw, ch, sig: '', on: !!(bg || sides) });
    document.body.classList.toggle('pw-has-page-bg', page.on);
    if (!bg) document.getElementById('pwPageBg')?.remove();
    if (!sides) document.getElementById('pwSides')?.remove();
    if (!page.on) return;

    if (bg) layer('pwPageBg', 'pw-page-bg');
    if (sides) {
      const side = layer('pwSides', 'pw-sides');
      // бока — над фоном страницы (после него в DOM), но под содержимым
      document.getElementById('pwPageBg')?.after(side);
      if (side.children.length !== 2) side.replaceChildren(document.createElement('div'), document.createElement('div'));
      ['l', 'r'].forEach((k, i) => {
        const el = side.children[i];
        el.className = 'pw-side pw-side-' + k;
        if (sides[k]) { P.paintFill(el, sides[k]); el.hidden = false; } else el.hidden = true;
      });
    }
    if (!pageWatch) {
      pageWatch = new ResizeObserver(schedule);
      // высота документа меняется вместе с содержимым (эфир раскрылся, записи догрузились); body сам — 100% окна
      pageWatch.observe(document.getElementById('pageContent') || document.body);
      window.addEventListener('resize', schedule);
    }
    pageWatch.observe(canvas);
    layoutPage();
  }

  function applyProfile(blocks, hasVods, bg, sides, width) {
    const row = document.getElementById('profileRow');
    let canvas = document.querySelector('.pw-canvas');
    if (!canvas) {
      canvas = document.createElement('div');
      canvas.className = 'pw-canvas';
      row.parentNode.insertBefore(canvas, row);
      row.classList.add('hidden'); // старая раскладка остаётся в DOM, но не показывается
    }
    canvas.querySelectorAll('.pw-custom').forEach((n) => n.remove()); // свои блоки пересоздаём
    let bgEl = canvas.querySelector(':scope > .pw-bg');
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.className = 'pw-bg';
      canvas.prepend(bgEl); // фон — первым, под всеми блоками
    }

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
    const cw = P.canvasWidth(blocks, 'profile', width), ch = P.canvasHeight(blocks);
    canvas.style.setProperty('--ch', ch);
    canvas.style.maxWidth = cw + 'px';
    watchScale(canvas, cw);
    // фон — на всю страницу (слой под страницей), в холсте его не рисуем, иначе был бы виден шов
    P.paintBg(bgEl, null, cw, ch);
    applyPage(canvas, bg, sides, cw, ch);
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
    // эфир, как и профиль, шириной до правого края блоков (старые макеты — 1600)
    const cw = P.canvasWidth(blocks, 'live');
    inner.style.setProperty('--ch', P.canvasHeight(blocks));
    inner.style.setProperty('--cw', cw);

    if (!liveMq) {
      liveMq = window.matchMedia('(min-width: 901px)');
      const sync = () => inner.classList.toggle('pw-on', liveMq.matches);
      sync();
      liveMq.addEventListener('change', sync);
    }
    watchScale(inner, cw);
  }

  function apply(layout, hasVods) {
    const L = P.withDefaults(layout);
    view.active = true;
    applyProfile(L.profile.blocks, hasVods, L.profile.bg, L.profile.sides, L.profile.width);
    applyLive(L.live.blocks);
  }
})();