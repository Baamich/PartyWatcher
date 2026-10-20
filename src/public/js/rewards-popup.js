// Окно наград за стрим-поинты — общее для страницы канала (зритель) и студии (стример проверяет награды).
// Сетка по 3 в ряд (виден ряд и чуть меньше половины следующего — дальше прокрутка), клик по награде —
// описание, поле текста (если нужно) и «Купить за N». У владельца канала поинты бесконечные: «∞» и «Проверить».
//   const pop = PWRewardsPopup.create(box, { state, label, redeem, beforeBuy });
//   state()  → { rewards, balance, owner }       label() → название поинтов
//   redeem(reward, message) → Promise (ответ сервера; бросает ошибку с message)
//   beforeBuy() → false, если покупать нельзя (гость — окно входа)
//   pop.render() — перерисовать, pop.reset() — вернуться к списку
(function () {
  if (window.PWRewardsPopup) return;

  const tr = (k, v) => window.t('common.points.' + k, v);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => new Intl.NumberFormat(window.I18N?.locale, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n || 0);

  function injectCss() {
    if (document.getElementById('pw-rp-css')) return;
    const st = document.createElement('style');
    st.id = 'pw-rp-css';
    st.textContent = `
      .lp-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 10px; font-size: 13px; }
      .lp-name { color: var(--text-muted); font-weight: 700; }
      .lp-bal { font-size: 16px; }
      .lp-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: 96px; gap: 8px; max-height: 142px; overflow-y: auto; padding-right: 2px; }
      [data-theme] .lp-reward { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-width: 0; width: auto; margin: 0; padding: 8px 4px;
        background: var(--surface-alt); box-shadow: none; border: 0; border-radius: var(--radius-sm); color: var(--text); font-size: 11px; font-weight: 600; }
      [data-theme] .lp-reward:hover { filter: brightness(1.12); transform: none; }
      .lp-reward.poor { opacity: .55; }
      .lp-tile { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 900; font-size: 22px; overflow: hidden; text-shadow: 0 1px 2px rgba(0,0,0,.4); }
      .lp-tile img { width: 100%; height: 100%; object-fit: cover; }
      .lp-title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lp-cost { color: #f59e0b; font-weight: 800; }
      .lp-empty { grid-column: 1 / -1; margin: 0; font-size: 13px; color: var(--text-muted); }
      [data-theme] .lp-back { width: auto; margin: 0; padding: 2px 8px 2px 4px; background: none; box-shadow: none; border: 0; color: var(--text-muted); font-size: 13px; font-weight: 700; }
      [data-theme] .lp-back:hover { color: var(--text); transform: none; }
      .lp-detail { display: flex; align-items: center; gap: 12px; }
      .lp-detail .lp-tile { width: 56px; height: 56px; font-size: 28px; flex-shrink: 0; }
      .lp-d-main { min-width: 0; }
      .lp-d-title { font-weight: 800; font-size: 15px; overflow-wrap: anywhere; }
      .lp-desc { margin: 10px 0; font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
      .lp-desc.muted { color: var(--text-muted); font-style: italic; }
      .lp-input { width: 100%; box-sizing: border-box; margin: 0 0 10px; resize: vertical; font-size: 14px; font-family: inherit; }
      .lp-buy { width: 100%; margin: 0; }
      .lp-buy:disabled { opacity: .45; filter: grayscale(.5); cursor: not-allowed; box-shadow: none; }
      .lp-short { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); text-align: center; }
      .lp-short:empty { display: none; }
      .lp-limits { margin: -4px 0 10px; font-size: 12px; color: var(--text-muted); }
      .lp-limits:empty { display: none; }`;
    document.head.appendChild(st);
  }

  const tileHtml = (r) => `<span class="lp-tile" style="background:${esc(r.color)}">${r.image ? `<img src="${esc(r.image)}" alt="" />` : esc(String(r.title || '?').trim().charAt(0).toUpperCase())}</span>`;

  function create(box, o) {
    injectCss();
    let selected = null; // id открытой награды
    const st = () => o.state() || { rewards: [], balance: 0, owner: false };
    const balText = (s) => (s.owner ? '∞' : fmt(s.balance));

    function renderList(s) {
      box.innerHTML = `<div class="lp-head"><span class="lp-name"></span><b class="lp-bal"></b></div><div class="lp-grid"></div>`;
      box.querySelector('.lp-name').textContent = o.label();
      box.querySelector('.lp-bal').textContent = balText(s);
      const grid = box.querySelector('.lp-grid');
      if (!s.rewards.length) {
        const p = document.createElement('p');
        p.className = 'lp-empty';
        p.textContent = tr('noRewards');
        grid.appendChild(p);
      }
      for (const r of s.rewards) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lp-reward' + (!s.owner && s.balance < r.cost ? ' poor' : '');
        b.title = r.description || r.title;
        b.innerHTML = `${tileHtml(r)}<span class="lp-title">${esc(r.title)}</span><span class="lp-cost">${fmt(r.cost)}</span>`;
        b.addEventListener('click', () => { selected = r.id; render(); });
        grid.appendChild(b);
      }
    }

    function renderDetail(r, s) {
      const short = s.owner ? 0 : Math.max(0, r.cost - (s.balance || 0));
      box.innerHTML = `<div class="lp-head"><button type="button" class="lp-back">← <span></span></button><b class="lp-bal"></b></div>
        <div class="lp-detail">${tileHtml(r)}<div class="lp-d-main"><div class="lp-d-title"></div><div class="lp-cost"></div></div></div>
        <p class="lp-desc"></p>
        <p class="lp-limits"></p>
        ${r.needInput ? '<textarea class="lp-input" rows="2" maxlength="200"></textarea>' : ''}
        <button type="button" class="lp-buy"></button>
        <p class="lp-short"></p>`;
      box.querySelector('.lp-back span').textContent = tr('back');
      box.querySelector('.lp-bal').textContent = balText(s);
      box.querySelector('.lp-d-title').textContent = r.title;
      box.querySelector('.lp-detail .lp-cost').textContent = fmt(r.cost) + ' ' + o.label();
      const desc = box.querySelector('.lp-desc');
      desc.textContent = r.description || tr('noDesc');
      desc.classList.toggle('muted', !r.description);
      // ограничения награды: «только в эфире · раз в 5 мин · 3 за эфир на зрителя»
      const lim = [];
      if (r.onlyLive) lim.push(tr('limOnlyLive'));
      if (r.cooldownSec) lim.push(tr('limCooldown', { time: r.cooldownSec < 60 ? tr('limSec', { n: r.cooldownSec }) : tr('limMin', { n: Math.round(r.cooldownSec / 60) }) }));
      if (r.perStream) lim.push(tr('limPerStream', { n: r.perStream }));
      if (r.perUserStream) lim.push(tr('limPerUser', { n: r.perUserStream }));
      box.querySelector('.lp-limits').textContent = lim.length ? '⏳ ' + lim.join(' · ') : '';
      const input = box.querySelector('.lp-input');
      if (input) input.placeholder = tr('inputPh');
      const buy = box.querySelector('.lp-buy');
      buy.textContent = s.owner ? tr('testFor') : tr('buyFor', { cost: fmt(r.cost) });
      buy.disabled = short > 0;
      box.querySelector('.lp-short').textContent = s.owner ? tr('testHint') : short > 0 ? tr('notEnough', { n: fmt(short) }) : '';
      box.querySelector('.lp-back').addEventListener('click', () => { selected = null; render(); });
      buy.addEventListener('click', () => buyReward(r, input, buy));
      (input || buy).focus();
    }

    async function buyReward(r, input, btn) {
      if (o.beforeBuy && o.beforeBuy() === false) return;
      const s = st();
      if (!s.owner && (s.balance || 0) < r.cost) return PW.toast(tr('notEnough', { n: fmt(r.cost - (s.balance || 0)) }), 'info');
      const message = input ? input.value.trim() : '';
      if (r.needInput && !message) {
        input.focus();
        return PW.toast(tr('needText'), 'info');
      }
      btn.disabled = true; // двойной клик не купит дважды
      try {
        await o.redeem(r, message);
        selected = null;
        render();
        PW.toast(tr(s.owner ? 'tested' : 'bought', { title: r.title }), 'success');
      } catch (err) {
        btn.disabled = false;
        PW.toast(err.message, 'error');
      }
    }

    function render() {
      const s = st();
      const sel = selected && s.rewards.find((r) => r.id === selected);
      if (sel) return renderDetail(sel, s);
      selected = null;
      renderList(s);
    }

    return { render, reset() { selected = null; } };
  }

  window.PWRewardsPopup = { create, fmt };
})();
