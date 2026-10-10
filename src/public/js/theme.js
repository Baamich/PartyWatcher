(function () {
  const stored = localStorage.getItem('pw-theme') || 'dark'; // тёмная по умолчанию
  document.documentElement.setAttribute('data-theme', stored);
})();

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function applyThemeIcon() {
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.textContent = currentTheme() === 'dark' ? '🌙' : '☀️';
  });
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pw-theme', next);
  applyThemeIcon();
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ===== Окна сайта вместо alert / confirm / prompt =====
// await PW.alert('Текст', { title: 'Заголовок' });
// const ok  = await PW.confirm('Текст', { title, okText, cancelText, danger: true });   → true / false
// const val = await PW.prompt('Текст', { title, defaultValue, placeholder, inputType }); → строка или null
// PW.toast('Текст', 'success' | 'error' | 'info');   → всплывашка снизу, нажимать ничего не нужно
// Обычный alert() тоже подменён: теперь он показывает всплывашку.
(function () {
  if (window.PW && window.PW.confirm) return;
  const PW = (window.PW = window.PW || {});

  // в полноэкранном режиме браузер показывает только содержимое fullscreen-элемента:
  // окна и всплывашки добавляем внутрь него
  const host = () => document.fullscreenElement || document.webkitFullscreenElement || document.body;

  let overlay = null;
  let toastBox = null;
  let busy = false;
  const queue = [];

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'modal pw-dialog-overlay hidden';
    overlay.innerHTML =
      '<div class="modal-content pw-dialog" role="dialog" aria-modal="true">' +
      '<h3 class="pw-dialog-title"></h3>' +
      '<p class="pw-dialog-text"></p>' +
      '<input class="pw-dialog-input hidden" type="text" autocomplete="off" />' +
      '<div class="pw-dialog-actions">' +
      '<button type="button" class="icon-btn pw-dialog-cancel"></button>' +
      '<button type="button" class="pw-dialog-ok"></button>' +
      '</div></div>';
  }

  function attach() {
    if (!overlay) buildOverlay();
    const h = host();
    if (overlay.parentNode !== h) h.appendChild(overlay);
  }

  function reattach() {
    if (overlay && !overlay.classList.contains('hidden')) attach();
    if (toastBox && toastBox.children.length) {
      const h = host();
      if (toastBox.parentNode !== h) h.appendChild(toastBox);
    }
  }
  document.addEventListener('fullscreenchange', reattach);
  document.addEventListener('webkitfullscreenchange', reattach);

  function run(opts, resolve) {
    attach();
    const titleEl = overlay.querySelector('.pw-dialog-title');
    const textEl = overlay.querySelector('.pw-dialog-text');
    const input = overlay.querySelector('.pw-dialog-input');
    const okBtn = overlay.querySelector('.pw-dialog-ok');
    const cancelBtn = overlay.querySelector('.pw-dialog-cancel');
    const isPrompt = opts.kind === 'prompt';

    titleEl.textContent = opts.title || '';
    titleEl.classList.toggle('hidden', !opts.title);
    textEl.textContent = String(opts.message ?? '');
    textEl.classList.toggle('hidden', !opts.message);

    input.classList.toggle('hidden', !isPrompt);
    input.type = opts.inputType || 'text';
    input.value = isPrompt ? String(opts.defaultValue ?? '') : '';
    input.placeholder = opts.placeholder || '';

    okBtn.textContent = opts.okText || t('common.dialog.ok');
    okBtn.classList.toggle('pw-danger', !!opts.danger);
    cancelBtn.textContent = opts.cancelText || t('common.dialog.cancel');
    cancelBtn.classList.toggle('hidden', opts.kind === 'alert');

    overlay.classList.remove('hidden');
    const previouslyFocused = document.activeElement;

    const cancelValue = opts.kind === 'confirm' ? false : isPrompt ? null : undefined;
    const okValue = () => (opts.kind === 'confirm' ? true : isPrompt ? input.value : undefined);

    function finish(value) {
      overlay.classList.add('hidden');
      okBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {}
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(cancelValue);
      } else if (e.key === 'Enter' && (isPrompt ? e.target === input : e.target !== cancelBtn)) {
        e.preventDefault();
        e.stopPropagation();
        finish(okValue());
      }
    }

    document.addEventListener('keydown', onKey, true);
    okBtn.onclick = () => finish(okValue());
    cancelBtn.onclick = () => finish(cancelValue);
    overlay.onclick = (e) => { if (e.target === overlay) finish(cancelValue); };

    setTimeout(() => {
      if (isPrompt) { input.focus(); input.select(); }
      else (opts.danger && opts.kind === 'confirm' ? cancelBtn : okBtn).focus(); // у опасного действия фокус на «Отмена»
    }, 30);
  }

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const { opts, resolve } = queue.shift();
    run(opts, (value) => {
      busy = false;
      resolve(value);
      pump();
    });
  }

  function enqueue(opts) {
    return new Promise((resolve) => {
      queue.push({ opts, resolve });
      pump();
    });
  }

  PW.alert = (message, o) => enqueue({ kind: 'alert', message, ...(o || {}) });
  PW.confirm = (message, o) => enqueue({ kind: 'confirm', message, ...(o || {}) });
  PW.prompt = (message, o) => enqueue({ kind: 'prompt', message, ...(o || {}) });

  function toast(message, type, ms) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'pw-toasts';
    }
    const h = host();
    if (toastBox.parentNode !== h) h.appendChild(toastBox);
    while (toastBox.children.length >= 4) toastBox.firstChild.remove();

    const el = document.createElement('div');
    el.className = 'pw-toast pw-toast--' + (type || 'info');
    el.setAttribute('role', 'status');
    el.textContent = String(message ?? '');
    toastBox.appendChild(el);

    let gone = false;
    const remove = () => {
      if (gone) return;
      gone = true;
      el.classList.add('pw-toast--out');
      setTimeout(() => el.remove(), 250);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, ms || 3500);
  }
  PW.toast = toast;

  // обычный alert() → всплывашка (цвет подбираем по тексту, русскому или английскому)
  const ERR_RE = /не удалось|ошибк|нельзя|не найден|не может|заблокирован|кикнули|отключился|заполнен|не поддерж|слишком|could not|couldn't|failed|error|cannot|can't|not found|blocked|kicked|disconnected|not supported|too (many|long|large|big)/i;
  const OK_RE = /скопирован|сохранён|сохранен|готово|отправлен|успешно|copied|saved|done|sent|success/i;
  window.alert = function (msg) {
    const text = String(msg ?? '');
    toast(text, OK_RE.test(text) ? 'success' : ERR_RE.test(text) ? 'error' : 'info', 4500);
  };
})();

document.addEventListener('DOMContentLoaded', applyThemeIcon);