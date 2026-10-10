// Локализация в браузере. Подключается ПЕРВЫМ скриптом в <head> (без defer/async):
//   <script src="/js/i18n.js?v=5" data-ns="index"></script>
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

  let lang = detect();
  document.documentElement.setAttribute('lang', lang);

  // словари этой страницы — синхронно, сразу после этого скрипта (до остальных <script>)
  const me = document.currentScript;
  const ns = (me && me.getAttribute('data-ns')) || '';
  const nsList = ['common'].concat(ns.split(',').map((s) => s.trim()).filter(Boolean));
  // &h= — версия словарей из cookie pw_i18n (ставит сервер при открытии страницы): с ней словарь берётся
  // из кэша браузера без запроса к серверу, поэтому смена языка и переходы быстрые. Без cookie — свежий запрос
  function bundleUrl(l) {
    const ver = document.cookie.match(/(?:^|;\s*)pw_i18n=([0-9a-f]+)/);
    return '/locales/' + l + '.js?ns=' + encodeURIComponent(nsList.join(',')) + (ver ? '&h=' + ver[1] : '');
  }
  if (!window.PW_I18N_DATA) {
    document.write('<script src="' + bundleUrl(lang) + '"><\/script>');
  }

  const makePlural = (l) => (typeof Intl !== 'undefined' && Intl.PluralRules ? new Intl.PluralRules(l) : null);
  let pluralRules = makePlural(lang);

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

  // ===== смена языка на лету, без перезагрузки страницы =====
  // 1) словарь нового языка: из памяти или /locales/<язык>.js (кэшируется браузером по версии &h=);
  // 2) разметка с data-i18n — переводится заново по ключам;
  // 3) текст, который JS уже нарисовал через t(), узнаём по старому словарю (точное совпадение или шаблон
  //    с {подстановками}/плюралом) и меняем на тот же ключ нового языка. Пользовательский текст не трогаем:
  //    его контейнеры помечаются data-no-i18n (чат, описания обращений, новости);
  // 4) событие pw:langchange — страница перерисовывает то, что зависит от языка иначе (даты, документация, сокеты).
  const dataByLang = {};

  // тот же адрес, что и у <script> при загрузке страницы (общий кэш браузера), но читаем как данные:
  // ответ — «window.PW_I18N_DATA={...};», берём JSON между «=» и последней «;»
  const BUNDLE_PREFIX = 'window.PW_I18N_DATA=';
  function loadBundle(l) {
    if (dataByLang[l]) return Promise.resolve(dataByLang[l]);
    return fetch(bundleUrl(l), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((body) => {
        if (body.indexOf(BUNDLE_PREFIX) !== 0) throw new Error('bad bundle');
        const data = JSON.parse(body.slice(BUNDLE_PREFIX.length, body.lastIndexOf(';')));
        dataByLang[l] = data;
        return data;
      });
  }

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // обратный словарь: текст на старом языке → ключ (и шаблоны для строк с {подстановками})
  function buildReverse(data) {
    const exact = new Map();
    const tpl = [];
    for (const key of Object.keys(data)) {
      const val = data[key];
      const plural = typeof val === 'object';
      const forms = plural ? Object.values(val) : [val];
      for (const f of forms) {
        if (typeof f !== 'string' || f.length > 500 || /<[a-z!/]/i.test(f)) continue; // разметку не узнаём
        const s = f.trim();
        if (!s) continue;
        if (s.indexOf('{') !== -1) {
          const parts = s.split(/\{(\w+)\}/); // литерал, имя, литерал, имя, ...
          const names = [];
          let src = '';
          for (let i = 0; i < parts.length; i++) {
            if (i % 2) { names.push(parts[i]); src += '([\\s\\S]+?)'; } else src += escRe(parts[i]);
          }
          if (parts.filter((p, i) => i % 2 === 0).join('').trim().length < 2) continue; // «{name}» — подходит ко всему
          tpl.push({ re: new RegExp('^' + src + '$'), names, key });
        } else if (!plural && !exact.has(s)) {
          exact.set(s, key); // у одинаковых текстов берём первый ключ — переводы у них совпадают
        }
      }
    }
    return { exact, tpl };
  }

  function convert(text, rev) {
    const s = text.trim();
    if (!s || s.length > 500) return null;
    const k = rev.exact.get(s);
    if (k) return has(k) ? t(k) : null;
    for (const tp of rev.tpl) {
      const m = tp.re.exec(s);
      if (!m) continue;
      if (!has(tp.key)) return null;
      const vars = {};
      tp.names.forEach((n, i) => { vars[n] = m[i + 1]; });
      return t(tp.key, vars);
    }
    return null;
  }

  const NO_TEXT = '[data-no-i18n],script,style,textarea,code,pre,[contenteditable=""],[contenteditable="true"],[data-i18n],[data-i18n-html]';
  const LIVE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function retranslateDom(rev) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const edits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue;
      if (!v || !v.trim() || !n.parentElement || n.parentElement.closest(NO_TEXT)) continue;
      const out = convert(v, rev);
      if (out != null) edits.push([n, v.replace(v.trim(), out)]);
    }
    edits.forEach(([n, v]) => { n.nodeValue = v; });

    document.body.querySelectorAll(LIVE_ATTRS.map((a) => '[' + a + ']').join(',')).forEach((el) => {
      if (el.closest('[data-no-i18n]')) return;
      for (const a of LIVE_ATTRS) {
        if (!el.hasAttribute(a) || el.hasAttribute('data-i18n-' + a)) continue;
        const out = convert(el.getAttribute(a), rev);
        if (out != null) el.setAttribute(a, out);
      }
    });
    if (!document.querySelector('title[data-i18n]')) {
      const out = convert(document.title, rev);
      if (out != null) document.title = out;
    }
  }

  function saveCookie(l) {
    const host = location.hostname;
    const domain = /(^|\.)partywatcher\.de$/i.test(host) ? '; domain=.partywatcher.de' : '';
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE + '=' + l + '; path=/; max-age=31536000; SameSite=Lax' + domain + secure;
  }

  let switching = null;
  function setLang(next) {
    if (!LANGS[next] || next === lang) return Promise.resolve();
    saveCookie(next); // запросы к API с этого момента идут уже с новым языком
    const oldData = dict();
    dataByLang[lang] = oldData;
    const job = loadBundle(next).then((data) => {
      if (switching !== job) return; // успели выбрать другой язык
      const rev = buildReverse(oldData);
      window.PW_I18N_DATA = data;
      lang = next;
      pluralRules = makePlural(next);
      window.I18N.lang = next;
      window.I18N.locale = LANGS[next].locale;
      document.documentElement.setAttribute('lang', next);
      apply(document);
      retranslateDom(rev);
      refreshSwitches();
      window.dispatchEvent(new CustomEvent('pw:langchange', { detail: { lang: next } }));
    }).catch(() => location.reload()); // словарь не загрузился — по-старому, перезагрузкой
    switching = job;
    return job;
  }

  // другая вкладка сменила язык (общая cookie) — подтягиваемся, когда на эту вкладку вернутся
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const c = readCookie();
    if (c && c !== lang) setLang(c);
  });

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
    btn.setAttribute('data-i18n-aria-label', 'common.lang.choose');
    btn.setAttribute('data-i18n-title', 'common.lang.choose');
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
    menu.setAttribute('data-no-i18n', ''); // «RU»/«EN» — названия, не переводим
    for (const code of Object.keys(LANGS)) {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-item' + (code === lang ? ' active' : '');
      item.dataset.lang = code;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', code === lang ? 'true' : 'false');
      item.title = LANGS[code].name;
      item.appendChild(flagImg(code));
      const label = document.createElement('span');
      label.textContent = LANGS[code].label;
      item.appendChild(label);
      item.addEventListener('click', () => { close(); setLang(code); });
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

  // после смены языка: флаг на кнопке и отметка в меню
  function refreshSwitches() {
    document.querySelectorAll('.lang-switch-btn .lang-flag').forEach((img) => { img.src = LANGS[lang].flag; });
    document.querySelectorAll('.lang-item[data-lang]').forEach((item) => {
      const on = item.dataset.lang === lang;
      item.classList.toggle('active', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
    });
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
