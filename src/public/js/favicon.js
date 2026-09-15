(function () {
  const ICONS = {
    dark: '/img/favicon-dark.svg',
    light: '/img/favicon-light.svg',
  };

  function getLink() {
    let link = document.getElementById('favicon') || document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.id = 'favicon';
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    return link;
  }

  function currentTheme() {
    // тема может лежать и на <html>, и на <body>, и в localStorage
    return (
      document.documentElement.getAttribute('data-theme') ||
      document.body?.getAttribute('data-theme') ||
      localStorage.getItem('theme') ||
      'dark'
    );
  }

  function applyFavicon() {
    const theme = currentTheme() === 'light' ? 'light' : 'dark';
    const href = ICONS[theme];
    const link = getLink();
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  window.applyFavicon = applyFavicon; // на случай ручного вызова из theme.js

  applyFavicon();

  const observer = new MutationObserver(applyFavicon);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  document.addEventListener('DOMContentLoaded', () => {
    applyFavicon();
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    }
  });
})();