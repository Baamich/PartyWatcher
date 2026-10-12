// Переиспользуемая выдача поиска Kodik: карточки (постер / название / год) + выбор озвучки.
// Один рендер на двоих: создание комнаты (index.js) и смена видео в комнате (room.js).
// Подписи берутся по префиксу ключа (keyPrefix), т.к. страницы грузят разные словари:
// на главной — index.kodik.*, в комнате — room.kodik.*.
const t = (...a) => window.t(...a);

function note(text) {
  const el = document.createElement('div');
  el.className = 'kodik-note';
  el.textContent = text;
  return el;
}

export function createKodikResults(box, { keyPrefix = 'index.kodik', onPickChange } = {}) {
  const k = (name) => `${keyPrefix}.${name}`;
  let items = [];
  let pick = null; // { item, tr }

  function trLabel(tr) {
    const parts = [tr.title || '—'];
    if (tr.subs) parts.push(t(k('subs')));
    if (tr.episodes) parts.push(t(k('episodes'), { n: tr.episodes }));
    return parts.join(' · ');
  }

  function setPick(next) {
    pick = next;
    onPickChange?.(pick);
    render();
  }

  function render() {
    if (!items.length) {
      box.replaceChildren(note(t(k('nothing'))));
      return;
    }
    box.replaceChildren(...items.map((item) => {
      const card = document.createElement('div');
      card.className = 'kodik-item' + (pick?.item === item ? ' selected' : '');

      const poster = document.createElement(item.poster ? 'img' : 'div');
      poster.className = 'kodik-poster';
      if (item.poster) {
        poster.src = item.poster;
        poster.loading = 'lazy';
        poster.alt = '';
        poster.referrerPolicy = 'no-referrer';
      } else {
        poster.textContent = '🎬';
      }

      const info = document.createElement('div');
      info.className = 'kodik-info';
      const title = document.createElement('div');
      title.className = 'kodik-title';
      title.setAttribute('data-no-i18n', '');
      title.textContent = item.title;
      const sub = document.createElement('div');
      sub.className = 'kodik-sub';
      sub.textContent = [
        item.year,
        t(item.serial ? k('serial') : k('movie')),
        t(k('voices'), { n: item.translations.length }),
      ].filter(Boolean).join(' · ');
      info.append(title, sub);

      if (pick?.item === item) {
        const select = document.createElement('select');
        select.className = 'kodik-voice';
        select.setAttribute('data-no-i18n', '');
        select.title = t(k('voice'));
        item.translations.forEach((tr, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = trLabel(tr);
          opt.selected = tr === pick.tr;
          select.appendChild(opt);
        });
        select.addEventListener('click', (e) => e.stopPropagation());
        select.addEventListener('change', () => {
          pick.tr = item.translations[Number(select.value)];
          onPickChange?.(pick);
        });
        info.appendChild(select);
      }

      card.append(poster, info);
      card.addEventListener('click', () => {
        if (pick?.item === item) return;
        setPick({ item, tr: item.translations[0] });
      });
      return card;
    }));
  }

  return {
    getPick: () => pick,
    hasItems: () => items.length > 0,
    render,
    setItems(next) {
      items = Array.isArray(next) ? next : [];
      pick = null;
      onPickChange?.(null);
      render();
    },
    searching() {
      box.replaceChildren(note(t(k('searching'))));
    },
    error(msg) {
      items = [];
      pick = null;
      onPickChange?.(null);
      box.replaceChildren(note(msg || t(k('failed'))));
    },
  };
}
