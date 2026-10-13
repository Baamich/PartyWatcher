// Рейд: окно выбора эфира (студия и 🛠 у высшего модератора), плашка с отсчётом сверху чата у зрителей
// и баннер «Рейд от …» у того, к кому пришли. Сервер — сокет /chat: chat:raid-start / chat:raid / chat:raid-go / chat:raided
(function () {
  if (window.PWRaid) return;

  const tr = (k, v) => (window.t ? window.t('common.raid.' + k, v) : k);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ava = (url, name) => (url ? `<img src="${esc(url)}" alt="" />` : `<span>${esc(String(name || '?').charAt(0).toUpperCase())}</span>`);
  const catName = (c) => (window.I18N?.lang === 'ru' && c?.ru) || c?.name || '';

  function injectCss() {
    if (document.getElementById('pw-raid-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-raid-css';
    st.textContent = `
      .pw-raid-modal { position: fixed; inset: 0; z-index: 4000; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
      .pw-raid-box { width: min(460px, 100%); max-height: min(640px, 90vh); display: flex; flex-direction: column; gap: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 16px 50px rgba(0,0,0,.45); padding: 18px; }
      .pw-raid-box h3 { margin: 0; font-size: 18px; }
      .pw-raid-box input { width: 100%; box-sizing: border-box; margin: 0; }
      .pw-raid-list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 80px; }
      [data-theme] .pw-raid-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; background: none; box-shadow: none; border-radius: var(--radius-sm); color: var(--text); text-align: left; font-weight: 500; }
      [data-theme] .pw-raid-row:hover { background: var(--surface-alt); }
      .pw-raid-ava { flex: 0 0 36px; width: 36px; height: 36px; border-radius: 50%; overflow: hidden; background: #000; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--danger); }
      .pw-raid-ava img { width: 100%; height: 100%; object-fit: cover; }
      .pw-raid-txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .pw-raid-txt b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pw-raid-txt small { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pw-raid-viewers { color: var(--danger); font-size: 12px; white-space: nowrap; }
      .pw-raid-empty { color: var(--text-muted); font-size: 13px; padding: 8px; }
      .pw-raid-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .pw-raid-actions button { width: auto; }
      .pw-raid-sec { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .pw-raid-sec input { width: 90px; }

      .pw-raid-bar { overflow: hidden; flex-shrink: 0; animation: pw-raid-down .45s cubic-bezier(.2,.9,.3,1.2); }
      @keyframes pw-raid-down { from { max-height: 0; opacity: 0; transform: translateY(-100%); } to { max-height: 140px; opacity: 1; transform: none; } }
      .pw-raid-bar-in { display: flex; align-items: center; gap: 10px; padding: 10px 12px; color: #fff;
        background: linear-gradient(120deg, #7c3aed, #db2777 60%, #f97316); background-size: 200% 100%; animation: pw-raid-glow 3s linear infinite; }
      @keyframes pw-raid-glow { to { background-position: -200% 0; } }
      .pw-raid-bar .pw-raid-ava { box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
      .pw-raid-bar-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 13px; }
      .pw-raid-bar-txt b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pw-raid-count { font-size: 22px; font-weight: 900; font-variant-numeric: tabular-nums; min-width: 34px; text-align: center; }
      [data-theme] .pw-raid-bar button { width: auto; padding: 5px 10px; font-size: 12px; background: rgba(255,255,255,.2); box-shadow: none; color: #fff; border: 1px solid rgba(255,255,255,.4); }
      [data-theme] .pw-raid-bar button:hover { background: rgba(255,255,255,.32); }
      .pw-raid-bar.out { animation: pw-raid-up .35s ease forwards; }
      @keyframes pw-raid-up { to { max-height: 0; opacity: 0; } }`;
    document.head.appendChild(st);
  }

  // окно выбора: живые эфиры (кроме своего) → подтверждение и задержка → onStart(nameLower, seconds)
  async function openPicker({ self, onStart }) {
    injectCss();
    const wrap = document.createElement('div');
    wrap.className = 'pw-raid-modal';
    const box = document.createElement('div');
    box.className = 'pw-raid-box';
    wrap.appendChild(box);
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);

    let live = [];
    try {
      const d = await api('/streams/directory?view=all');
      live = (d.list || []).filter((s) => s.isLive && s.streamerName.toLowerCase() !== String(self || '').toLowerCase());
    } catch (err) {
      PW.toast(err.message, 'error');
    }

    function showList(filter = '') {
      box.innerHTML = `<h3>${esc(tr('pickTitle'))}</h3><input type="text" autocomplete="off" placeholder="${esc(tr('search'))}" /><div class="pw-raid-list"></div>
        <div class="pw-raid-actions"><button type="button" class="icon-btn" data-x>${esc(tr('close'))}</button></div>`;
      const input = box.querySelector('input');
      const list = box.querySelector('.pw-raid-list');
      input.value = filter;
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const rows = live.filter((s) => !q || s.streamerName.toLowerCase().includes(q));
        list.innerHTML = rows.length ? '' : `<div class="pw-raid-empty">${esc(live.length ? tr('notFound') : tr('nobody'))}</div>`;
        for (const s of rows) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pw-raid-row';
          b.innerHTML = `<span class="pw-raid-ava">${ava(s.avatarUrl, s.streamerName)}</span>
            <span class="pw-raid-txt"><b>${esc(s.streamerName)}</b><small>${esc(s.title || catName(s.category))}</small></span>
            <span class="pw-raid-viewers">● ${s.viewers || 0}</span>`;
          b.addEventListener('click', () => showConfirm(s, input.value));
          list.appendChild(b);
        }
      };
      input.addEventListener('input', draw);
      box.querySelector('[data-x]').addEventListener('click', close);
      draw();
      input.focus();
    }

    function showConfirm(s, filter) {
      box.innerHTML = `<h3>${esc(tr('confirm', { name: s.streamerName }))}</h3>
        <div class="pw-raid-row" style="pointer-events:none"><span class="pw-raid-ava">${ava(s.avatarUrl, s.streamerName)}</span>
          <span class="pw-raid-txt"><b>${esc(s.streamerName)}</b><small>${esc(s.title || catName(s.category))}</small></span></div>
        <label class="pw-raid-sec"><span>${esc(tr('seconds'))}</span><input type="number" min="5" max="120" value="15" /></label>
        <div class="pw-raid-actions"><button type="button" class="icon-btn" data-back>${esc(tr('back'))}</button><button type="button" data-go>${esc(tr('start'))}</button></div>`;
      box.querySelector('[data-back]').addEventListener('click', () => showList(filter));
      box.querySelector('[data-go]').addEventListener('click', () => {
        const sec = Math.min(120, Math.max(5, Math.round(Number(box.querySelector('input').value) || 15)));
        onStart(s.streamerName.toLowerCase(), sec);
        close();
      });
    }

    showList();
  }

  // плашка с отсчётом сверху чата: ev — { to: { name, nameLower, avatarUrl, title }, seconds }
  // opts: { canCancel, onCancel, onStay } — у зрителя «Остаться», у стримера/модератора с правом — «Отменить рейд»
  function banner(container, ev, opts = {}) {
    injectCss();
    container.querySelectorAll(':scope > .pw-raid-bar').forEach((x) => x.remove());
    const bar = document.createElement('div');
    bar.className = 'pw-raid-bar';
    bar.setAttribute('data-no-i18n', '');
    bar.innerHTML = `<div class="pw-raid-bar-in"><span class="pw-raid-ava">${ava(ev.to.avatarUrl, ev.to.name)}</span>
      <span class="pw-raid-bar-txt"><span>${esc(tr('banner'))}</span><b>${esc(ev.to.name)}</b></span>
      <span class="pw-raid-count"></span><button type="button"></button></div>`;
    const count = bar.querySelector('.pw-raid-count');
    const btn = bar.querySelector('button');
    btn.textContent = opts.canCancel ? tr('cancel') : tr('stay');
    let left = Math.max(1, Math.round(ev.seconds || 15));
    count.textContent = left;
    const timer = setInterval(() => {
      left -= 1;
      count.textContent = left > 0 ? left : '🚀';
      if (left <= 0) clearInterval(timer);
    }, 1000);
    const destroy = () => {
      clearInterval(timer);
      bar.classList.add('out');
      setTimeout(() => bar.remove(), 350);
    };
    btn.addEventListener('click', () => {
      if (opts.canCancel) opts.onCancel?.();
      else { opts.onStay?.(); destroy(); }
    });
    container.prepend(bar);
    return { destroy };
  }

  // баннер у того, к кому пришли: raid — { from, viewers, avatarUrl }
  function raided(container, raid) {
    injectCss();
    const bar = document.createElement('div');
    bar.className = 'pw-raid-bar';
    bar.setAttribute('data-no-i18n', '');
    bar.innerHTML = `<div class="pw-raid-bar-in"><span class="pw-raid-ava">${ava(raid.avatarUrl, raid.from)}</span>
      <span class="pw-raid-bar-txt"><b>${esc(tr('raided', { name: raid.from }))}</b><span>${esc(tr('raidedViewers', { n: raid.viewers || 0 }))}</span></span>
      <span class="pw-raid-count">🚀</span></div>`;
    container.prepend(bar);
    setTimeout(() => { bar.classList.add('out'); setTimeout(() => bar.remove(), 350); }, 9000);
  }

  // строка сообщения «Рейд от …» в чате (сообщение с source: 'raid')
  const messageText = (msg) => tr('message', { name: msg.raid?.from || msg.senderUsername, n: msg.raid?.viewers ?? 0 });

  window.PWRaid = { openPicker, banner, raided, messageText };
})();
