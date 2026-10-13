// Значки модераторов в чатах эфира (страница стримера, студия, оверлей OBS):
// модератор — топор, высший модератор — щит с топором. Квадратик с цветом, как на Twitch
(function () {
  if (window.PWBadges) return;

  const AXE = '<path d="M4 13.5 10.2 7.3" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>'
    + '<path d="M8.6 2.6c2.4-.9 5 .5 5.4 2.9L10.2 7.4 8 5.2Z" fill="#fff"/>';
  const SHIELD_AXE = '<path d="M8 1.3 13.6 3.2V7.6c0 3.3-2.5 5.8-5.6 7-3.1-1.2-5.6-3.7-5.6-7V3.2Z" fill="none" stroke="#fff" stroke-width="1.3"/>'
    + '<path d="M5.6 11.2 9.3 7.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'
    + '<path d="M8.4 4.5c1.5-.5 3 .3 3.2 1.7L9.4 7.5 8.1 6.2Z" fill="#fff"/>';

  const LOOK = {
    mod: { bg: '#16a34a', svg: AXE, key: 'common.modBadge.mod' },
    senior: { bg: '#d97706', svg: SHIELD_AXE, key: 'common.modBadge.senior' },
  };

  // level: 'mod' | 'senior' | null → html значка (или '')
  function html(level) {
    const l = LOOK[level];
    if (!l) return '';
    const title = window.t ? window.t(l.key) : '';
    return `<span class="pw-badge" title="${title}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:3px;background:${l.bg};vertical-align:-3px;margin-right:4px;flex-shrink:0">`
      + `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${l.svg}</svg></span>`;
  }

  // ранг для проверки «кого можно наказать»: стример > высший > модератор > зритель
  function rank(msgOrRole) {
    if (typeof msgOrRole === 'string') return { owner: 3, senior: 2, mod: 1 }[msgOrRole] || 0;
    if (!msgOrRole) return 0;
    if (msgOrRole.isOwner) return 3;
    return { senior: 2, mod: 1 }[msgOrRole.modLevel] || 0;
  }

  window.PWBadges = { html, rank };
})();
