// id устройства для статистики и банов админки: cookie pw_dev = '1.<did>.<hw>' (сервер: services/clientInfo.js).
//  did — случайный id этого браузера (живёт в localStorage и cookie);
//  hw  — отпечаток железа: видеокарта, ядра, память, экран, часовой пояс, платформа. Он одинаковый в разных
//        браузерах одного компьютера, но может совпасть у одинаковых телефонов одной модели.
// Грузит api.js в простое, только если cookie ещё нет: WebGL-контекст создаётся один раз на устройство
(function () {
  const VER = '1';
  const isHex16 = (s) => /^[0-9a-f]{16}$/.test(s || '');

  // FNV-1a 64 бита (две половины по 32) → 16 hex
  function hash(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  function gpu() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return v + '|' + r + '|' + max;
    } catch (_) {
      return '';
    }
  }

  function hardware() {
    const s = window.screen || {};
    const parts = [
      gpu(),
      navigator.hardwareConcurrency || 0,
      navigator.deviceMemory || 0,
      Math.max(s.width || 0, s.height || 0) + 'x' + Math.min(s.width || 0, s.height || 0) + 'x' + (s.colorDepth || 0),
      window.devicePixelRatio || 1,
      navigator.maxTouchPoints || 0,
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
      (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } })(),
    ];
    return hash(parts.join('#'));
  }

  function randomId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function read(k) {
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, v); } catch (_) {}
  }

  const fromCookie = (document.cookie.match(/(?:^|;\s*)pw_dev=1\.([0-9a-f]{16})\.([0-9a-f]{16})/) || []);
  let did = read('pw-did');
  if (!isHex16(did)) did = isHex16(fromCookie[1]) ? fromCookie[1] : randomId();
  write('pw-did', did);

  let hw = read('pw-hw');
  if (!isHex16(hw) || read('pw-hw-v') !== VER) {
    hw = hardware();
    write('pw-hw', hw);
    write('pw-hw-v', VER);
  }

  const host = location.hostname;
  const domain = /(^|\.)partywatcher\.de$/i.test(host) ? '; domain=.partywatcher.de' : '';
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = 'pw_dev=' + VER + '.' + did + '.' + hw + '; path=/; max-age=63072000; SameSite=Lax' + domain + secure;
})();
