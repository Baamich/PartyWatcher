// Скриншоты к обращению (поддержка, 🚩 жалоба на эфир): до 5 картинок — кнопкой, Ctrl+V или перетаскиванием.
// Картинки пережимаются в браузере (до 1920 px, webp/jpeg) и уходят на сервер data:URL-ами в поле files.
//   const att = PWAttach.create(box, { max: 5, pasteRoot: modal });
//   att.files() → [dataUrl…]   att.clear()   att.setEnabled(bool) (выключено — блок скрыт, картинки сброшены)
(function () {
  if (window.PWAttach) return;

  const tr = (k, v) => window.t('common.attach.' + k, v);
  const MAX_SIDE = 1920;
  const MAX_CHARS = 1300000; // ~950 КБ картинки; сервер принимает до 1 МБ
  const TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;

  function injectCss() {
    if (document.getElementById('pw-att-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-att-css';
    st.textContent = `
      .pw-att { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; padding: 8px; border: 1px dashed var(--border); border-radius: var(--radius-sm); transition: border-color .15s, background .15s; }
      .pw-att.drag { border-color: var(--accent-text); background: var(--surface-alt); }
      .pw-att-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pw-att-hint { font-size: 12px; color: var(--text-muted); }
      .pw-att-list { display: flex; gap: 6px; flex-wrap: wrap; }
      .pw-att-list:empty { display: none; }
      .pw-att-item { position: relative; width: 64px; height: 64px; border-radius: 6px; overflow: hidden; background: var(--surface-alt); border: 1px solid var(--border); }
      .pw-att-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
      [data-theme] .pw-att-del { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; min-height: 0; padding: 0; border-radius: 50%; font-size: 13px; line-height: 20px;
        background: rgba(0,0,0,.65); color: #fff; box-shadow: none; border: 0; }
      [data-theme] .pw-att-del:hover { background: rgba(0,0,0,.85); box-shadow: none; }
      .pw-att-err { font-size: 12px; color: var(--danger, #e5484d); }
    `;
    document.head.appendChild(st);
  }

  async function compress(file) {
    if (!file || !TYPES.test(file.type)) throw new Error(tr('notImage'));
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (_) { throw new Error(tr('notImage')); }
    let side = MAX_SIDE;
    for (let i = 0; i < 5; i++) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      let url = c.toDataURL('image/webp', 0.85);
      if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.85);
      if (url.length <= MAX_CHARS) return url;
      side *= 0.75;
    }
    throw new Error(tr('tooBig'));
  }

  function create(box, opts = {}) {
    injectCss();
    const max = opts.max || 5;
    let items = []; // dataUrl
    let enabled = true;
    let busy = 0;

    box.classList.add('pw-att');
    box.innerHTML = `
      <div class="pw-att-row">
        <button type="button" class="icon-btn pw-att-add">${tr('add')}</button>
        <span class="pw-att-hint"></span>
      </div>
      <div class="pw-att-list"></div>
      <div class="pw-att-err hidden"></div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden />`;
    const addBtn = box.querySelector('.pw-att-add');
    const hint = box.querySelector('.pw-att-hint');
    const list = box.querySelector('.pw-att-list');
    const err = box.querySelector('.pw-att-err');
    const input = box.querySelector('input[type=file]');

    function render() {
      hint.textContent = tr('hint', { n: items.length, max });
      addBtn.disabled = items.length >= max || busy > 0;
      list.innerHTML = '';
      items.forEach((url, i) => {
        const el = document.createElement('div');
        el.className = 'pw-att-item';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'pw-att-del';
        del.textContent = '×';
        del.title = tr('remove');
        del.setAttribute('aria-label', tr('remove'));
        del.addEventListener('click', () => { items.splice(i, 1); showErr(''); render(); });
        el.append(img, del);
        list.appendChild(el);
      });
    }
    function showErr(text) {
      err.textContent = text;
      err.classList.toggle('hidden', !text);
    }

    async function add(files) {
      if (!enabled) return;
      const imgs = [...files].filter((f) => f && f.type && f.type.startsWith('image/'));
      if (!imgs.length) return;
      showErr('');
      const room = max - items.length;
      if (room <= 0) return showErr(tr('tooMany', { max }));
      if (imgs.length > room) showErr(tr('tooMany', { max }));
      busy++;
      render();
      try {
        for (const f of imgs.slice(0, room)) {
          try { items.push(await compress(f)); } catch (e) { showErr(e.message); }
          if (items.length >= max) break;
        }
      } finally {
        busy--;
        render();
      }
    }

    addBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    box.addEventListener('dragover', (e) => { if (!enabled) return; e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', (e) => {
      box.classList.remove('drag');
      if (!enabled) return;
      e.preventDefault();
      add(e.dataTransfer?.files || []);
    });
    // Ctrl+V — где угодно внутри окна (в том числе в поле текста), если в буфере картинка
    (opts.pasteRoot || box).addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile());
      if (!enabled || !files.some((f) => f && f.type.startsWith('image/'))) return;
      e.preventDefault();
      add(files);
    });
    window.addEventListener('pw:langchange', () => {
      addBtn.textContent = tr('add');
      render();
    });

    render();
    return {
      files: () => items.slice(),
      busy: () => busy > 0,
      clear() { items = []; showErr(''); render(); },
      setEnabled(on) {
        enabled = !!on;
        box.classList.toggle('hidden', !enabled);
        if (!enabled) { items = []; showErr(''); render(); }
      },
    };
  }

  window.PWAttach = { create };
})();
