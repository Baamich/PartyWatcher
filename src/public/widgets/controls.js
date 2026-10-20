// Кнопки управления виджетом (старт/пауза таймера, +/− счётчика, текст надписи, запуск титров):
// карточки в студии (⏱️ Виджеты) и мини-пульт стримера. Действие уходит на сервер, новое состояние
// приходит обратно сокетом — refresh(widget) обновляет подписи, не трогая поле, в котором сейчас печатают
(function () {
  if (window.PWWidgetControls) return;
  const C = window.PWWidgetCatalog;

  function btn(label, title, onClick, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn pwwc-btn ' + cls;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  const row = (...kids) => {
    const r = document.createElement('div');
    r.className = 'pwwc-row';
    r.append(...kids);
    return r;
  };

  // act(action, arg) → Promise; ошибки показывает сам (PW.toast)
  function build(box, widget, { act, compact = false } = {}) {
    let w = widget;
    const run = (action, arg) => act(action, arg).catch((e) => window.PW?.toast(e.message || t('common.requestFailed'), 'error'));
    const parts = {};
    clearInterval(box.__pwwcTimer); // кнопки пересобирают в том же контейнере — прежний таймер не нужен
    box.replaceChildren();
    box.classList.add('pwwc');
    box.setAttribute('data-no-i18n', '');

    switch (w.type) {
      case 'countdown': {
        parts.toggle = btn('', '', () => run('toggle'), 'pwwc-main');
        box.appendChild(row(
          parts.toggle,
          btn('↺', t('widgets.ctl.reset'), () => run('reset')),
          btn('−1m', t('widgets.ctl.minus1m'), () => run('add', -60)),
          btn('+1m', t('widgets.ctl.plus1m'), () => run('add', 60)),
        ));
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pwwc-input';
        input.placeholder = t('widgets.ctl.timePh');
        input.maxLength = 10;
        const go = () => {
          const v = input.value.trim();
          const sec = /^\d{1,4}$/.test(v) ? Number(v) * 60 : C.parseSpan(v);
          if (!sec) return window.PW?.toast(t('widgets.ctl.badTime'), 'error');
          run('start', sec);
          input.value = '';
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        if (!compact) box.appendChild(row(input, btn('▶', t('widgets.ctl.startFor'), go)));
        break;
      }
      case 'stopwatch':
        parts.toggle = btn('', '', () => run('toggle'), 'pwwc-main');
        box.appendChild(row(parts.toggle, btn('↺', t('widgets.ctl.reset'), () => run('reset'))));
        break;
      case 'counter':
      case 'goal': {
        if (w.type === 'goal' && w.opts.source !== 'manual') {
          parts.info = document.createElement('div');
          parts.info.className = 'pwwc-info';
          box.appendChild(parts.info);
          break;
        }
        parts.value = document.createElement('b');
        parts.value.className = 'pwwc-value';
        parts.value.title = t('widgets.ctl.setValue');
        parts.value.addEventListener('click', async () => {
          const v = await window.PW?.prompt(t('widgets.ctl.setValue'), { defaultValue: String(w.state.n), inputType: 'number' });
          if (v === null || v === undefined) return;
          const n = Number(String(v).trim());
          if (!Number.isFinite(n)) return window.PW?.toast(t('widgets.ctl.badNumber'), 'error');
          run('set', Math.round(n));
        });
        const step = w.opts.step || 1;
        box.appendChild(row(
          btn('−' + (step > 1 ? step : ''), '', () => run('add', -(w.opts.step || 1))),
          parts.value,
          btn('+' + (step > 1 ? step : ''), '', () => run('add', w.opts.step || 1), 'pwwc-main'),
          btn('↺', t('widgets.ctl.reset'), () => run('reset')),
        ));
        break;
      }
      case 'text':
      case 'ticker': {
        const ta = document.createElement('textarea');
        ta.className = 'pwwc-text';
        ta.rows = w.type === 'ticker' ? 3 : 2;
        ta.maxLength = w.type === 'ticker' ? C.LIMITS.ticker : C.LIMITS.text;
        ta.placeholder = t(w.type === 'ticker' ? 'widgets.ctl.tickerPh' : 'widgets.ctl.textPh');
        ta.value = w.state.text || '';
        parts.ta = ta;
        box.appendChild(ta);
        box.appendChild(row(
          btn(t('widgets.ctl.show'), '', () => run('set', ta.value), 'pwwc-main'),
          btn(t('widgets.ctl.clear'), '', () => { ta.value = ''; run('set', ''); }),
        ));
        break;
      }
      case 'credits':
        box.appendChild(row(
          btn(t('widgets.ctl.creditsRun'), '', () => run('run'), 'pwwc-main'),
          btn(t('widgets.ctl.creditsStop'), '', () => run('stop')),
        ));
        break;
      case 'last':
        box.appendChild(row(btn(t('widgets.ctl.clearList'), '', () => run('clear'))));
        break;
      // свой виджет: кнопки только для того, что есть в его строках ({n}, {text}, случайность)
      case 'custom': {
        const all = (w.opts.lines || []).map((l) => l.text).join(' ') + ' ' + (w.opts.barValue || '') + ' ' + (w.opts.barMax || '');
        if (/\{n\}/.test(all)) {
          parts.value = document.createElement('b');
          parts.value.className = 'pwwc-value';
          parts.value.title = t('widgets.ctl.setValue');
          parts.value.addEventListener('click', async () => {
            const v = await window.PW?.prompt(t('widgets.ctl.setValue'), { defaultValue: String(w.state.n), inputType: 'number' });
            if (v === null || v === undefined) return;
            const n = Number(String(v).trim());
            if (!Number.isFinite(n)) return window.PW?.toast(t('widgets.ctl.badNumber'), 'error');
            run('set', Math.round(n));
          });
          box.appendChild(row(btn('−', '', () => run('add', -1)), parts.value, btn('+', '', () => run('add', 1), 'pwwc-main'), btn('↺', t('widgets.ctl.reset'), () => run('reset'))));
        }
        if (/\{text\}/.test(all)) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'pwwc-input';
          input.maxLength = C.LIMITS.text;
          input.placeholder = t('widgets.ctl.textPh');
          input.value = w.state.text || '';
          parts.ta = input;
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run('text', input.value); });
          box.appendChild(row(input, btn(t('widgets.ctl.show'), '', () => run('text', input.value), 'pwwc-main')));
        }
        if (/\{(random|choice|dice|coin)\b/.test(all)) box.appendChild(row(btn('🎲 ' + t('widgets.ctl.roll'), '', () => run('roll'), 'pwwc-main')));
        if (!box.children.length) {
          parts.info = document.createElement('div');
          parts.info.className = 'pwwc-info';
          box.appendChild(parts.info);
        }
        break;
      }
      default: {
        parts.info = document.createElement('div');
        parts.info.className = 'pwwc-info';
        box.appendChild(parts.info);
      }
    }

    function refresh(next) {
      w = next || w;
      const s = w.state;
      if (parts.toggle) {
        const running = w.type === 'countdown' ? s.run && C.countdownLeft(s, window.PWWidgetRender?.serverNow() || Date.now()) > 0 : s.run;
        parts.toggle.textContent = running ? '⏸ ' + t('widgets.ctl.pause') : '▶ ' + t('widgets.ctl.start');
      }
      if (parts.value) parts.value.textContent = Number(s.n || 0).toLocaleString(window.I18N?.locale);
      if (parts.ta && document.activeElement !== parts.ta) parts.ta.value = s.text || '';
      if (parts.info) {
        parts.info.textContent = w.type === 'goal' ? t('widgets.ctl.goalAuto', { source: t('widgets.opt.sourceOpt.' + w.opts.source) }) : t('widgets.ctl.auto.' + w.type);
      }
    }
    refresh(w);
    // отсчёт дошёл до нуля сам — кнопка должна стать «Старт»
    if (w.type === 'countdown') {
      const timer = setInterval(() => { if (!box.isConnected) clearInterval(timer); else refresh(); }, 1000);
      box.__pwwcTimer = timer;
    }
    return { refresh };
  }

  // команда чата для виджета: «/timer» или «/timer имя», если виджетов этого типа несколько
  function commandOf(w, all) {
    const cmd = C.typeById(w.type)?.cmd;
    if (!cmd) return '';
    const many = w.type === 'custom' || (all || []).filter((x) => x.type === w.type).length > 1; // /w — всегда с именем
    return '/' + cmd + (many ? ' ' + w.slug : '');
  }

  window.PWWidgetControls = { build, commandOf };
})();
