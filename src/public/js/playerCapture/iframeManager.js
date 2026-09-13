export function createIframePlayer(url, container) {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.referrerPolicy = 'no-referrer';

  // Некоторые сайты требуют sandbox
  // iframe.sandbox = 'allow-scripts allow-same-origin allow-presentation allow-forms';

  container.appendChild(iframe);
  return iframe;
}