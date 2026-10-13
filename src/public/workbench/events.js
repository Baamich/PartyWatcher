// Студия → 🔔 События: алерты для OBS. Справа галочки (включено = карточка на холсте), сверху ключ оверлея.
// Карточка: анимация (⟳ — выбрать), звук, надпись, озвучка, время показа, «Проверить». Всё сохраняется само
const C = window.PWAlertCatalog;
const R = window.PWAlertRender;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let st = { events: {}, media: [], keyMasked: null, layout: null, mediaMax: 30 };
let win = null;

const evName = (id) => t('alerts.ev.' + id + '.name');
const textOf = (id) => st.events[id]?.text || t('alerts.default.' + id);
const soundName = (ref) => {
  if (!ref || ref === 'none') return t('alerts.sound.none');
  if (ref.startsWith('media:')) return st.media.find((m) => m.ref === ref)?.name || t('alerts.media.ownSound');
  return t('alerts.sound.' + ref);
};

// ---------- сохранение ----------
const saveTimers = {};
function saveEvent(id, now = false) {
  clearTimeout(saveTimers[id]);
  const run = async () => {
    try {
      const r = await api('/alerts/events/' + id, { method: 'PUT', body: st.events[id] });
      st.events[id] = r.event;
    } catch (err) {
      PW.toast(err.message, 'error');
    }
  };
  if (now) return run();
  saveTimers[id] = setTimeout(run, 500);
}
let layoutTimer = null;
function saveLayout(panels) {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => api('/alerts/layout', { method: 'PUT', body: { panels } }).catch(() => {}), 500);
}

// ---------- окна-модалки ----------
function modal(titleKey, build, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'cw-modal';
  wrap.innerHTML = `<div class="cw-modal-box"><button type="button" class="cw-modal-x" aria-label="${esc(t('common.close'))}">×</button>
    <h3>${esc(t(titleKey))}</h3><div class="cw-modal-body"></div></div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.querySelector('.cw-modal-x').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  build(wrap.querySelector('.cw-modal-body'), close);
  return close;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(t('alerts.media.readFailed')));
    fr.readAsDataURL(file);
  });
}

async function upload(kind, onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'sound' ? 'audio/mpeg,audio/ogg,audio/wav,audio/webm,.mp3,.ogg,.wav' : 'image/gif,image/png,image/webp,image/jpeg';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const max = kind === 'sound' ? 1 : 3;
    if (f.size > max * 1024 * 1024) return PW.toast(t('alerts.media.tooBig', { mb: max }), 'error');
    try {
      const data = await readFile(f);
      const r = await api('/alerts/media', { method: 'POST', body: { kind, data, name: f.name.replace(/\.[^.]+$/, '') } });
      st.media.unshift(r.media);
      onDone(r.media);
    } catch (err) {
      PW.toast(err.message, 'error');
    }
  };
  input.click();
}

async function removeMedia(m, onDone) {
  const ok = await PW.confirm(t('alerts.media.deleteConfirm'), { danger: true, okText: t('common.delete') });
  if (!ok) return;
  try {
    await api('/alerts/media/' + m.id, { method: 'DELETE' });
    st.media = st.media.filter((x) => x.id !== m.id);
    // события с этим файлом — на встроенное по умолчанию
    for (const ev of C.EVENTS) {
      const cfg = st.events[ev.id];
      if (cfg.anim === m.ref) { cfg.anim = ev.anim; saveEvent(ev.id); }
      if (cfg.sound === m.ref) { cfg.sound = ev.sound; saveEvent(ev.id); }
    }
    onDone();
    renderAllCards();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// выбор анимации: сверху большое превью, ниже 20 встроенных и свои GIF
function openAnimModal(id) {
  const cfg = st.events[id];
  modal('alerts.anim.title', (body) => {
    const draw = () => {
      body.innerHTML = `<div class="am-preview"></div>
        <div class="am-sec">${esc(t('alerts.anim.builtin'))}</div><div class="am-grid" data-g="b"></div>
        <div class="am-sec">${esc(t('alerts.anim.own'))}</div><div class="am-grid" data-g="o"></div>`;
      body.querySelector('.am-preview').appendChild(R.animEl(cfg.anim, { w: 360, h: 200, loop: true }));
      const tile = (ref, label, onDel) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'am-tile' + (cfg.anim === ref ? ' on' : '');
        b.title = label;
        b.appendChild(R.animEl(ref, { w: 92, h: 64, loop: cfg.anim === ref }));
        const cap = document.createElement('span');
        cap.textContent = label;
        b.appendChild(cap);
        b.addEventListener('click', () => { cfg.anim = ref; saveEvent(id); draw(); renderCard(id); });
        if (onDel) {
          const x = document.createElement('span');
          x.className = 'am-del';
          x.textContent = '✕';
          x.title = t('common.delete');
          x.addEventListener('click', (e) => { e.stopPropagation(); onDel(); });
          b.appendChild(x);
        }
        return b;
      };
      const g1 = body.querySelector('[data-g="b"]');
      for (const a of C.ANIMS) g1.appendChild(tile(a.id, t('alerts.anim.' + a.id)));
      const g2 = body.querySelector('[data-g="o"]');
      for (const m of st.media.filter((x) => x.kind === 'image')) g2.appendChild(tile(m.ref, m.name || 'GIF', () => removeMedia(m, draw)));
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'am-tile am-upload';
      up.innerHTML = `<b>＋</b><span>${esc(t('alerts.anim.upload'))}</span>`;
      up.addEventListener('click', () => upload('image', (m) => { cfg.anim = m.ref; saveEvent(id); draw(); renderCard(id); }));
      g2.appendChild(up);
    };
    draw();
  }, () => saveEvent(id, true));
}

// выбор звука: ▶ — послушать, клик по строке — выбрать; свои звуки и громкость
function openSoundModal(id) {
  const cfg = st.events[id];
  modal('alerts.sound.title', (body) => {
    const draw = () => {
      body.innerHTML = `<label class="sm-vol"><span>${esc(t('alerts.sound.volume'))}</span><input type="range" min="0" max="100" value="${cfg.volume}" /><b>${cfg.volume}%</b></label>
        <div class="sm-list"></div>`;
      const vol = body.querySelector('.sm-vol input');
      vol.addEventListener('input', () => { cfg.volume = Number(vol.value); body.querySelector('.sm-vol b').textContent = cfg.volume + '%'; saveEvent(id); });
      const list = body.querySelector('.sm-list');
      const row = (ref, label, onDel) => {
        const r = document.createElement('div');
        r.className = 'sm-row' + (cfg.sound === ref ? ' on' : '');
        r.innerHTML = `<button type="button" class="sm-play" title="${esc(t('alerts.sound.listen'))}">▶</button><span>${esc(label)}</span>`;
        r.querySelector('.sm-play').addEventListener('click', (e) => { e.stopPropagation(); R.playSound(ref, cfg.volume || 70); });
        r.addEventListener('click', () => { cfg.sound = ref; saveEvent(id); R.playSound(ref, cfg.volume || 70); draw(); renderCard(id); });
        if (onDel) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'sm-del';
          x.textContent = '✕';
          x.title = t('common.delete');
          x.addEventListener('click', (e) => { e.stopPropagation(); onDel(); });
          r.appendChild(x);
        }
        list.appendChild(r);
      };
      row('none', t('alerts.sound.none'));
      for (const s of C.SOUNDS) row(s, t('alerts.sound.' + s));
      for (const m of st.media.filter((x) => x.kind === 'sound')) row(m.ref, '🎵 ' + (m.name || t('alerts.media.ownSound')), () => removeMedia(m, draw));
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'icon-btn sm-upload';
      up.textContent = t('alerts.sound.upload');
      up.addEventListener('click', () => upload('sound', (m) => { cfg.sound = m.ref; saveEvent(id); draw(); renderCard(id); }));
      body.appendChild(up);
    };
    draw();
  }, () => saveEvent(id, true));
}

// надпись: шаблон с переменными, анимация текста, цвета, живое превью на примере
function openTextModal(id) {
  const ev = C.eventById(id);
  const cfg = st.events[id];
  modal('alerts.text.title', (body) => {
    body.innerHTML = `
      <div class="tm-preview"></div>
      <textarea class="tm-input" rows="2" maxlength="200"></textarea>
      <div class="tm-vars"><span>${esc(t('alerts.text.vars'))}</span></div>
      <div class="tm-row"><button type="button" class="icon-btn tm-reset">${esc(t('alerts.text.reset'))}</button>
        <label>${esc(t('alerts.text.color'))} <input type="color" class="tm-c" value="${cfg.color}" /></label>
        <label>${esc(t('alerts.text.accent'))} <input type="color" class="tm-a" value="${cfg.accent}" /></label></div>
      <div class="am-sec">${esc(t('alerts.text.anim'))}</div><div class="tm-anims"></div>`;
    const input = body.querySelector('.tm-input');
    input.value = cfg.text || t('alerts.default.' + id);
    const preview = () => {
      const box = body.querySelector('.tm-preview');
      box.innerHTML = '';
      box.appendChild(R.textEl(input.value, ev.sample, cfg, {}));
    };
    const changed = () => {
      // свой текст = отличается от надписи по умолчанию; совпал — храним пусто (оверлей возьмёт на своём языке)
      cfg.text = input.value.trim() === t('alerts.default.' + id) ? '' : input.value.trim();
      saveEvent(id);
      preview();
      renderCard(id);
    };
    input.addEventListener('input', changed);
    const vars = body.querySelector('.tm-vars');
    for (const v of ev.vars) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tm-chip';
      chip.textContent = '{' + v + '}';
      chip.title = t('alerts.var.' + v);
      chip.addEventListener('click', () => {
        const p = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, p) + '{' + v + '}' + input.value.slice(p);
        input.focus();
        changed();
      });
      vars.appendChild(chip);
    }
    body.querySelector('.tm-reset').addEventListener('click', () => { input.value = t('alerts.default.' + id); changed(); });
    body.querySelector('.tm-c').addEventListener('input', (e) => { cfg.color = e.target.value; saveEvent(id); preview(); });
    body.querySelector('.tm-a').addEventListener('input', (e) => { cfg.accent = e.target.value; saveEvent(id); preview(); });
    const anims = body.querySelector('.tm-anims');
    const drawAnims = () => {
      anims.innerHTML = '';
      for (const a of C.TEXT_ANIMS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tm-anim' + (cfg.textAnim === a ? ' on' : '');
        b.textContent = t('alerts.textAnim.' + a);
        b.addEventListener('click', () => { cfg.textAnim = a; saveEvent(id); drawAnims(); preview(); });
        anims.appendChild(b);
      }
    };
    drawAnims();
    preview();
  }, () => saveEvent(id, true));
}

// ---------- карточки ----------
const CHANGE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M18.5 2.5v4.5H14M5.5 21.5V17H10" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderCard(id) {
  const ev = C.eventById(id);
  const cfg = st.events[id];
  if (!cfg?.on) return win.close(id);
  const p = win.open(id, 'ev-card');
  p.title.textContent = ev.icon + ' ' + evName(id);
  p.close.title = t('alerts.card.disable');
  p.content.innerHTML = `
    <div class="ev-preview"><button type="button" class="ev-change" title="${esc(t('alerts.anim.title'))}">${CHANGE_ICON}</button></div>
    <div class="ev-text" title="${esc(t('alerts.text.title'))}"></div>
    <div class="ev-row">
      <button type="button" class="icon-btn ev-sound">🔊 <span></span></button>
      <button type="button" class="icon-btn ev-edit">${esc(t('alerts.card.editText'))}</button>
    </div>
    ${ev.param ? `<label class="ev-param"><span>${esc(t('alerts.ev.' + id + '.param'))}</span><input type="number" min="${ev.param.min}" max="${ev.param.max}" value="${cfg.param}" /></label>` : ''}
    <div class="ev-bottom">
      <label class="ev-tts"><input type="checkbox" ${cfg.tts ? 'checked' : ''} /> <span>${esc(t('alerts.card.tts'))}</span></label>
      <label class="ev-sec"><input type="number" min="${C.SEC_MIN}" max="${C.SEC_MAX}" value="${cfg.sec}" /> <span>${esc(t('alerts.card.sec'))}</span></label>
      <button type="button" class="ev-test">${esc(t('alerts.card.test'))}</button>
    </div>`;
  const prev = p.content.querySelector('.ev-preview');
  prev.prepend(R.animEl(cfg.anim, { w: 180, h: 110, loop: true }));
  // надпись в карточке — html из шаблона (переменные подсвечены), не текст пользователя целиком
  p.content.querySelector('.ev-text').innerHTML = R.textHtml(textOf(id), ev.sample, {});
  p.content.querySelector('.ev-text').style.setProperty('--hl', cfg.accent);
  p.content.querySelector('.ev-sound span').textContent = soundName(cfg.sound);
  p.content.querySelector('.ev-change').addEventListener('click', () => openAnimModal(id));
  p.content.querySelector('.ev-preview').addEventListener('dblclick', () => openAnimModal(id));
  p.content.querySelector('.ev-sound').addEventListener('click', () => openSoundModal(id));
  p.content.querySelector('.ev-edit').addEventListener('click', () => openTextModal(id));
  p.content.querySelector('.ev-text').addEventListener('click', () => openTextModal(id));
  p.content.querySelector('.ev-tts input').addEventListener('change', (e) => { cfg.tts = e.target.checked; saveEvent(id); });
  // время показа: 3–10 с, неверное поправляется само
  const sec = p.content.querySelector('.ev-sec input');
  sec.addEventListener('change', () => {
    const v = Math.round(Number(sec.value));
    cfg.sec = Math.min(C.SEC_MAX, Math.max(C.SEC_MIN, Number.isFinite(v) ? v : C.DEFAULTS.sec));
    sec.value = cfg.sec;
    saveEvent(id);
  });
  const param = p.content.querySelector('.ev-param input');
  param?.addEventListener('change', () => {
    const v = Math.round(Number(param.value));
    cfg.param = Math.min(ev.param.max, Math.max(ev.param.min, Number.isFinite(v) ? v : ev.param.def));
    param.value = cfg.param;
    saveEvent(id);
  });
  p.content.querySelector('.ev-test').addEventListener('click', () => testEvent(id));
}

function renderAllCards() {
  for (const ev of C.EVENTS) renderCard(ev.id);
}

// «Проверить»: в OBS (если оверлей подключён) и сразу здесь, чтобы было видно и слышно
const localStage = (() => {
  const d = document.createElement('div');
  d.className = 'ev-local-stage';
  d.setAttribute('data-no-i18n', '');
  document.body.appendChild(d);
  return d;
})();
async function testEvent(id) {
  await saveEvent(id, true);
  const ev = C.eventById(id);
  localStage.innerHTML = '';
  R.show(localStage, { event: id, vars: ev.sample, cfg: st.events[id], text: textOf(id) }, { scale: 0.75 });
  try {
    await api('/alerts/test/' + id, { method: 'POST' });
    PW.toast(t('alerts.card.testSent'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  }
}

// ---------- галочки справа ----------
function renderPicker() {
  const box = document.getElementById('cwChecks');
  box.innerHTML = '';
  for (const ev of C.EVENTS) {
    const lab = document.createElement('label');
    lab.className = 'cw-check';
    lab.title = t('alerts.ev.' + ev.id + '.desc');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.events[ev.id]?.on;
    cb.addEventListener('change', () => setOn(ev.id, cb.checked));
    const span = document.createElement('span');
    span.textContent = ev.icon + ' ' + evName(ev.id);
    lab.append(cb, span);
    box.appendChild(lab);
  }
}

function setOn(id, on) {
  st.events[id].on = on;
  saveEvent(id, true);
  renderCard(id);
  renderPicker();
}

// ---------- ключ ----------
function renderKey() {
  document.getElementById('alertKey').textContent = st.keyMasked || t('alerts.key.none');
}
async function fullKey() {
  try {
    return (await api('/alerts/key')).key;
  } catch (err) {
    if (err.status !== 404) throw err;
    const r = await api('/alerts/key', { method: 'POST' });
    st.keyMasked = r.keyMasked;
    renderKey();
    return r.key;
  }
}
document.getElementById('alertCopyUrl').addEventListener('click', async () => {
  try {
    const url = location.origin + '/overlay/alerts.html?key=' + encodeURIComponent(await fullKey());
    await navigator.clipboard.writeText(url);
    PW.toast(t('alerts.key.copied'), 'success');
  } catch (err) {
    PW.toast(err.message || t('common.requestFailed'), 'error');
  }
});
document.getElementById('alertNewKey').addEventListener('click', async () => {
  const ok = await PW.confirm(t('alerts.key.newConfirm'), { danger: true, okText: t('alerts.key.generate') });
  if (!ok) return;
  try {
    const r = await api('/alerts/key', { method: 'POST' });
    st.keyMasked = r.keyMasked;
    renderKey();
    PW.toast(t('alerts.key.created'), 'success');
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});

async function resetCardsLayout() {
  const ok = await PW.confirm(t('alerts.layoutReset'));
  if (!ok) return;
  win.resetPanels();
  api('/alerts/layout', { method: 'DELETE' }).catch(() => {});
}

async function goProfile() {
  try {
    const me = await api('/auth/me');
    location.href = me.streamerName ? '/streamers/' + encodeURIComponent(me.streamerName.toLowerCase()) : '/streamers/edit.html';
  } catch {
    location.href = '/';
  }
}

(async function init() {
  const canvas = document.getElementById('cwCanvas');
  const picker = document.getElementById('cwPicker');
  const topBar = document.getElementById('cwTopBar');
  win = PWCanvasWindows.create({
    canvas, picker, topBar, minW: 240, minH: 260,
    defRect: (id) => PWCanvasWindows.gridRect({ index: C.EVENTS.findIndex((e) => e.id === id), picker, topBar, w: 280, h: 330 }),
    onLayout: saveLayout,
    onClose: (id) => setOn(id, false),
  });
  try {
    const d = await api('/alerts/settings');
    st = { ...st, ...d };
  } catch (err) {
    PW.toast(err.message, 'error');
    return;
  }
  win.setPanels(st.layout?.panels);
  renderKey();
  renderPicker();
  renderAllCards();
  window.addEventListener('pw:langchange', () => { renderPicker(); renderAllCards(); renderKey(); });
})();
