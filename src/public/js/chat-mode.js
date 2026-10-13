// Меню ⚙ у чата эфира (студия и страница канала для модераторов с правом «настройки чата»):
// «только подписчики» + сколько подписан, медленный режим, фильтр слов. Режим хранит сервер:
// изменения уходят через emit(patch) → сокет 'chat:set-mode', текущее состояние приходит в set(mode) из 'chat:mode'
(function () {
  if (window.PWChatMode) return;

  const FOLLOW = [[0, 'now'], [10, 'min10'], [30, 'min30'], [60, 'hour1'], [1440, 'day1']];
  const SLOW = [0, 3, 5, 10, 30, 60, 120];
  const FILTER = ['off', 'weak', 'medium', 'strong', 'max'];

  const tr = (k, v) => (window.t ? window.t('common.chatMode.' + k, v) : k);
  const slowLabel = (s) => (!s ? tr('off') : s < 60 ? tr('sec', { n: s }) : tr('mins', { n: s / 60 }));

  // режим включён хоть в чём-то — кнопка ⚙ подсвечивается
  const isActive = (m) => !!m && (m.followMin !== null && m.followMin !== undefined || m.filter > 0 || m.slowSec > 0);

  // стили меню одни на студию и страницу канала — вставляем один раз
  function injectCss() {
    if (document.getElementById('pw-cm-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-cm-css';
    st.textContent = `
      .pw-cm-row { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 0; cursor: pointer; }
      .pw-cm-row > span { flex-shrink: 0; }
      .pw-cm-row input[type="checkbox"] { width: auto; margin: 0; }
      .pw-cm-row select { flex: 1; min-width: 0; margin: 0; padding: 4px 6px; font-size: 13px; }
      .pw-cm-hint { margin: 0; font-size: 12px; color: var(--text-muted); line-height: 1.4; }`;
    document.head.appendChild(st);
  }

  // extra — элемент, который всегда стоит внизу меню (в студии — кнопка «Смайлы канала»)
  function mount(box, emit, extra) {
    injectCss();
    let mode = { followMin: null, filter: 0, slowSec: 0 };

    function render() {
      box.innerHTML = '';
      const row = (cls) => { const r = document.createElement('label'); r.className = 'pw-cm-row ' + (cls || ''); box.appendChild(r); return r; };
      const select = (opts, value, onChange) => {
        const s = document.createElement('select');
        for (const [v, label] of opts) {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = label;
          s.appendChild(o);
        }
        s.value = String(value);
        s.addEventListener('change', () => onChange(s.value));
        return s;
      };
      const text = (k) => { const sp = document.createElement('span'); sp.textContent = tr(k); return sp; };

      // только подписчики
      const r1 = row('pw-cm-check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const on = mode.followMin !== null && mode.followMin !== undefined;
      cb.checked = on;
      cb.addEventListener('change', () => emit({ followMin: cb.checked ? Number(minSel.value) : null }));
      r1.append(cb, text('followersOnly'));
      const r2 = row();
      const minSel = select(FOLLOW.map(([v, k]) => [v, tr(k)]), on ? mode.followMin : 0, (v) => emit({ followMin: Number(v) }));
      minSel.disabled = !on;
      r2.append(text('minAge'), minSel);

      // медленный режим
      const r3 = row();
      r3.append(text('slow'), select(SLOW.map((s) => [s, slowLabel(s)]), mode.slowSec || 0, (v) => emit({ slowSec: Number(v) })));

      // фильтр слов
      const r4 = row();
      r4.append(text('filter'), select(FILTER.map((k, i) => [i, tr('filter_' + k)]), mode.filter || 0, (v) => emit({ filter: Number(v) })));

      const hint = document.createElement('p');
      hint.className = 'pw-cm-hint';
      hint.textContent = tr('hint');
      box.appendChild(hint);
      if (extra) box.appendChild(extra);
    }

    render();
    window.addEventListener('pw:langchange', render);
    return {
      set(m) {
        mode = { followMin: m?.followMin ?? null, filter: Number(m?.filter) || 0, slowSec: Number(m?.slowSec) || 0 };
        render();
      },
      get: () => mode,
    };
  }

  window.PWChatMode = { mount, isActive, slowLabel };
})();
