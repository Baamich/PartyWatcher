// страница клипа /clips/<id>: видео, название, канал, автор; автору клипа и стримеру — переименовать и удалить
const clipId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
let clip = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const catName = (c) => (I18N.lang === 'ru' && c?.ru) || c?.name || '';

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function render() {
  if (!clip) return;
  const title = clip.title || t('clips.untitled');
  document.getElementById('clipTitle').textContent = title;
  document.title = title + ' — Party Watcher';

  const st = document.getElementById('clipStreamer');
  st.href = '/streamers/' + encodeURIComponent(clip.streamerNameLower);
  st.innerHTML = `${clip.streamerAvatar ? `<img src="${esc(clip.streamerAvatar)}" alt="" />` : `<span class="clip-av-fallback">${esc(clip.streamerName.charAt(0).toUpperCase())}</span>`}<b>${esc(clip.streamerName)}</b>`;

  const parts = [
    t('clips.by', { name: clip.creatorName }),
    new Date(clip.createdAt).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }),
    t('clips.views', { n: clip.views }),
    fmtDur(clip.durationSec),
  ];
  if (clip.category) parts.push('🎮 ' + catName(clip.category));
  document.getElementById('clipInfo').textContent = parts.join(' · ');

  document.getElementById('clipRenameBtn').classList.toggle('hidden', !clip.canManage);
  document.getElementById('clipDeleteBtn').classList.toggle('hidden', !clip.canManage);
}

async function load() {
  try {
    clip = await api('/clips/' + encodeURIComponent(clipId));
  } catch (_) {
    document.getElementById('clipNotFound').classList.remove('hidden');
    return;
  }
  const v = document.getElementById('clipVideo');
  v.src = clip.url;
  if (clip.thumb) v.poster = clip.thumb;
  document.getElementById('clipBox').classList.remove('hidden');
  render();
}

document.getElementById('clipCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href.split('#')[0]);
    PW.toast(t('clips.copied'), 'success');
  } catch (_) {
    PW.toast(location.href, 'info');
  }
});

document.getElementById('clipRenameBtn').addEventListener('click', async () => {
  const v = await PW.prompt(t('clips.renameText'), { defaultValue: clip.title || '', title: t('clips.rename') });
  if (v === null || v === undefined) return;
  try {
    const r = await api('/clips/' + encodeURIComponent(clipId), { method: 'PATCH', body: { title: v } });
    clip.title = r.title;
    render();
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});

document.getElementById('clipDeleteBtn').addEventListener('click', async () => {
  const ok = await PW.confirm(t('clips.deleteConfirm'), { danger: true, okText: t('clips.delete') });
  if (!ok) return;
  try {
    await api('/clips/' + encodeURIComponent(clipId), { method: 'DELETE' });
    location.href = '/streamers/' + encodeURIComponent(clip.streamerNameLower);
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});

window.addEventListener('pw:langchange', render);
load();
