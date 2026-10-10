// Локализация в браузере. Подключается ПЕРВЫМ скриптом в <head> (без defer/async):
//   <script src="/js/i18n.js?v=3" data-ns="index"></script>
// data-ns — разделы словаря этой страницы (common грузится всегда), файлы — src/locales/<язык>/<раздел>.json.
// В JS:     t('room.copied'), t('room.viewers', { n: 5 }) — значение-объект { one, few, many, other } = плюрал.
// В HTML:   data-i18n="ключ" (текст), data-i18n-html (разметка), data-i18n-placeholder, data-i18n-title,
//           data-i18n-aria-label, data-i18n-alt, data-i18n-content (для <meta>). Ставить только на «листья»:
//           data-i18n заменяет всё содержимое элемента.
// Переключатель языка: пустой <div data-lang-switch></div> — флаг и меню рисуются здесь.
(function () {
  if (window.I18N) return;

  const LANGS = {
    ru: { label: 'RU', name: 'Русский', locale: 'ru-RU', flag: '/img/flags/ru.svg' },
    en: { label: 'EN', name: 'English', locale: 'en-GB', flag: '/img/flags/gb.svg' },
  };
  const COOKIE = 'pw_lang';

  function readCookie() {
    const m = document.cookie.match(/(?:^|;\s*)pw_lang=([a-z]{2})/i);
    const v = m && m[1].toLowerCase();
    return v && LANGS[v] ? v : null;
  }

  // язык системы/браузера → наш: русский для ru и соседних (их носители обычно читают по-русски)
  const RU_FAMILY = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'ka', 'tt', 'ba', 'cv', 'mn'];
  function mapLang(tag) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    if (RU_FAMILY.indexOf(base) !== -1) return 'ru';
    if (base === 'en') return 'en';
    return null;
  }

  // cookie → языки браузера по порядку предпочтения (обычно совпадают с языком системы) → английский
  function detect() {
    const fromCookie = readCookie();
    if (fromCookie) return fromCookie;
    const list = []
      .concat(navigator.languages || [])
      .concat(navigator.language || [])
      .concat(typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : []);
    for (const tag of list) {
      const l = mapLang(tag);
      if (l) return l;
    }
    return 'en';
  }

  const lang = detect();
  document.documentElement.setAttribute('lang', lang);

  // словари этой страницы — синхронно, сразу после этого скрипта (до остальных <script>)
  const me = document.currentScript;
  const ns = (me && me.getAttribute('data-ns')) || '';
  const nsList = ['common'].concat(ns.split(',').map((s) => s.trim()).filter(Boolean));
  // &r= — только чтобы сменить адрес: браузеры держали прежний ответ (и 404 во время деплоя) по 4 ч из-за Cloudflare
  if (!window.PW_I18N_DATA) {
    document.write('<script src="/locales/' + lang + '.js?ns=' + encodeURIComponent(nsList.join(',')) + '&r=2"><\/script>');
  }

  const pluralRules = typeof Intl !== 'undefined' && Intl.PluralRules ? new Intl.PluralRules(lang) : null;

  function dict() {
    return window.PW_I18N_DATA || {};
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(dict(), key);
  }

  function t(key, vars) {
    let v = dict()[key];
    if (v === undefined) return key;
    if (typeof v === 'object') {
      const n = Number(vars && (vars.n ?? vars.count)) || 0;
      const form = pluralRules ? pluralRules.select(n) : n === 1 ? 'one' : 'other';
      v = v[form] ?? v.other ?? v.many ?? '';
    }
    if (!vars) return v;
    return String(v).replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
  }

  const ATTRS = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-alt', 'alt'],
    ['data-i18n-content', 'content'],
  ];
  const SELECTOR = '[data-i18n],[data-i18n-html],' + ATTRS.map((a) => '[' + a[0] + ']').join(',');

  function translateEl(el) {
    const k = el.getAttribute('data-i18n');
    if (k && has(k)) {
      const v = t(k);
      if (el.textContent !== v) el.textContent = v;
    }
    const kh = el.getAttribute('data-i18n-html');
    if (kh && has(kh)) {
      const v = t(kh);
      if (el.innerHTML !== v) el.innerHTML = v;
    }
    for (const [attr, target] of ATTRS) {
      const ka = el.getAttribute(attr);
      if (ka && has(ka)) el.setAttribute(target, t(ka));
    }
  }

  function apply(root) {
    const r = root || document;
    if (r.nodeType === 1 && r.matches(SELECTOR)) translateEl(r);
    if (r.querySelectorAll) r.querySelectorAll(SELECTOR).forEach(translateEl);
  }

  // пока страница разбирается, переводим элементы по мере появления — без мигания русского текста
  let observer = null;
  if (typeof MutationObserver !== 'undefined' && document.readyState === 'loading') {
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        const parent = rec.target;
        // содержимое уже переведённого элемента дописалось позже (текст или <code>, <br>) — переводим его ещё раз
        if (parent.nodeType === 1 && (parent.hasAttribute('data-i18n') || parent.hasAttribute('data-i18n-html'))) {
          translateEl(parent);
          continue;
        }
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1) apply(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // служебные имена, которые сервер пишет по-русски (у людей логины только латиницей — не спутать)
  const SYS_NAMES = { 'Бот': 'common.sys.bot', 'Система': 'common.sys.system', 'Гость': 'common.sys.guest' };
  function sysName(name) {
    const k = SYS_NAMES[name];
    return k && has(k) ? t(k) : name;
  }

  function setLang(next) {
    if (!LANGS[next] || next === lang) return;
    const host = location.hostname;
    const domain = /(^|\.)partywatcher\.de$/i.test(host) ? '; domain=.partywatcher.de' : '';
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE + '=' + next + '; path=/; max-age=31536000; SameSite=Lax' + domain + secure;
    location.reload();
  }

  // ===== переключатель языка =====
  function flagImg(code) {
    const img = document.createElement('img');
    img.className = 'lang-flag';
    img.src = LANGS[code].flag;
    img.alt = '';
    img.width = 20;
    img.height = 14;
    return img;
  }

  function renderSwitch(host) {
    if (host.__pwLang) return;
    host.__pwLang = true;
    host.classList.add('lang-switch');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn lang-switch-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', t('common.lang.choose'));
    btn.title = t('common.lang.choose');
    btn.appendChild(flagImg(lang));
    const caret = document.createElement('span');
    caret.className = 'lang-caret';
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(caret);

    const menu = document.createElement('ul');
    menu.className = 'lang-menu hidden';
    menu.setAttribute('role', 'listbox');
    for (const code of Object.keys(LANGS)) {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-item' + (code === lang ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', code === lang ? 'true' : 'false');
      item.title = LANGS[code].name;
      item.appendChild(flagImg(code));
      const label = document.createElement('span');
      label.textContent = LANGS[code].label;
      item.appendChild(label);
      item.addEventListener('click', () => setLang(code));
      li.appendChild(item);
      menu.appendChild(li);
    }

    function close() {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      host.classList.remove('open');
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      host.classList.toggle('open', open);
    });
    document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    host.appendChild(btn);
    host.appendChild(menu);
  }

  function renderSwitches(root) {
    (root || document).querySelectorAll('[data-lang-switch]').forEach(renderSwitch);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (observer) { observer.disconnect(); observer = null; }
    apply(document);
    renderSwitches(document);
  });

  window.I18N = {
    lang,
    locale: LANGS[lang].locale,
    langs: Object.keys(LANGS),
    t,
    has,
    apply,
    setLang,
    renderSwitches,
    sysName,
  };
  window.t = t;
})();
