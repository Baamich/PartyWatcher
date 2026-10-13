// Смайлы в чате эфира: :code: → картинка (страница канала, студия, оверлей OBS) и кнопка 😀 у поля ввода:
// недавние (последние 20, в браузере), смайлы канала (подписчикам) и публичные
(function () {
  if (window.PWEmotes) return;

  const RECENT_KEY = 'pw-emotes-recent';
  const tr = (k, v) => (window.t ? window.t('common.emotes.' + k, v) : k);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const imgUrl = (id) => '/api/emotes/' + encodeURIComponent(id);

  // html уже экранирован; emotes — { code: id } из сообщения (сервер положил только разрешённые)
  function render(html, emotes) {
    if (!emotes || typeof emotes !== 'object') return html;
    return html.replace(/:([A-Za-z0-9_]{2,20}):/g, (all, code) => {
      const id = emotes[code];
      if (!id || !/^[a-f0-9]{24}$/i.test(id)) return all;
      return `<img class="pw-emote" src="${imgUrl(id)}" alt=":${code}:" title=":${code}:" loading="lazy" style="height:1.75em;width:auto;vertical-align:middle;margin:-0.3em 1px">`;
    });
  }

  function readRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((e) => e && e.id && e.code).slice(0, 20); } catch { return []; }
  }
  function pushRecent(e) {
    const list = [e, ...readRecent().filter((x) => x.id !== e.id)].slice(0, 20);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  }

  function injectCss() {
    if (document.getElementById('pw-emotes-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-emotes-css';
    st.textContent = `
      .pw-emo-pop { position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 30; max-height: 300px; overflow-y: auto;
        background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow); padding: 8px 10px; }
      .pw-emo-pop.hidden { display: none; }
      .pw-emo-sec { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); margin: 8px 0 4px; }
      .pw-emo-sec:first-child { margin-top: 0; }
      .pw-emo-grid { display: flex; flex-wrap: wrap; gap: 2px; }
      [data-theme] .pw-emo-btn { width: 40px; min-width: 40px; height: 40px; flex: 0 0 40px; padding: 3px; background: none; box-shadow: none; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
      [data-theme] .pw-emo-btn:hover { background: var(--surface-alt); }
      .pw-emo-btn img { width: 32px; height: 32px; object-fit: contain; }
      .pw-emo-btn.locked { opacity: .35; cursor: not-allowed; }
      .pw-emo-note { font-size: 12px; color: var(--text-muted); margin: 2px 0 4px; }
      [data-theme] .pw-emo-open { width: auto; padding: 0 8px; background: none; box-shadow: none; font-size: 18px; flex-shrink: 0; }`;
    document.head.appendChild(st);
  }

  // кнопка 😀 у поля ввода: form — контейнер (position: relative), input — поле, channel — имя канала
  function mountPicker({ form, input, channel, before }) {
    injectCss();
    form.style.position = form.style.position || 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-emo-open';
    btn.textContent = '😀';
    btn.title = tr('open');
    const pop = document.createElement('div');
    pop.className = 'pw-emo-pop hidden';
    pop.setAttribute('data-no-i18n', '');
    form.insertBefore(btn, before || null);
    form.appendChild(pop);

    let data = null;
    const insert = (e) => {
      const pos = input.selectionStart ?? input.value.length;
      const pre = input.value.slice(0, pos), post = input.value.slice(pos);
      const add = (pre && !/\s$/.test(pre) ? ' ' : '') + ':' + e.code + ': ';
      input.value = (pre + add + post).slice(0, input.maxLength > 0 ? input.maxLength : 500);
      pushRecent({ id: e.id, code: e.code });
      input.focus();
      const p = pre.length + add.length;
      try { input.setSelectionRange(p, p); } catch {}
      draw();
    };
    const grid = (list, locked) => {
      const g = document.createElement('div');
      g.className = 'pw-emo-grid';
      for (const e of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pw-emo-btn' + (locked ? ' locked' : '');
        b.title = ':' + e.code + ':';
        b.innerHTML = `<img src="${imgUrl(e.id)}" alt=":${esc(e.code)}:" loading="lazy" />`;
        if (!locked) b.addEventListener('click', () => insert(e));
        g.appendChild(b);
      }
      return g;
    };
    const sec = (key) => { const d = document.createElement('div'); d.className = 'pw-emo-sec'; d.textContent = tr(key); pop.appendChild(d); };
    const note = (key) => { const d = document.createElement('div'); d.className = 'pw-emo-note'; d.textContent = tr(key); pop.appendChild(d); };

    function draw() {
      pop.innerHTML = '';
      if (!data) { note('loading'); return; }
      const known = new Set([...data.channel, ...data.public].map((e) => e.id));
      const recent = readRecent().filter((e) => known.has(e.id) && (data.canUseChannel || data.public.some((p) => p.id === e.id)));
      if (recent.length) { sec('recent'); pop.appendChild(grid(recent)); }
      if (data.channel.length) {
        sec('channel');
        if (!data.canUseChannel) note('followToUse');
        pop.appendChild(grid(data.channel, !data.canUseChannel));
      }
      sec('public');
      if (data.public.length) pop.appendChild(grid(data.public));
      else note('noPublic');
    }

    async function load() {
      try {
        data = await api('/emotes/for/' + encodeURIComponent(channel()));
      } catch {
        data = { channel: [], public: [], canUseChannel: false };
      }
      draw();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = pop.classList.toggle('hidden') === false;
      if (open) { draw(); load(); } // свежий список: могли подписаться или стример добавил смайл
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => pop.classList.add('hidden'));
    window.addEventListener('pw:langchange', () => { btn.title = tr('open'); if (!pop.classList.contains('hidden')) draw(); });
    return { reload: load };
  }

  window.PWEmotes = { render, mountPicker, imgUrl };
})();
