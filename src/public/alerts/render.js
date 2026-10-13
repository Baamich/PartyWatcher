// Показ алерта: анимация (эмодзи-частицы или своя GIF), надпись с анимацией, звук (синтез WebAudio или свой файл),
// озвучка голосом системы. Общий для оверлея OBS (/overlay/alerts.html) и превью в студии (🔔 События)
(function () {
  if (window.PWAlertRender) return;
  const C = window.PWAlertCatalog;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const mediaUrl = (ref) => (/^media:[a-f0-9]{24}$/i.test(ref || '') ? '/api/alerts/media/' + ref.slice(6) : null);

  function injectCss() {
    if (document.getElementById('pw-alert-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-alert-css';
    st.textContent = `
      .pwa-stage { position: relative; width: var(--w, 320px); height: var(--h, 220px); overflow: visible; pointer-events: none; }
      .pwa-icon { position: absolute; left: 50%; top: 50%; font-size: calc(var(--h, 220px) * .42); line-height: 1; transform: translate(-50%, -50%);
        filter: drop-shadow(0 6px 14px rgba(0,0,0,.45)); animation: var(--ia, pwa-i-pulse) 1.4s ease-in-out infinite; }
      .pwa-gif { position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%; object-fit: contain; animation: pwa-i-zoom .6s cubic-bezier(.2,1.4,.4,1) both; }
      .pwa-p { position: absolute; left: 50%; top: 50%; font-size: calc(var(--h, 220px) * .12 * var(--s, 1)); line-height: 1; opacity: 0;
        animation: var(--pa) var(--t, 2.2s) ease-out var(--d, 0s) var(--n, 1) both; }
      .pwa-flash { position: absolute; inset: -20%; background: radial-gradient(circle, rgba(255,255,255,.9), transparent 60%); animation: pwa-flash 1.2s ease-out var(--n, 1); }

      @keyframes pwa-i-pulse { 0%,100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-50%,-50%) scale(1.12); } }
      @keyframes pwa-i-float { 0%,100% { transform: translate(-50%,-50%); } 50% { transform: translate(-50%,-62%); } }
      @keyframes pwa-i-spin { from { transform: translate(-50%,-50%) rotateY(0); } to { transform: translate(-50%,-50%) rotateY(360deg); } }
      @keyframes pwa-i-drop { 0% { transform: translate(-50%,-260%); } 55% { transform: translate(-50%,-50%); } 70% { transform: translate(-50%,-62%); } 85%,100% { transform: translate(-50%,-50%); } }
      @keyframes pwa-i-shake { 0%,100% { transform: translate(-50%,-50%) rotate(0); } 20% { transform: translate(-52%,-50%) rotate(-12deg); } 40% { transform: translate(-48%,-50%) rotate(12deg); } 60% { transform: translate(-51%,-50%) rotate(-8deg); } 80% { transform: translate(-49%,-50%) rotate(6deg); } }
      @keyframes pwa-i-fly { 0% { transform: translate(-260%,120%) rotate(0); } 60% { transform: translate(-50%,-50%) rotate(0); } 100% { transform: translate(-50%,-50%) rotate(0); } }
      @keyframes pwa-i-bounce { 0%,100% { transform: translate(-50%,-50%) scale(1,1); } 30% { transform: translate(-50%,-70%) scale(.95,1.08); } 50% { transform: translate(-50%,-50%) scale(1.12,.9); } }
      @keyframes pwa-i-zoom { from { transform: scale(.2); opacity: 0; } to { transform: scale(1); opacity: 1; } }

      @keyframes pwa-burst { 0% { opacity: 0; transform: translate(-50%,-50%) scale(.3); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1) rotate(var(--r)); } }
      @keyframes pwa-rise { 0% { opacity: 0; transform: translate(calc(-50% + var(--dx)), 120%); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(calc(-50% + var(--dx) + var(--sw)), -260%); } }
      @keyframes pwa-rain { 0% { opacity: 0; transform: translate(calc(-50% + var(--dx)), -280%) rotate(0); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(calc(-50% + var(--dx) + var(--sw)), 160%) rotate(var(--r)); } }
      @keyframes pwa-orbit { 0% { opacity: 0; transform: translate(-50%,-50%) rotate(var(--a)) translateX(var(--rad)) rotate(calc(-1 * var(--a))); } 15%,85% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%,-50%) rotate(calc(var(--a) + 360deg)) translateX(var(--rad)) rotate(calc(-1 * var(--a) - 360deg)); } }
      @keyframes pwa-twinkle { 0%,100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(.2); } 50% { opacity: 1; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.2) rotate(var(--r)); } }
      @keyframes pwa-wave { 0% { opacity: 0; transform: translate(-260%, calc(-50% + var(--dy))); } 15%,85% { opacity: 1; } 50% { transform: translate(-50%, calc(-50% + var(--dy) - 30px)); } 100% { opacity: 0; transform: translate(160%, calc(-50% + var(--dy))); } }
      @keyframes pwa-flash { 0%,100% { opacity: 0; } 10% { opacity: 1; } 30% { opacity: .1; } 40% { opacity: .8; } }

      .pwa-alert { display: flex; flex-direction: column; align-items: center; gap: 10px; transition: opacity .5s ease, transform .5s cubic-bezier(.2,1.2,.4,1); }
      .pwa-alert.pwa-in { opacity: 0; transform: translateY(-30px) scale(.9); }
      .pwa-alert.pwa-out { opacity: 0; transform: translateY(20px) scale(.95); transition-duration: .6s; }
      .pwa-text { max-width: 760px; text-align: center; font: 800 34px/1.25 system-ui, "Segoe UI", sans-serif; color: var(--c, #fff); overflow-wrap: anywhere;
        text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 14px rgba(0,0,0,.65); padding: 0 16px; }
      .pwa-text .pwa-hl { color: var(--hl, #c4b5fd); }
      .pwa-text .pwa-emote { height: 1.3em; vertical-align: middle; }
      .pwa-text .pwa-ch { display: inline-block; white-space: pre; }

      .pwa-t-pop { animation: pwa-t-pop .6s cubic-bezier(.2,1.6,.4,1) both; }
      .pwa-t-fade { animation: pwa-t-fade .8s ease both; }
      .pwa-t-slideUp { animation: pwa-t-up .6s cubic-bezier(.2,1.2,.4,1) both; }
      .pwa-t-slideDown { animation: pwa-t-down .6s cubic-bezier(.2,1.2,.4,1) both; }
      .pwa-t-zoom { animation: pwa-t-zoom .7s ease both; }
      .pwa-t-bounce { animation: pwa-t-bounce 1s ease both; }
      .pwa-t-shake { animation: pwa-t-fade .3s ease both, pwa-t-shake .5s ease .3s 3; }
      .pwa-t-glow { animation: pwa-t-fade .4s ease both, pwa-t-glow 1.2s ease-in-out .4s infinite; }
      .pwa-t-rainbow { animation: pwa-t-fade .4s ease both, pwa-t-rainbow 2s linear infinite; }
      .pwa-t-flip { animation: pwa-t-flip .8s ease both; transform-origin: 50% 0; }
      .pwa-t-jelly { animation: pwa-t-jelly .9s ease both; }
      .pwa-t-wave .pwa-ch { animation: pwa-t-wave 1.2s ease-in-out calc(var(--i) * 60ms) infinite; }
      .pwa-t-typewriter .pwa-ch { opacity: 0; animation: pwa-t-fade .01s linear calc(var(--i) * 45ms) forwards; }
      .pwa-t-letters .pwa-ch { animation: pwa-t-pop .5s cubic-bezier(.2,1.6,.4,1) calc(var(--i) * 35ms) both; }
      @keyframes pwa-t-pop { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
      @keyframes pwa-t-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes pwa-t-up { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
      @keyframes pwa-t-down { from { opacity: 0; transform: translateY(-40px); } to { opacity: 1; transform: none; } }
      @keyframes pwa-t-zoom { from { opacity: 0; transform: scale(2.2); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
      @keyframes pwa-t-bounce { 0% { opacity: 0; transform: translateY(-80px); } 50% { opacity: 1; transform: translateY(0); } 65% { transform: translateY(-18px); } 80% { transform: translateY(0); } 90% { transform: translateY(-6px); } 100% { transform: none; } }
      @keyframes pwa-t-shake { 0%,100% { transform: none; } 25% { transform: translateX(-8px) rotate(-1deg); } 75% { transform: translateX(8px) rotate(1deg); } }
      @keyframes pwa-t-glow { 0%,100% { text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 10px var(--hl); } 50% { text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 28px var(--hl), 0 0 48px var(--hl); } }
      @keyframes pwa-t-rainbow { from { filter: hue-rotate(0); } to { filter: hue-rotate(360deg); } }
      @keyframes pwa-t-flip { from { opacity: 0; transform: perspective(400px) rotateX(90deg); } to { opacity: 1; transform: none; } }
      @keyframes pwa-t-jelly { 0% { opacity: 0; transform: scale(1); } 20% { opacity: 1; transform: scale(1.25, .75); } 40% { transform: scale(.75, 1.25); } 60% { transform: scale(1.15, .85); } 80% { transform: scale(.95, 1.05); } 100% { transform: none; } }
      @keyframes pwa-t-wave { 0%,100% { transform: none; } 50% { transform: translateY(-10px); } }`;
    document.head.appendChild(st);
  }

  // как ведёт себя большой значок при разном полёте частиц
  const ICON_ANIM = { burst: 'pwa-i-pulse', rise: 'pwa-i-float', rain: 'pwa-i-float', orbit: 'pwa-i-spin', fly: 'pwa-i-fly', pulse: 'pwa-i-pulse',
    twinkle: 'pwa-i-pulse', wave: 'pwa-i-float', drop: 'pwa-i-drop', shake: 'pwa-i-shake', flash: 'pwa-i-shake', spin: 'pwa-i-spin', bounce: 'pwa-i-bounce' };
  const PART_ANIM = { burst: 'pwa-burst', rise: 'pwa-rise', rain: 'pwa-rain', orbit: 'pwa-orbit', fly: 'pwa-burst', pulse: 'pwa-burst',
    twinkle: 'pwa-twinkle', wave: 'pwa-wave', drop: 'pwa-burst', shake: 'pwa-burst', flash: 'pwa-twinkle', spin: 'pwa-orbit', bounce: 'pwa-rise' };

  // сцена анимации: ref — id встроенной или 'media:<id>' (своя GIF); loop — для превью (повторяется)
  function animEl(ref, { w = 320, h = 220, loop = false } = {}) {
    injectCss();
    const stage = document.createElement('div');
    stage.className = 'pwa-stage';
    stage.style.setProperty('--w', w + 'px');
    stage.style.setProperty('--h', h + 'px');
    const url = mediaUrl(ref);
    if (url) {
      const img = document.createElement('img');
      img.className = 'pwa-gif';
      img.src = url;
      img.alt = '';
      stage.appendChild(img);
      return stage;
    }
    const a = C.ANIMS.find((x) => x.id === ref) || C.ANIMS[0];
    const n = loop ? 'infinite' : '1';
    if (a.kind === 'flash') {
      const f = document.createElement('div');
      f.className = 'pwa-flash';
      f.style.setProperty('--n', n);
      stage.appendChild(f);
    }
    const icon = document.createElement('div');
    icon.className = 'pwa-icon';
    icon.textContent = a.icon;
    icon.style.setProperty('--ia', ICON_ANIM[a.kind] || 'pwa-i-pulse');
    if (a.kind === 'drop' || a.kind === 'fly') icon.style.animation = `${ICON_ANIM[a.kind]} 1.2s ease-out both`;
    stage.appendChild(icon);
    const count = a.kind === 'orbit' || a.kind === 'spin' ? 10 : 18;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'pwa-p';
      p.textContent = a.parts[i % a.parts.length];
      const ang = rnd(0, Math.PI * 2), dist = rnd(0.5, 1.1) * w * 0.55;
      p.style.setProperty('--pa', PART_ANIM[a.kind] || 'pwa-burst');
      p.style.setProperty('--dx', (a.kind === 'rise' || a.kind === 'rain' || a.kind === 'bounce' ? rnd(-w * 0.45, w * 0.45) : Math.cos(ang) * dist).toFixed(0) + 'px');
      p.style.setProperty('--dy', (a.kind === 'wave' ? rnd(-h * 0.35, h * 0.35) : Math.sin(ang) * dist * 0.75).toFixed(0) + 'px');
      p.style.setProperty('--sw', rnd(-40, 40).toFixed(0) + 'px');
      p.style.setProperty('--r', rnd(-360, 360).toFixed(0) + 'deg');
      p.style.setProperty('--a', ((360 / count) * i).toFixed(0) + 'deg');
      p.style.setProperty('--rad', (h * rnd(0.38, 0.5)).toFixed(0) + 'px');
      p.style.setProperty('--s', rnd(0.7, 1.4).toFixed(2));
      p.style.setProperty('--d', (rnd(0, 1.2) + (a.kind === 'drop' ? 0.6 : 0)).toFixed(2) + 's');
      p.style.setProperty('--t', rnd(1.6, 2.8).toFixed(2) + 's');
      p.style.setProperty('--n', n);
      stage.appendChild(p);
    }
    return stage;
  }

  // надпись: {переменные} — подсвечиваются, {emote} — картинкой смайла (если пришёл emoteId)
  function textHtml(template, vars, opts = {}) {
    const html = esc(template).replace(/\{(\w+)\}/g, (all, k) => {
      if (!(k in (vars || {}))) return all;
      if (k === 'emote' && opts.emoteId && /^[a-f0-9]{24}$/i.test(opts.emoteId)) {
        return `<img class="pwa-emote" src="/api/emotes/${opts.emoteId}" alt=":${esc(vars.emote)}:" />`;
      }
      return `<span class="pwa-hl">${esc(vars[k])}</span>`;
    });
    return html;
  }

  // буквы по одной (для волны, печатной машинки и «по буквам»), не трогая картинки
  function splitLetters(el) {
    let i = 0;
    const walk = (node) => {
      for (const ch of [...node.childNodes]) {
        if (ch.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const c of ch.textContent) {
            const s = document.createElement('span');
            s.className = 'pwa-ch';
            s.style.setProperty('--i', i++);
            s.textContent = c;
            frag.appendChild(s);
          }
          ch.replaceWith(frag);
        } else if (ch.nodeType === 1 && ch.tagName !== 'IMG') walk(ch);
      }
    };
    walk(el);
  }

  function textEl(template, vars, cfg, opts) {
    injectCss();
    const el = document.createElement('div');
    el.className = 'pwa-text pwa-t-' + (C.TEXT_ANIMS.includes(cfg.textAnim) ? cfg.textAnim : 'pop');
    el.style.setProperty('--c', cfg.color || '#ffffff');
    el.style.setProperty('--hl', cfg.accent || '#c4b5fd');
    el.innerHTML = textHtml(template, vars, opts);
    if (['wave', 'typewriter', 'letters'].includes(cfg.textAnim)) splitLetters(el);
    return el;
  }

  // ---------- звуки: синтез WebAudio ----------
  let ctx = null;
  const audio = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };

  function tone(out, { type = 'sine', f0, f1, at = 0, dur = 0.2, vol = 0.3, attack = 0.005 }) {
    const a = out.context, t = a.currentTime + at;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  function noise(out, { at = 0, dur = 0.3, vol = 0.3, type = 'bandpass', f0 = 1000, f1, q = 1 }) {
    const a = out.context, t = a.currentTime + at;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf;
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
  const N = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Гц
  const seq = (out, notes, { type = 'sine', step = 0.09, dur = 0.25, vol = 0.25 } = {}) =>
    notes.forEach((n, i) => n && tone(out, { type, f0: N(n), at: i * step, dur, vol }));

  const RECIPES = {
    chime: (o) => seq(o, [84, 88, 91, 96], { step: 0.08, dur: 0.6, vol: 0.2 }),
    fanfare: (o) => { seq(o, [67, 72, 76], { type: 'sawtooth', step: 0.12, dur: 0.14, vol: 0.12 }); tone(o, { type: 'sawtooth', f0: N(79), at: 0.38, dur: 0.7, vol: 0.14 }); tone(o, { type: 'sawtooth', f0: N(72), at: 0.38, dur: 0.7, vol: 0.1 }); },
    coin: (o) => { tone(o, { type: 'square', f0: 988, dur: 0.08, vol: 0.15 }); tone(o, { type: 'square', f0: 1319, at: 0.08, dur: 0.35, vol: 0.15 }); },
    pop: (o) => tone(o, { f0: 900, f1: 120, dur: 0.12, vol: 0.4 }),
    whoosh: (o) => noise(o, { f0: 300, f1: 3500, dur: 0.6, vol: 0.5, q: 2 }),
    laser: (o) => tone(o, { type: 'sawtooth', f0: 1800, f1: 160, dur: 0.35, vol: 0.18 }),
    levelup: (o) => seq(o, [60, 64, 67, 72, 76, 79, 84, 88], { type: 'square', step: 0.06, dur: 0.12, vol: 0.12 }),
    magic: (o) => { tone(o, { f0: 400, f1: 1600, dur: 0.8, vol: 0.18 }); seq(o, [96, 100, 103, 108], { step: 0.12, dur: 0.4, vol: 0.12 }); },
    drumroll: (o) => { for (let i = 0; i < 18; i++) noise(o, { at: i * 0.06, dur: 0.07, vol: 0.35, type: 'lowpass', f0: 1800 }); noise(o, { at: 1.1, dur: 1.2, vol: 0.45, type: 'highpass', f0: 4000 }); },
    bell: (o) => { tone(o, { f0: 880, dur: 1.6, vol: 0.25 }); tone(o, { f0: 880 * 2.76, dur: 1.0, vol: 0.08 }); tone(o, { f0: 880 * 5.4, dur: 0.6, vol: 0.04 }); },
    boing: (o) => { tone(o, { f0: 120, f1: 420, dur: 0.15, vol: 0.3 }); tone(o, { f0: 420, f1: 180, at: 0.15, dur: 0.4, vol: 0.25 }); },
    blip: (o) => { tone(o, { type: 'square', f0: 1200, dur: 0.05, vol: 0.12 }); tone(o, { type: 'square', f0: 1600, at: 0.07, dur: 0.06, vol: 0.12 }); },
    victory: (o) => seq(o, [72, 76, 79, 84, 84], { type: 'triangle', step: 0.13, dur: 0.3, vol: 0.3 }),
    thunder: (o) => { noise(o, { dur: 2.2, vol: 0.8, type: 'lowpass', f0: 600, f1: 80 }); noise(o, { dur: 0.25, vol: 0.5, type: 'highpass', f0: 2000 }); },
    shutter: (o) => { noise(o, { dur: 0.05, vol: 0.6, type: 'highpass', f0: 3000 }); noise(o, { at: 0.09, dur: 0.07, vol: 0.5, type: 'highpass', f0: 2500 }); },
    bubble: (o) => [0, 0.12, 0.22].forEach((at, i) => tone(o, { f0: 300 + i * 150, f1: 900 + i * 250, at, dur: 0.1, vol: 0.25 })),
    siren: (o) => { for (let i = 0; i < 3; i++) { tone(o, { type: 'sawtooth', f0: 600, f1: 950, at: i * 0.5, dur: 0.25, vol: 0.08 }); tone(o, { type: 'sawtooth', f0: 950, f1: 600, at: i * 0.5 + 0.25, dur: 0.25, vol: 0.08 }); } },
    jump: (o) => tone(o, { type: 'square', f0: 260, f1: 900, dur: 0.22, vol: 0.12 }),
    success: (o) => { tone(o, { f0: N(76), dur: 0.35, vol: 0.25 }); tone(o, { f0: N(83), at: 0.16, dur: 0.6, vol: 0.25 }); },
    harp: (o) => seq(o, [60, 64, 67, 71, 74, 77, 81, 84], { type: 'triangle', step: 0.07, dur: 0.9, vol: 0.14 }),
  };

  let current = null; // свой звук (Audio), чтобы не играли два сразу
  function playSound(ref, volume = 70) {
    const vol = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
    if (!ref || ref === 'none' || !vol) return;
    const url = mediaUrl(ref);
    if (url) {
      try { current?.pause(); } catch {}
      current = new Audio(url);
      current.volume = vol;
      current.play().catch(() => {});
      return;
    }
    const recipe = RECIPES[ref];
    if (!recipe) return;
    try {
      const a = audio();
      const out = a.createGain();
      out.gain.value = vol;
      out.connect(a.destination);
      recipe(out);
    } catch (_) {}
  }

  // озвучка голосом системы (в OBS на Windows — голоса Microsoft); язык — по кириллице в тексте
  function speak(text) {
    try {
      if (!window.speechSynthesis || !text) return;
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 220));
      u.lang = /[а-яё]/i.test(text) ? 'ru-RU' : 'en-US';
      const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
      if (v) u.voice = v;
      u.rate = 1;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  // текст надписи без разметки (для озвучки)
  const plainText = (template, vars) => String(template).replace(/\{(\w+)\}/g, (all, k) => (k in (vars || {}) ? String(vars[k]) : all));

  // целый алерт: payload — { event, vars, cfg, text, emoteId }. Плавно появляется и исчезает через cfg.sec секунд
  function show(container, payload, { onDone, scale = 1 } = {}) {
    injectCss();
    const cfg = payload.cfg || {};
    const box = document.createElement('div');
    box.className = 'pwa-alert pwa-in';
    if (scale !== 1) box.style.transform = `scale(${scale})`;
    box.appendChild(animEl(cfg.anim, { w: 360 * scale, h: 240 * scale }));
    const txt = textEl(payload.text, payload.vars, cfg, { emoteId: payload.emoteId });
    if (scale !== 1) txt.style.fontSize = 34 * scale + 'px';
    box.appendChild(txt);
    container.appendChild(box);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('pwa-in')));
    playSound(cfg.sound, cfg.volume);
    if (cfg.tts) setTimeout(() => speak(plainText(payload.text, payload.vars)), 600);
    const sec = Math.min(C.SEC_MAX, Math.max(C.SEC_MIN, Number(cfg.sec) || C.DEFAULTS.sec));
    setTimeout(() => {
      box.classList.add('pwa-out');
      setTimeout(() => { box.remove(); onDone?.(); }, 650);
    }, sec * 1000);
    return box;
  }

  window.PWAlertRender = { animEl, textEl, textHtml, playSound, speak, show, plainText, mediaUrl, RECIPES };
})();
