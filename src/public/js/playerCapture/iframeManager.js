// iframeManager.js

export function createIframePlayer(url, container) {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  // убираем allowFullscreen, чтобы не было конфликта
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.referrerPolicy = 'no-referrer';

  // Обработка ошибки загрузки (X-Frame-Options)
  iframe.addEventListener('load', () => {
    // Если сайт заблокировал — iframe будет пустым
  });

  container.appendChild(iframe);

  // Показываем понятное сообщение, если сайт блокирует iframe
  setTimeout(() => {
    try {
      // Если не получилось загрузить — показываем заглушку
      if (!iframe.contentWindow) {
        showIframeBlockedMessage(container, url);
      }
    } catch (e) {
      showIframeBlockedMessage(container, url);
    }
  }, 2500);

  return iframe;
}

function showIframeBlockedMessage(container, url) {
  container.innerHTML = `
    <div style="
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      height:100%;
      color:#fff;
      text-align:center;
      padding:20px;
      background:#111;
    ">
      <div style="font-size:48px; margin-bottom:16px;">🚫</div>
      <h3 style="margin:0 0 8px;">Сайт запретил встраивание</h3>
      <p style="opacity:0.7; margin:0 0 20px; max-width:400px;">
        ${url}<br><br>
        Этот сайт установил X-Frame-Options и не позволяет открыть себя внутри другого сайта.
      </p>
      <a href="${url}" target="_blank" style="
        padding:12px 24px;
        background:#7c3aed;
        color:#fff;
        border-radius:8px;
        text-decoration:none;
      ">Открыть в новой вкладке</a>
    </div>
  `;
}