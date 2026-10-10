async function api(path, options = {}) {
  const opts = { ...options };

  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (window.t ? t('common.requestFailed') : 'Request failed'));
    err.status = res.status; // текст ошибки переведён, поэтому проверяем код, а не слова
    throw err;
  }
  return data;
  
}