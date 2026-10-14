function getNameFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || '').toLowerCase();
}

function initialLetter(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

let currentStreamer = null;
let cachedVods = [];
let liveOpen = false;
let liveHls = null;
let liveSocket = null;
let liveChatReconnect = null;
let livePlayerReconnect = null;
let liveIsAuthed = false;
let isOwnerFlag = false;

// ---------- профиль ----------

function renderProfile(streamer) {
  const banner = document.getElementById('banner');
  banner.style.backgroundImage = streamer.streamerBannerUrl ? `url('${streamer.streamerBannerUrl}')` : '';

  const avatar = document.getElementById('profileAvatar');
  avatar.style.backgroundImage = streamer.streamerAvatarUrl ? `url('${streamer.streamerAvatarUrl}')` : '';
  avatar.textContent = streamer.streamerAvatarUrl ? '' : initialLetter(streamer.streamerName);

  document.getElementById('liveBadge').classList.toggle('hidden', !streamer.isLive);
  document.getElementById('profileName').textContent = streamer.streamerName;

  const bio = (streamer.streamerBio || '').trim();
  const bioShortEl = document.getElementById('profileBioShort');
  const expandBtn = document.getElementById('bioExpandBtn');

  if (!bio) {
    bioShortEl.textContent = t('streamer.noBio');
    expandBtn.classList.add('hidden');
  } else {
    bioShortEl.textContent = bio;
    expandBtn.classList.toggle('hidden', bio.length <= 120);
  }

  document.getElementById('bioModalName').textContent = streamer.streamerName;
  document.getElementById('bioModalText').textContent = bio || t('streamer.noBio');
}

function openBioModal() { document.getElementById('bioModal').classList.remove('hidden'); }
function closeBioModal() { document.getElementById('bioModal').classList.add('hidden'); }
document.getElementById('bioModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'bioModal') closeBioModal();
});

async function checkOwnership(nameLower) {
  try {
    const me = await api('/auth/me');
    liveIsAuthed = true;
    if (me.streamerName && me.streamerName.toLowerCase() === nameLower) {
      isOwnerFlag = true;
      document.getElementById('ownerControls').classList.remove('hidden');
    }
  } catch {
    liveIsAuthed = false;
  }
}

// ---------- название и категория идущего эфира ----------
// над плеером (при наведении) и строкой под именем в профиле. Категория ведёт на её страницу в «Трансляциях»

const liveCatName = (c) => (I18N.lang === 'ru' && c?.ru) || c?.name || '';

// p — префикс классов: 'live-info' (над плеером) или 'profile-live' (под именем)
function liveInfoHtml(s, p) {
  const esc = liveEscapeHtml;
  const parts = [`<span class="${p}-live">${esc(t('common.liveBadge'))}</span>`];
  if (s.title) parts.push(`<span class="${p}-title" title="${esc(s.title)}">${esc(s.title)}</span>`);
  if (s.category) {
    const name = liveCatName(s.category);
    parts.push(`<a class="${p}-cat" href="/streams.html?cat=${encodeURIComponent(s.category.slug)}" title="${esc(name)}">🎮 ${esc(name)}</a>`);
  }
  return parts.join('');
}

function renderLiveInfo() {
  const s = currentStreamer || {};
  document.querySelectorAll('.live-clip-btn').forEach((b) => b.classList.toggle('hidden', !s.isLive));
  const on = !!s.isLive && !!(s.title || s.category);
  const bar = document.getElementById('liveInfoBar');
  const line = document.getElementById('profileLiveLine');
  if (bar) {
    bar.classList.toggle('hidden', !on);
    if (on) bar.innerHTML = liveInfoHtml(s, 'live-info');
  }
  if (line) {
    line.classList.toggle('hidden', !on);
    if (on) line.innerHTML = liveInfoHtml(s, 'profile-live');
  }
}
window.addEventListener('pw:langchange', renderLiveInfo); // русское/английское название категории

let liveInfoPeekTimer = null;
function peekLiveInfo() {
  const bar = document.getElementById('liveInfoBar');
  if (!bar) return;
  bar.classList.add('peek');
  clearTimeout(liveInfoPeekTimer);
  liveInfoPeekTimer = setTimeout(() => bar.classList.remove('peek'), 6000);
}

// ---------- клипы: «✂ Клип» под чатом и вкладка «Клипы» в профиле ----------

let cachedClips = [];
let vodTab = 'vods';
let clipBusy = false;
const hasMedia = () => cachedVods.length > 0 || cachedClips.length > 0;

function fmtClipDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function renderClipGrid() {
  const grid = document.getElementById('clipGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const c of cachedClips) {
    const a = document.createElement('a');
    a.className = 'vod-card clip-card';
    a.href = '/clips/' + encodeURIComponent(c.id);
    const meta = [t('streamer.clips.views', { n: c.views || 0 }), c.creatorName, vodDate(c.createdAt)];
    if (c.category) meta.push('🎮 ' + liveCatName(c.category));
    a.innerHTML = `
      <div class="clip-thumb">${c.thumb ? `<img src="${liveEscapeHtml(c.thumb)}" loading="lazy" alt="" />` : ''}<span class="clip-dur">${fmtClipDur(c.durationSec)}</span></div>
      <div class="vod-card-body">
        <div class="vod-card-title">${liveEscapeHtml(c.title || t('streamer.clips.untitled'))}</div>
        <div class="vod-card-meta">${liveEscapeHtml(meta.join(' · '))}</div>
      </div>`;
    grid.appendChild(a);
  }
}

// вкладки «Записи / Клипы»: показываем только те, где что-то есть
function renderMediaTabs() {
  const hv = cachedVods.length > 0, hc = cachedClips.length > 0;
  if (vodTab === 'vods' && !hv && hc) vodTab = 'clips';
  if (vodTab === 'clips' && !hc && hv) vodTab = 'vods';
  document.querySelectorAll('#vodTabs .vod-tab').forEach((b) => {
    const tab = b.dataset.tab;
    b.classList.toggle('hidden', tab === 'vods' ? !hv : !hc);
    b.classList.toggle('active', tab === vodTab);
  });
  document.getElementById('vodGrid')?.classList.toggle('hidden', vodTab !== 'vods');
  document.getElementById('clipGrid')?.classList.toggle('hidden', vodTab !== 'clips');
}

document.querySelectorAll('#vodTabs .vod-tab').forEach((b) => b.addEventListener('click', () => {
  vodTab = b.dataset.tab;
  renderMediaTabs();
}));

function applyClips(list) {
  cachedClips = Array.isArray(list) ? list : [];
  renderClipGrid();
  applyVods(cachedVods); // пересчитать, виден ли блок «Записи / Клипы»
  if (window.PWProView?.active) document.getElementById('vodSection').classList.toggle('hidden', !hasMedia());
}
window.addEventListener('pw:langchange', renderClipGrid);

let clipDoneTimer = null;
function showClipDone(c) {
  const box = document.getElementById('liveClipDone');
  const url = location.origin + '/clips/' + encodeURIComponent(c.id);
  document.getElementById('liveClipOpen').href = url;
  document.getElementById('liveClipCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      PW.toast(t('streamer.clips.copied'), 'success');
    } catch (_) {
      PW.toast(url, 'info');
    }
  };
  box.classList.remove('hidden');
  clearTimeout(clipDoneTimer);
  clipDoneTimer = setTimeout(() => box.classList.add('hidden'), 20000);
}
document.getElementById('liveClipClose')?.addEventListener('click', () => document.getElementById('liveClipDone').classList.add('hidden'));

async function makeClip() {
  if (!liveIsAuthed) return openLiveAuthModal('clip');
  if (clipBusy) return;
  clipBusy = true;
  const btns = document.querySelectorAll('.live-clip-btn');
  btns.forEach((b) => { b.disabled = true; b.classList.add('busy'); });
  try {
    const c = await api('/clips', { method: 'POST', body: { streamer: getNameFromUrl() } });
    showClipDone(c);
    applyClips([c, ...cachedClips].slice(0, 24));
  } catch (err) {
    if (err.status === 401) openLiveAuthModal('clip');
    else PW.toast(err.message || t('streamer.clips.failed'), 'error');
  } finally {
    clipBusy = false;
    btns.forEach((b) => { b.disabled = false; b.classList.remove('busy'); });
  }
}
document.querySelectorAll('.live-clip-btn').forEach((b) => b.addEventListener('click', makeClip));

// ---------- стрим-поинты и награды ----------
let pointsState = null;
let bonusTimer = null;
const fmtPoints = (n) => new Intl.NumberFormat(I18N.locale, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n || 0);
const pointsLabel = () => pointsState?.pointsName || t('streamer.points.default');

function renderPointsBtn() {
  const s = pointsState;
  document.getElementById('livePointsBalance').textContent = fmtPoints(s?.balance || 0);
  const icon = document.getElementById('livePointsIcon');
  icon.innerHTML = s?.icon ? `<img src="${liveEscapeHtml(s.icon)}" alt="" />` : '';
  icon.classList.toggle('coin', !s?.icon);
}

// эфир идёт (по последнему опросу live-status)
const channelLive = () => !!(currentStreamer?.isLive && currentStreamer?.streamPlaybackId);

// бонус показывается, только пока идёт эфир. Когда подходит время — сначала переспрашиваем сервер
// (вкладка могла быть в фоне, эфир — закончиться), показываем по его ответу
function scheduleBonus() {
  clearTimeout(bonusTimer);
  const bonus = document.getElementById('livePointsBonus');
  bonus.classList.add('hidden');
  const at = pointsState?.nextClaimAt ? new Date(pointsState.nextClaimAt).getTime() : null;
  if (!at || !liveIsAuthed || !pointsState?.isLive || !channelLive()) return;
  const wait = at - Date.now();
  if (wait <= 0) bonus.classList.remove('hidden');
  else bonusTimer = setTimeout(loadPoints, Math.min(wait + 500, 2 ** 31 - 1));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pointsState && !isOwnerFlag) loadPoints();
});

async function loadPoints() {
  try {
    pointsState = await api('/points/' + encodeURIComponent(getNameFromUrl()));
  } catch (_) {
    return;
  }
  renderPointsBtn();
  scheduleBonus();
  if (!document.getElementById('livePointsPopup').classList.contains('hidden')) renderPointsPopup();
}

// «+50 СП» взлетает над кнопкой (сокращение одинаковое при любом названии поинтов)
function floatPoints(n) {
  const wrap = document.querySelector('.live-points-wrap');
  const f = document.createElement('span');
  f.className = 'live-points-float';
  f.textContent = '+' + n + ' ' + t('streamer.points.short');
  wrap.appendChild(f);
  setTimeout(() => f.remove(), 1600);
}

document.getElementById('livePointsBonus')?.addEventListener('click', async () => {
  const bonus = document.getElementById('livePointsBonus');
  bonus.classList.add('hidden');
  try {
    const r = await api('/points/' + encodeURIComponent(getNameFromUrl()) + '/claim', { method: 'POST' });
    pointsState = { ...pointsState, balance: r.balance, nextClaimAt: r.nextClaimAt };
    floatPoints(r.added);
    renderPointsBtn();
    scheduleBonus();
  } catch (err) {
    PW.toast(err.message, 'error');
    loadPoints();
  }
});

// окно наград — общий модуль js/rewards-popup.js (тот же, что в студии)
const lpPopup = PWRewardsPopup.create(document.getElementById('livePointsPopup'), {
  state: () => ({ rewards: pointsState?.rewards || [], balance: pointsState?.balance || 0, owner: false }),
  label: pointsLabel,
  beforeBuy: () => { if (!liveIsAuthed) { openLiveAuthModal('points'); return false; } return true; },
  redeem: async (r, message) => {
    const res = await api('/points/' + encodeURIComponent(getNameFromUrl()) + '/redeem', { method: 'POST', body: { rewardId: r.id, message } });
    pointsState.balance = res.balance;
    renderPointsBtn();
  },
});
const renderPointsPopup = () => lpPopup.render();

document.getElementById('livePointsBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!liveIsAuthed) return openLiveAuthModal('points');
  const box = document.getElementById('livePointsPopup');
  const open = box.classList.toggle('hidden') === false;
  if (open) { lpPopup.reset(); renderPointsPopup(); loadPoints(); }
});
document.getElementById('livePointsPopup')?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => document.getElementById('livePointsPopup')?.classList.add('hidden'));
window.addEventListener('pw:langchange', () => { renderPointsBtn(); if (!document.getElementById('livePointsPopup').classList.contains('hidden')) renderPointsPopup(); });
renderPointsBtn();

// ---------- подписка ----------
// одно состояние на две кнопки: в профиле (у владельца видна, но неактивна) и под чатом эфира (не у владельца)

let followState = { followers: 0, following: false, self: false };
let followBusy = false;

const FOLLOW_BTNS = ['followBtn', 'liveFollowBtn'];

// only — перерисовать одну кнопку (конец её анимации не должен сбивать анимацию второй)
function renderFollow(only) {
  const s = followState;
  for (const id of typeof only === 'string' ? [only] : FOLLOW_BTNS) {
    const b = document.getElementById(id);
    if (!b) continue;
    // стиль из PRO-редактора (если задан) — у обеих кнопок: в профиле и под чатом эфира
    const fst = window.PWProView?.followStyle || null;
    if (!window.PWLayout?.paintFollow(b, fst, s.following)) b.textContent = s.following ? t('streamer.follow.following') : t('streamer.follow.follow');
    b.classList.toggle('on', s.following);
    b.disabled = s.self || followBusy;
    b.title = s.self ? t('streamer.follow.selfHint') : s.following ? t('streamer.follow.unfollowHint') : '';
  }
  const c = document.getElementById('profileFollowers');
  if (c && typeof only !== 'string') c.textContent = t('streamer.follow.count', { n: s.followers });
}

async function loadFollowState() {
  try {
    followState = await api('/streamers/' + encodeURIComponent(getNameFromUrl()) + '/follow');
  } catch (err) {
    console.warn('[follow]', err.message);
  }
  renderFollow();
}

async function toggleFollow() {
  if (followBusy || followState.self) return;
  if (!liveIsAuthed) return openLiveAuthModal('follow');
  const name = currentStreamer?.streamerName || getNameFromUrl();
  const unfollow = followState.following;
  if (unfollow) {
    const ok = await PW.confirm(t('streamer.follow.unfollowConfirm', { name }), { okText: t('streamer.follow.unfollowOk'), danger: true });
    if (!ok) return;
  }
  followBusy = true;
  renderFollow();
  let changed = false;
  try {
    followState = await api('/streamers/' + encodeURIComponent(getNameFromUrl()) + '/follow', { method: unfollow ? 'DELETE' : 'POST' });
    changed = true;
    if (!unfollow) PW.toast(t('streamer.follow.done', { name }), 'success');
    liveSocket?.emit('chat:check'); // режим «только подписчики»: открыть или закрыть поле ввода
  } catch (err) {
    if (err.status === 401) openLiveAuthModal('follow');
    else PW.toast(err.message || t('streamer.follow.failed'), 'error');
  } finally {
    followBusy = false;
    // анимация из стиля кнопки (PRO-редактор): переход в новое состояние, потом обычная перерисовка
    // анимация из стиля кнопки (PRO-редактор) — у видимых кнопок; каждая в конце перерисовывает только себя
    const fst = window.PWProView?.followStyle;
    renderFollow();
    if (changed && fst) {
      for (const id of FOLLOW_BTNS) {
        const btn = document.getElementById(id);
        if (!btn || !btn.offsetParent) continue;
        window.PWLayout.paintFollow(btn, fst, !followState.following); // старый вид — анимация переводит в новый
        window.PWLayout.playFollowAnim(btn, fst, followState.following, () => renderFollow(id));
      }
    }
  }
}

document.getElementById('followBtn')?.addEventListener('click', toggleFollow);
document.getElementById('liveFollowBtn')?.addEventListener('click', toggleFollow);
renderFollow(); // подпись кнопки сразу, число — когда ответит сервер

// ---------- записи ----------

function vodEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// записей до 50, и каждая в двух списках: <video preload="metadata"> у всех сразу — до 100 запросов к видео
// и столько же видеоэлементов при открытии профиля. Видео подключаем, только когда карточка подъезжает к экрану
const vodLazy = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) loadVodVideo(e.target);
  }, { rootMargin: '300px' })
  : null;

function loadVodVideo(v) {
  vodLazy?.unobserve(v);
  if (v.dataset.src && !v.getAttribute('src')) v.src = v.dataset.src;
}

function makeVodVideo(url, attrs) {
  const v = document.createElement('video');
  v.dataset.src = url;
  v.preload = 'metadata';
  v.playsInline = true;
  Object.assign(v, attrs);
  if (vodLazy) vodLazy.observe(v);
  else v.src = url;
  return v;
}

function clearVodList(el) {
  el.querySelectorAll('video').forEach((v) => {
    vodLazy?.unobserve(v);
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
  });
  el.innerHTML = '';
}

const vodDate = (d) => new Date(d).toLocaleString(I18N.locale);
// дата записи и категория эфира, в котором она записана
const vodMeta = (v) => vodDate(v.createdAt) + (v.category ? ' · 🎮 ' + liveCatName(v.category) : '');

function renderVodGrid(vods) {
  const grid = document.getElementById('vodGrid');
  clearVodList(grid);
  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    card.dataset.url = v.url;
    card.innerHTML = `
      <div class="vod-card-body">
        <div class="vod-card-title"></div>
        <div class="vod-card-meta"></div>
      </div>`;
    card.prepend(makeVodVideo(v.url, { controls: true }));
    card.querySelector('.vod-card-title').textContent = v.title || t('streamer.vod');
    card.querySelector('.vod-card-meta').textContent = vodMeta(v);
    grid.appendChild(card);
  });
}

function renderVodColumn(vods) {
  const list = document.getElementById('vodColumnList');
  clearVodList(list);
  vods.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    card.innerHTML = `
      <div class="vod-card-body">
        <div class="vod-card-title"></div>
        <div class="vod-card-meta"></div>
      </div>`;
    card.querySelector('.vod-card-title').textContent = v.title || t('streamer.vod');
    card.prepend(makeVodVideo(v.url, { muted: true }));
    card.querySelector('.vod-card-meta').textContent = vodMeta(v);
    card.onclick = () => switchToVodPlayback(v);
    list.appendChild(card);
  });
}

function switchToVodPlayback(v) {
  closeLiveStrip();
  requestAnimationFrame(() => {
    const grid = document.getElementById('vodGrid');
    const target = grid.querySelector(`.vod-card[data-url="${CSS.escape(v.url)}"] video`);
    if (target) {
      loadVodVideo(target);
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.play().catch(() => {});
    }
  });
}

// запустили одну запись — остальные на паузу (иначе звук нескольких сразу)
document.getElementById('vodGrid')?.addEventListener('play', (e) => {
  document.querySelectorAll('#vodGrid video').forEach((v) => { if (v !== e.target && !v.paused) v.pause(); });
}, true);

let vodSig = null;

// принимает уже загруженный список (из кэша или с сервера); если он не изменился, DOM не трогаем
function applyVods(vods) {
  const list = vods || [];
  const sig = JSON.stringify(list);
  cachedVods = list;
  const hasVods = list.length > 0;
  if (sig !== vodSig) {
    vodSig = sig;
    renderVodGrid(list);
    renderVodColumn(list);
  }
  const pro = !!window.PWProView?.active;
  document.getElementById('vodSection').classList.toggle('hidden', !hasMedia() || (liveOpen && !pro));
  renderMediaTabs();
  document.getElementById('vodColumn').classList.toggle('hidden', pro || !hasVods || !liveOpen);
}

function switchVodLayout(open) {
  const hasVods = cachedVods.length > 0;
  const pro = !!window.PWProView?.active;
  document.getElementById('vodSection').classList.toggle('hidden', (open && !pro) || !hasMedia());
  document.getElementById('vodColumn').classList.toggle('hidden', pro || !open || !hasVods);
}

// ---------- аккордеон эфира ----------

function toggleLiveStrip() {
  liveOpen ? closeLiveStrip() : openLiveStrip();
}

function openLiveStrip() {
  if (liveOpen) return;
  liveOpen = true;
  document.getElementById('liveStrip').classList.add('open');
  document.getElementById('liveToggleChevronBtn').classList.add('open');
  document.getElementById('ownerWorkbenchBtn')?.classList.add('live-hidden');
  document.getElementById('ownerEditBtn')?.classList.add('live-hidden');
  switchVodLayout(true);
  startLiveSession();
}

function closeLiveStrip() {
  if (!liveOpen) return;
  liveOpen = false;
  document.getElementById('liveStrip').classList.remove('open');
  document.getElementById('liveToggleChevronBtn').classList.remove('open');
  document.getElementById('ownerWorkbenchBtn')?.classList.remove('live-hidden');
  document.getElementById('ownerEditBtn')?.classList.remove('live-hidden');
  switchVodLayout(false);
  stopLiveSession();
}

// hls.js (~600 КБ) грузим только когда нужен плеер эфира: профиль без эфира открывается без него.
// Эфир идёт — loadHls() зовётся сразу после ответа профиля, к открытию полосы файл уже скачан
let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/vendor/hls.min.js';
      s.onload = () => resolve(window.Hls || null);
      s.onerror = () => { hlsLoading = null; resolve(null); }; // следующая попытка — заново
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}

function startLiveSession() {
  const video = document.getElementById('liveVideo');
  const offline = document.getElementById('liveOffline');
  const overlay = document.getElementById('liveOverlay');
  const overlayText = document.getElementById('liveOverlayText');
  const startBtn = document.getElementById('liveStartBtn');

  if (currentStreamer?.isLive && currentStreamer?.streamPlaybackId) {
    offline.classList.add('hidden');
    overlay.classList.remove('hidden');
    overlayText.textContent = t('streamer.live.loading');
    startBtn.classList.remove('hidden');
    startBtn.onclick = () => {
      video.muted = false;
      applyVolumeToLive(getSavedVolume());
      overlay.classList.add('hidden');
    };
    const playbackId = currentStreamer.streamPlaybackId;
    loadHls().then((H) => {
      if (!liveOpen || liveHls || currentStreamer?.streamPlaybackId !== playbackId) return; // закрыли или сменилось, пока грузился
      if (!H) throw new Error('hls.js не загрузился');
      attachLiveHls(playbackId);
    }).catch((e) => {
      console.error('[live] не удалось запустить плеер:', e.message);
      overlay.classList.add('hidden');
      offline.classList.remove('hidden');
      offline.textContent = t('streamer.live.playerFailed');
    });
  } else {
    video.classList.add('hidden');
    offline.classList.remove('hidden');
    overlay.classList.add('hidden');
  }

  connectLiveChat(getNameFromUrl());
  peekLiveInfo();

  if (isOwnerFlag) {
    document.getElementById('liveOwnerBar').classList.remove('hidden');
  } else {
    document.getElementById('liveFollowBar').classList.remove('hidden'); // владельцу подписка не нужна
    setTimeout(loadPoints, 1500); // стрим-поинты — после входа в чат: сервер считает просмотр с этого момента
  }
}

function stopLiveSession() {
  if (liveHls) {
    try { liveHls.destroy(); } catch (_) {}
    liveHls = null;
  }
  livePlayerReconnect?.reset?.();
  livePlayerReconnect = null;

  const video = document.getElementById('liveVideo');
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
  video.classList.add('hidden');
  video.dataset.liveLockAttached = '';

  if (liveSocket) {
    liveSocket.removeAllListeners();
    liveSocket.disconnect();
    liveSocket = null;
  }
  liveChatReconnect?.reset?.();
  liveChatReconnect = null;

  document.getElementById('liveMessages').innerHTML = '';
  document.getElementById('liveVolumePopup').classList.add('hidden');
  document.getElementById('liveQualityPopup').classList.add('hidden');
  document.getElementById('liveViewersPanel')?.classList.remove('open');
  document.getElementById('liveViewersBtn')?.classList.remove('active');
  setViewersCount(0);
  renderViewersList([]);
  applyLiveRestriction(null);
}

document.getElementById('profileAvatarBtn')?.addEventListener('click', toggleLiveStrip);
document.getElementById('profileNameBtn')?.addEventListener('click', toggleLiveStrip);
document.getElementById('liveToggleChevronBtn')?.addEventListener('click', toggleLiveStrip);

// ---------- HLS-плеер + качество ----------

  function lockToLiveEdge(video) {
    if (video.__liveLockBound) return; // слушатель вешаем один раз за жизнь страницы
    video.__liveLockBound = true;
    video.addEventListener('seeking', () => {
    if (!video.seekable.length) return;
    const liveEdge = video.seekable.end(video.seekable.length - 1);
    const minAllowed = Math.max(0, liveEdge - 3);
    if (video.currentTime < minAllowed) video.currentTime = liveEdge;
  });
}

const QUALITY_STORAGE_KEY = 'pw_quality'; // 'auto' | 'source' | '720' | '360' (уровни ниже источника; 480 был раньше)

function getSavedQuality() {
  try { return localStorage.getItem(QUALITY_STORAGE_KEY) || 'auto'; } catch (_) { return 'auto'; }
}

function saveQuality(v) {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, v); } catch (_) {}
}

// имя уровня из master-плейлиста: source / 720 / 360
function levelKey(lvl) {
  if (lvl.name) return String(lvl.name);
  const uri = lvl.uri || (Array.isArray(lvl.url) ? lvl.url[0] : lvl.url) || '';
  const m = String(uri).match(/([^/]+)\/index\.m3u8/);
  return m ? m[1] : '';
}

function populateQualityMenu(levels) {
  const popup = document.getElementById('liveQualityPopup');
  popup.innerHTML = '';

  const items = levels.map((lvl, idx) => ({ idx, key: levelKey(lvl), height: lvl.height || 0 }));

  // применяем сохранённое качество (если такого уровня нет — авто)
  let saved = getSavedQuality();
  const savedItem = items.find((i) => i.key === saved);
  if (saved !== 'auto' && !savedItem) saved = 'auto';
  liveHls.currentLevel = saved === 'auto' ? -1 : savedItem.idx;

  const makeOption = (label, key, levelIndex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'live-quality-option';
    btn.textContent = label;
    if (key === saved) btn.classList.add('active');
    btn.onclick = () => {
      liveHls.currentLevel = levelIndex;
      saveQuality(key);
      popup.querySelectorAll('.live-quality-option').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      popup.classList.add('hidden');
      updateAutoLabel();
    };
    return btn;
  };

  popup.appendChild(makeOption(t('streamer.quality.auto'), 'auto', -1));

  // сначала источник, дальше по убыванию высоты
  items.sort((a, b) => (b.key === 'source') - (a.key === 'source') || b.height - a.height);

  items.forEach(({ idx, key, height }) => {
    popup.appendChild(makeOption(qualityLabel(key, height, idx), key || `lvl${idx}`, idx));
  });
  popup.firstElementChild.dataset.auto = '1';
  updateAutoLabel();
}

function qualityLabel(key, height, idx) {
  return key === 'source'
    ? (height ? t('streamer.quality.sourceP', { h: height }) : t('streamer.quality.source'))
    : (height ? `${height}p` : t('streamer.quality.level', { n: idx }));
}

// в «Авто» показываем, какое качество сейчас реально играет: «Авто · 720p»
function updateAutoLabel() {
  const btn = document.querySelector('#liveQualityPopup [data-auto]');
  if (!btn || !liveHls) return;
  const lvl = liveHls.autoLevelEnabled ? liveHls.levels?.[liveHls.currentLevel] : null;
  btn.textContent = lvl
    ? t('streamer.quality.autoP', { q: qualityLabel(levelKey(lvl), lvl.height || 0, liveHls.currentLevel) })
    : t('streamer.quality.auto');
}

function attachLiveHls(playbackId) {
  const video = document.getElementById('liveVideo');
  lockToLiveEdge(video);
  applyVolumeToLive(getSavedVolume());

  const src = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;

  liveHls = new Hls({
    enableWorker: true,
    capLevelToPlayerSize: true, // «Авто» не берёт качество крупнее плеера (телефон, маленькое окно) — меньше трафика и нагрузки
    lowLatencyMode: false,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 4,
    maxLiveSyncPlaybackRate: 1.15,
    backBufferLength: 6,
    liveDurationInfinity: true,
    manifestLoadingMaxRetry: 8,
    levelLoadingMaxRetry: 8,
    fragLoadingMaxRetry: 8,
    manifestLoadingRetryDelay: 1000,
    levelLoadingRetryDelay: 1000,
  });
  liveHls.loadSource(src);
  liveHls.attachMedia(video);

  liveHls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    document.getElementById('liveOverlay').classList.add('hidden');
    video.classList.remove('hidden');
    video.play().catch(() => {});
    populateQualityMenu(data.levels || []);
  });
  liveHls.on(Hls.Events.LEVEL_SWITCHED, updateAutoLabel);

  livePlayerReconnect = createReconnectScheduler(
    () => new Promise((resolve) => {
      if (!liveHls) return resolve(false);
      const retrySrc = `/media/live/${playbackId}/master.m3u8?t=${Date.now()}`;
      liveHls.loadSource(retrySrc);
      const onParsed = () => { cleanup(); video.play().catch(() => {}); resolve(true); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, 4000);
      function cleanup() { clearTimeout(timer); liveHls?.off(Hls.Events.MANIFEST_PARSED, onParsed); }
      liveHls.on(Hls.Events.MANIFEST_PARSED, onParsed);
    }),
    () => {}
  );

  liveHls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data?.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) livePlayerReconnect?.start();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try { liveHls.recoverMediaError(); } catch (_) {}
    }
  });
}

const VOLUME_STORAGE_KEY = 'pw_volume';

function getSavedVolume() {
  let v = NaN;
  try { v = parseInt(localStorage.getItem(VOLUME_STORAGE_KEY), 10); } catch (_) {}
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 50;
}

function saveVolume(v) {
  try { localStorage.setItem(VOLUME_STORAGE_KEY, String(v)); } catch (_) {}
}

function applyVolumeToLive(v) {
  const video = document.getElementById('liveVideo');
  if (video) video.volume = v / 100;
  const slider = document.getElementById('liveVolumeSlider');
  if (slider) slider.value = v;
}

document.getElementById('liveVolumeBtn')?.addEventListener('click', () => {
  document.getElementById('liveQualityPopup').classList.add('hidden');
  document.getElementById('liveVolumePopup').classList.toggle('hidden');
});

document.getElementById('liveVolumeSlider')?.addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  saveVolume(v);
  applyVolumeToLive(v);
});
document.getElementById('liveQualityBtn')?.addEventListener('click', () => {
  document.getElementById('liveVolumePopup').classList.add('hidden');
  document.getElementById('liveQualityPopup').classList.toggle('hidden');
});

// ---------- фуллскрин: убираем докнутый чат, показываем кнопку + плавающую панель ----------

function liveIsFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

document.getElementById('liveFullscreenBtn')?.addEventListener('click', () => {
  const wrap = document.querySelector('.live-strip-inner');
  if (liveIsFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
  }
});

document.addEventListener('fullscreenchange', onLiveFullscreenChange);
document.addEventListener('webkitfullscreenchange', onLiveFullscreenChange);

function onLiveFullscreenChange() {
  const wrap = document.querySelector('.live-strip-inner');
  const chatToggle = document.getElementById('liveChatToggleBtn');
  const chatSide = document.getElementById('liveChatSide');
  const isFs = liveIsFullscreen();

  wrap?.classList.toggle('fs-active', isFs);
  chatToggle?.classList.toggle('hidden', !isFs);

  if (!isFs) {
    chatSide?.classList.remove('fs-open');
    // сбрасываем inline-стили, чтобы докнутый чат снова жил по CSS
    if (chatSide) {
      chatSide.style.left = '';
      chatSide.style.top = '';
      chatSide.style.right = '';
      chatSide.style.bottom = '';
      chatSide.style.width = '';
      chatSide.style.height = '';
    }
  }
}

document.getElementById('liveChatToggleBtn')?.addEventListener('click', () => {
  document.getElementById('liveChatSide')?.classList.toggle('fs-open');
});

// перетаскивание плавающей панели чата в fullscreen (только за шапку)
(function initLiveChatDrag() {
  const panel = document.getElementById('liveChatSide');
  const handle = document.querySelector('#liveChatSide .live-chat-header');
  const resizeHandle = document.getElementById('liveChatResizeHandle');
  if (!panel || !handle) return;

  const POS_KEY = 'pw-pos:live:chatPanel:fullscreen';
  const SIZE_KEY = 'pw-size:live:chatPanel:fullscreen';
  const MIN_W = 220;
  const MIN_H = 200;

  let dragging = false;
  let resizing = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  let startXR = 0, startYR = 0, startW = 0, startH = 0;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
  }

  function applySavedSize() {
    if (!liveIsFullscreen() || !panel.classList.contains('fs-open')) return;

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    } catch (_) {}

    const parent = panel.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
      return; // оставим CSS-дефолт
    }

    const maxW = Math.max(MIN_W, parentRect.width - 16);
    const maxH = Math.max(MIN_H, parentRect.height - 16);
    const width = clamp(saved.width, MIN_W, maxW);
    const height = clamp(saved.height, MIN_H, maxH);

    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
  }

  function applySavedPosition() {
    if (!liveIsFullscreen() || !panel.classList.contains('fs-open')) return;

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch (_) {}

    const parent = panel.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const panelW = panel.offsetWidth || 320;
    const panelH = panel.offsetHeight || 400;

    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') {
      panel.style.left = '16px';
      panel.style.top = '60px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      return;
    }

    const left = clamp(saved.left, 0, Math.max(0, parentRect.width - panelW));
    const top = clamp(saved.top, 0, Math.max(0, parentRect.height - panelH));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function applySaved() {
    applySavedSize();
    applySavedPosition();
  }

  // --- drag по шапке ---
  handle.addEventListener('pointerdown', (e) => {
    if (!liveIsFullscreen() || e.target.closest('button')) return;

    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();

    const parentRect = panel.parentElement.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    let newLeft = origLeft + (e.clientX - startX);
    let newTop = origTop + (e.clientY - startY);

    newLeft = clamp(newLeft, 0, parentRect.width - panelRect.width);
    newTop = clamp(newTop, 0, parentRect.height - panelRect.height);

    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  handle.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

    localStorage.setItem(POS_KEY, JSON.stringify({
      left: parseFloat(panel.style.left) || 0,
      top: parseFloat(panel.style.top) || 0,
    }));
  });

  // --- resize за угол ---
  resizeHandle?.addEventListener('pointerdown', (e) => {
    if (!liveIsFullscreen()) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    startXR = e.clientX;
    startYR = e.clientY;
    resizing = true;
    panel.classList.add('resizing');
    try { resizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  resizeHandle?.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    e.preventDefault();

    const parentRect = panel.parentElement.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const leftOffset = panelRect.left - parentRect.left;
    const topOffset = panelRect.top - parentRect.top;

    const maxW = Math.max(MIN_W, parentRect.width - leftOffset - 8);
    const maxH = Math.max(MIN_H, parentRect.height - topOffset - 8);

    let newW = startW + (e.clientX - startXR);
    let newH = startH + (e.clientY - startYR);

    newW = clamp(newW, MIN_W, maxW);
    newH = clamp(newH, MIN_H, maxH);

    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
  });

  function endResize(e) {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
    try { resizeHandle.releasePointerCapture(e.pointerId); } catch (_) {}

    const rect = panel.getBoundingClientRect();
    localStorage.setItem(SIZE_KEY, JSON.stringify({
      width: rect.width,
      height: rect.height,
    }));
  }

  resizeHandle?.addEventListener('pointerup', endResize);
  resizeHandle?.addEventListener('pointercancel', endResize);

  // восстановить при открытии чата / входе в FS
  document.getElementById('liveChatToggleBtn')?.addEventListener('click', () => {
    requestAnimationFrame(applySaved);
  });

  document.addEventListener('fullscreenchange', () => {
    if (liveIsFullscreen()) requestAnimationFrame(applySaved);
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (liveIsFullscreen()) requestAnimationFrame(applySaved);
  });
})();

document.getElementById('liveOwnerSettingsBtn')?.addEventListener('click', () => {
  location.href = '/workbench.html';
});

// ---------- чат ----------

function liveEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildLiveMessageHtml(msg) {
  if (msg.deleted) return `<span style="color:var(--text-muted);font-style:italic;">${t('common.chat.deleted')}</span>`;
  if (msg.source === 'raid') return `<span class="live-raid-msg">🚀 ${liveEscapeHtml(PWRaid.messageText(msg))}</span>`;

  // данные кнопок лежат в data-атрибутах (клики ловит общий обработчик внизу файла), а не в onclick.
  // Кнопки — по правам (стример задаёт их модераторам в «Активе канала»); наказывать можно только тех, кто ниже рангом
  const delBtn = canDo('deleteMsg')
    ? `<button type="button" class="live-mod-btn" title="${t('common.delete')}" data-act="del" data-id="${liveEscapeHtml(msg._id)}">🗑️</button>`
    : '';

  const lower = !msg.external && msg.senderId && PWBadges.rank(liveRole.role) > PWBadges.rank(msg);
  const userBtns = lower ? `
    ${canDo('ban') ? `<button type="button" class="live-mod-btn" title="${t('common.mod.ban')}" data-act="ban" data-uid="${liveEscapeHtml(msg.senderId)}" data-name="${liveEscapeHtml(msg.senderUsername)}">🚫</button>` : ''}
    ${canDo('timeout') ? `<button type="button" class="live-mod-btn" title="${t('common.mod.timeout')}" data-act="timeout" data-uid="${liveEscapeHtml(msg.senderId)}" data-name="${liveEscapeHtml(msg.senderUsername)}">⏱️</button>` : ''}
  ` : '';

  const src = msg.external
    ? `<span class="live-src">${liveEscapeHtml(msg.source || 'api')}</span>`
    : '';

  const nickCls = 'live-nick' + (msg.isOwner ? ' live-nick--owner' : '');
  const nickStyle = !msg.isOwner && /^#[0-9a-f]{6}$/i.test(msg.nickColor || '')
    ? ` style="color:${msg.nickColor}"`
    : '';

  // фильтр слов: показываем «****», по клику (с подтверждением) — оригинал
  const body = msg.masked && !msg.revealed
    ? `<span class="live-masked" data-act="reveal" title="${liveEscapeHtml(t('streamer.chat.maskedHint'))}">${PWEmotes.render(liveEscapeHtml(msg.masked), msg.emotes)}</span>`
    : PWEmotes.render(liveEscapeHtml(msg.text), msg.emotes);
  return `${delBtn}${userBtns}${src}${PWBadges.html(msg.modLevel)}<b class="${nickCls}"${nickStyle}>${liveEscapeHtml(I18N.sysName(msg.senderUsername))}</b>: ${body}`;
}

function renderLiveMessage(msg) {
  const box = document.getElementById('liveMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.dataset.id = msg._id;
  row._msg = msg; // для перерисовки, когда меняются права (стал модератором) или открыли скрытое фильтром
  if (msg.highlight) row.className = 'live-msg-hl';
  row.innerHTML = buildLiveMessageHtml(msg);
  box.appendChild(row);
  // в живом чате за эфир набегают тысячи сообщений — держим последние
  while (box.childElementCount > 250) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

function liveDeleteMessage(messageId) {
  liveSocket?.emit('chat:delete', { messageId });
}
async function liveBanUser(userId, username) {
  const ok = await PW.confirm(t('common.mod.banText', { name: username }), {
    title: t('common.mod.banTitle'),
    okText: t('common.mod.ban'),
    danger: true,
  });
  if (!ok) return;
  liveSocket?.emit('chat:ban', { userId, username });
}
async function liveTimeoutUser(userId, username) {
  const secStr = await PW.prompt(t('common.mod.timeoutText', { name: username }), {
    title: t('common.mod.timeout'),
    defaultValue: '300',
    inputType: 'number',
    okText: t('common.mod.timeoutOk'),
  });
  const seconds = parseInt(secStr, 10);
  if (!seconds || seconds <= 0) return;
  liveSocket?.emit('chat:timeout', { userId, username, seconds });
}
window.liveDeleteMessage = liveDeleteMessage;
window.liveBanUser = liveBanUser;
window.liveTimeoutUser = liveTimeoutUser;

document.getElementById('liveClearChatBtn')?.addEventListener('click', async () => {
  const ok = await PW.confirm(t('common.chat.clearText'), {
    title: t('common.chat.clearTitle'),
    okText: t('common.chat.clearOk'),
    danger: true,
  });
  if (ok) liveSocket?.emit('chat:clear');
});

function toggleViewersPanel() {
  const panel = document.getElementById('liveViewersPanel');
  const btn = document.getElementById('liveViewersBtn');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  btn?.classList.toggle('active', open);
}

document.getElementById('liveViewersBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleViewersPanel();
});
document.getElementById('liveViewersClose')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('liveViewersPanel')?.classList.remove('open');
  document.getElementById('liveViewersBtn')?.classList.remove('active');
});

let liveViewersCache = [];

function renderViewersList(viewers) {
  liveViewersCache = viewers || [];
  const list = document.getElementById('liveViewersList');
  if (!list) return;
  list.innerHTML = '';
  if (!liveViewersCache.length) {
    list.innerHTML = `<div class="live-viewer-row guest">${t('common.viewers.none')}</div>`;
    return;
  }
  liveViewersCache.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'live-viewer-row' + (v.isGuest ? ' guest' : '');
    row.textContent = v.isGuest ? t('common.viewers.guests', { n: v.guests || 1 }) : v.username;
    list.appendChild(row);
  });
}

function setViewersCount(count) {
  const el = document.getElementById('liveViewersCount');
  if (el) el.textContent = String(count ?? 0);
}

let liveRestrictTimer = null;

function fmtHMS(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

// r: { type: 'none' | 'ban' | 'timeout', until } или null
// значки режима в шапке чата: «только подписчики» и медленный режим (включает стример или модератор)
let liveMode = {};
function renderModeBadges() {
  const min = liveMode.followMin ?? null;
  const el = document.getElementById('liveFollowersBadge');
  if (el) {
    el.classList.toggle('hidden', min === null);
    el.textContent = t('streamer.chat.followersBadge');
    el.title = min ? t('streamer.chat.followersBadgeMin', { n: min }) : t('streamer.chat.followersBadgeHint');
  }
  const slow = document.getElementById('liveSlowBadge');
  if (slow) {
    slow.classList.toggle('hidden', !liveMode.slowSec);
    slow.textContent = '🐢 ' + PWChatMode.slowLabel(liveMode.slowSec || 0);
    slow.title = t('streamer.chat.slowHint');
  }
}
window.addEventListener('pw:langchange', renderModeBadges);

// медленный режим: сервер не принял сообщение — поле ввода ждёт оставшиеся секунды
let slowTimer = null;
function startSlowCountdown(wait) {
  const input = document.getElementById('liveChatInput');
  if (!input || !wait) return;
  clearInterval(slowTimer);
  let left = wait;
  const tick = () => {
    if (left <= 0) {
      clearInterval(slowTimer);
      input.disabled = false;
      input.placeholder = t('streamer.chat.placeholder');
      return;
    }
    input.disabled = true;
    input.placeholder = t('streamer.chat.slowWait', { n: left });
    left -= 1;
  };
  tick();
  slowTimer = setInterval(tick, 1000);
}

let raidBar = null;
let raidStay = false;

// ---------- роль в чате канала: стример, высший модератор, модератор или зритель ----------
let liveRole = { role: null, perms: [] };
const canDo = (perm) => liveRole.perms.includes(perm);
let liveChatModeUi = null;

function applyLiveRole(rp) {
  liveRole = { role: rp?.role || null, perms: Array.isArray(rp?.perms) ? rp.perms : [] };
  document.getElementById('liveClearChatBtn')?.classList.toggle('hidden', !canDo('clearChat'));
  document.getElementById('liveChatModeBtn')?.classList.toggle('hidden', !canDo('chatSettings'));
  // 🛠 — высшему модератору, если стример дал ему что-то из управления эфиром (у стримера есть студия)
  const streamPerms = ['editTitle', 'editCategory', 'raid'].some(canDo);
  document.getElementById('liveModPanelBtn')?.classList.toggle('hidden', liveRole.role !== 'senior' || !streamPerms);
  if (!canDo('chatSettings')) document.getElementById('liveChatModePopup')?.classList.add('hidden');
  // кнопки модерации у уже показанных сообщений
  document.querySelectorAll('#liveMessages > div').forEach((row) => {
    if (row._msg && !row._msg.deleted) row.innerHTML = buildLiveMessageHtml(row._msg);
  });
}

// ---------- 🛠 управление эфиром (высший модератор): то, что разрешил стример ----------
let modPanelData = null;
let modCatChosen; // undefined — категорию не трогали, null — убрать, объект — новая
let modCatTimer = null;

function renderModCat(c) {
  const box = document.getElementById('modPanelCatCurrent');
  box.innerHTML = '';
  if (!c) {
    box.textContent = t('streamer.mod.noCategory');
    return;
  }
  const img = c.cover || c.box;
  box.innerHTML = `${img ? `<img src="${liveEscapeHtml(img)}" alt="" />` : ''}<b>${liveEscapeHtml(liveCatName(c))}</b>`;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'live-head-btn';
  x.textContent = '×';
  x.title = t('streamer.mod.clearCategory');
  x.addEventListener('click', () => { modCatChosen = null; renderModCat(null); });
  box.appendChild(x);
}

async function openModPanel() {
  try {
    modPanelData = await api('/channel/' + encodeURIComponent(getNameFromUrl()) + '/settings');
  } catch (err) {
    PW.toast(err.message, 'error');
    return;
  }
  const p = modPanelData.perms || [];
  document.getElementById('modPanelTitleBox').classList.toggle('hidden', !p.includes('editTitle'));
  document.getElementById('modPanelCatBox').classList.toggle('hidden', !p.includes('editCategory') || !modPanelData.categoriesEnabled);
  document.getElementById('modPanelRaidBtn').classList.toggle('hidden', !p.includes('raid'));
  document.getElementById('modPanelSave').classList.toggle('hidden', !p.includes('editTitle') && !p.includes('editCategory'));
  document.getElementById('modPanelTitle').value = modPanelData.streamTitle || '';
  document.getElementById('modPanelDesc').value = modPanelData.streamDescription || '';
  document.getElementById('modPanelCatInput').value = '';
  modCatChosen = undefined;
  renderModCat(modPanelData.category);
  document.getElementById('modPanelModal').classList.remove('hidden');
}
const closeModPanel = () => document.getElementById('modPanelModal').classList.add('hidden');

document.getElementById('liveModPanelBtn')?.addEventListener('click', openModPanel);
document.getElementById('modPanelRaidBtn')?.addEventListener('click', () => {
  closeModPanel();
  PWRaid.openPicker({ self: getNameFromUrl(), onStart: (to, seconds) => liveSocket?.emit('chat:raid-start', { to, seconds }) });
});
document.getElementById('modPanelClose')?.addEventListener('click', closeModPanel);
document.getElementById('modPanelModal')?.addEventListener('click', (e) => { if (e.target.id === 'modPanelModal') closeModPanel(); });

document.getElementById('modPanelCatInput')?.addEventListener('input', (e) => {
  clearTimeout(modCatTimer);
  const q = e.target.value.trim();
  const box = document.getElementById('modPanelCatResults');
  if (q.length < 2) return box.classList.add('hidden');
  modCatTimer = setTimeout(async () => {
    try {
      const list = await api('/categories/search?q=' + encodeURIComponent(q));
      box.innerHTML = '';
      for (const c of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'mod-cat-row';
        row.innerHTML = `${c.box ? `<img src="${liveEscapeHtml(c.box)}" alt="" />` : ''}<span>${liveEscapeHtml(liveCatName(c))}</span>`;
        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          modCatChosen = c;
          renderModCat(c);
          e.target.value = '';
          box.classList.add('hidden');
        });
        box.appendChild(row);
      }
      if (!list.length) box.textContent = t('streamer.mod.nothing');
      box.classList.remove('hidden');
    } catch (err) {
      PW.toast(err.message, 'error');
    }
  }, 350);
});
document.getElementById('modPanelCatInput')?.addEventListener('blur', () => setTimeout(() => document.getElementById('modPanelCatResults').classList.add('hidden'), 150));

document.getElementById('modPanelSave')?.addEventListener('click', async () => {
  const p = modPanelData?.perms || [];
  const body = {};
  if (p.includes('editTitle')) {
    body.streamTitle = document.getElementById('modPanelTitle').value;
    body.streamDescription = document.getElementById('modPanelDesc').value;
  }
  if (p.includes('editCategory') && modCatChosen !== undefined) body.streamCategoryId = modCatChosen ? modCatChosen.id : '';
  try {
    await api('/channel/' + encodeURIComponent(getNameFromUrl()) + '/settings', { method: 'PATCH', body });
    PW.toast(t('common.saved'), 'success');
    closeModPanel();
    pollStreamerLiveStatus(); // плашка над плеером обновится сразу
  } catch (err) {
    PW.toast(err.message, 'error');
  }
});

// 😀 у поля чата: смайлы канала (подписчикам) и публичные
(function initLiveEmotes() {
  const form = document.getElementById('liveChatForm');
  const input = document.getElementById('liveChatInput');
  if (!form || !input || !window.PWEmotes) return;
  PWEmotes.mountPicker({ form, input, channel: getNameFromUrl, before: form.querySelector('button[type="submit"]') });
})();

// подсказка команд модерации: в поле чата набрали «/» (js/chat-slash.js)
window.PWChatSlash?.attach(document.getElementById('liveChatInput'), () => liveRole.perms);

(function initLiveChatMode() {
  const btn = document.getElementById('liveChatModeBtn');
  const pop = document.getElementById('liveChatModePopup');
  if (!btn || !pop || !window.PWChatMode) return;
  liveChatModeUi = PWChatMode.mount(pop, (patch) => liveSocket?.emit('chat:set-mode', patch));
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => pop.classList.add('hidden'));
})();

function applyLiveRestriction(r) {
  clearInterval(liveRestrictTimer);
  const form = document.getElementById('liveChatForm');
  const box = document.getElementById('liveChatBlocked');
  if (!form || !box) return;

  const free = () => { box.classList.add('hidden'); form.classList.remove('hidden'); };
  if (!r || r.type === 'none') return free();

  form.classList.add('hidden');
  box.classList.remove('hidden');

  if (r.type === 'ban') {
    box.textContent = t('streamer.chat.banned');
    return;
  }

  if (r.type === 'followers') {
    box.innerHTML = '';
    const text = document.createElement('div');
    box.appendChild(text);
    if (!r.until) {
      text.textContent = t('streamer.chat.followersOnly'); // кнопка «Подписаться» — сразу под этим блоком
      return;
    }
    const until = new Date(r.until).getTime();
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) { clearInterval(liveRestrictTimer); liveSocket?.emit('chat:check'); return; }
      text.textContent = t('streamer.chat.followersWait') + ' ' + fmtHMS(left);
    };
    tick();
    liveRestrictTimer = setInterval(tick, 1000);
    return;
  }

  const until = new Date(r.until).getTime();
  const tick = () => {
    const left = until - Date.now();
    if (left <= 0) { clearInterval(liveRestrictTimer); free(); return; }
    box.textContent = t('streamer.chat.timedOut') + ' ' + fmtHMS(left);
  };
  tick();
  liveRestrictTimer = setInterval(tick, 1000);
}

window.addEventListener('pw:langchange', (e) => liveSocket?.emit('lang:set', e.detail.lang)); // язык ответов бота
function connectLiveChat(nameLower) {
  liveSocket = io('/chat', { reconnection: false, transports: ['websocket', 'polling'], tryAllTransports: true }); // сразу WebSocket: чат появляется на 1–2 круга к серверу раньше

  liveSocket.on('chat:history', (messages) => {
    document.getElementById('liveMessages').innerHTML = '';
    messages.forEach(renderLiveMessage);
  });
  liveSocket.on('chat:message', renderLiveMessage);
  liveSocket.on('chat:message-deleted', ({ messageId }) => {
    document.querySelectorAll(`[data-id="${messageId}"]`).forEach((row) => {
      if (row._msg) row._msg.deleted = true;
      row.innerHTML = `<span style="color:var(--text-muted);font-style:italic;">${t('common.chat.deleted')}</span>`;
    });
  });
  liveSocket.on('chat:cleared', () => { document.getElementById('liveMessages').innerHTML = ''; });
  liveSocket.on('chat:restriction', applyLiveRestriction);
  liveSocket.on('chat:mode', (mode = {}) => {
    liveMode = mode;
    renderModeBadges();
    liveChatModeUi?.set(mode);
    document.getElementById('liveChatModeBtn')?.classList.toggle('on', PWChatMode.isActive(mode));
  });
  liveSocket.on('chat:role', (rp) => applyLiveRole(rp));
  // рейд: плашка с отсчётом; по сигналу сервера — переход на чужой эфир (кроме стримера и тех, кто «Остаться»)
  liveSocket.on('chat:raid', (ev) => {
    raidStay = false;
    raidBar = PWRaid.banner(document.getElementById('liveRaidSlot'), ev, {
      canCancel: canDo('raid'),
      onCancel: () => liveSocket?.emit('chat:raid-cancel'),
      onStay: () => { raidStay = true; },
    });
  });
  liveSocket.on('chat:raid-cancelled', () => {
    raidBar?.destroy();
    raidBar = null;
    PW.toast(t('common.raid.cancelled'), 'info');
  });
  liveSocket.on('chat:raid-go', ({ to, from } = {}) => {
    raidBar?.destroy();
    raidBar = null;
    if (raidStay || isOwnerFlag || !to) return;
    location.href = '/streamers/' + encodeURIComponent(to) + '?raid=' + encodeURIComponent(from || '');
  });
  liveSocket.on('chat:raid-error', ({ error } = {}) => PW.toast(error || t('common.requestFailed'), 'error'));
  liveSocket.on('chat:raided', (raid) => PWRaid.raided(document.getElementById('liveRaidSlot'), raid));
  liveSocket.on('chat:slow', ({ wait } = {}) => startSlowCountdown(wait));
  liveSocket.on('chat:cmd-result', ({ ok, text } = {}) => PW.toast(text || t('common.requestFailed'), ok ? 'success' : 'error'));

  liveSocket.on('chat:viewers', (payload) => {
    if (typeof payload === 'number') {
      setViewersCount(payload);
      return;
    }
    setViewersCount(payload?.count ?? 0);
    renderViewersList(payload?.viewers || []);
  });

  liveSocket.on('connect', () => {
    liveChatReconnect?.reset();
    liveSocket.emit('chat:join', { streamerName: nameLower });
  });
  liveSocket.on('disconnect', () => liveChatReconnect?.start());

  liveChatReconnect = createReconnectScheduler(
    () => new Promise((resolve) => {
      liveSocket.connect();
      liveSocket.once('connect', () => resolve(true));
      setTimeout(() => resolve(liveSocket.connected), 1500);
    }),
    () => {}
  );
}

// kind: 'chat' (по умолчанию), 'follow' или 'clip' — меняется только заголовок и текст окна
function openLiveAuthModal(kind) {
  const pre = ['follow', 'clip', 'points'].includes(kind) ? kind : '';
  const key = (k) => 'streamer.auth.' + (pre ? pre + k[0].toUpperCase() + k.slice(1) : k);
  for (const [id, k] of [['liveAuthTitle', 'title'], ['liveAuthText', 'text']]) {
    const key2 = key(k);
    const el = document.getElementById(id);
    if (!el) continue;
    el.setAttribute('data-i18n', key2); // при смене языка перевод возьмёт этот ключ
    el.textContent = t(key2);
  }
  document.getElementById('liveAuthModal')?.classList.remove('hidden');
}
function closeLiveAuthModal() { document.getElementById('liveAuthModal')?.classList.add('hidden'); }
document.getElementById('liveAuthModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'liveAuthModal') closeLiveAuthModal();
});
document.getElementById('liveAuthModalClose')?.addEventListener('click', closeLiveAuthModal);
document.getElementById('liveAuthLoginBtn')?.addEventListener('click', () => {
  location.href = '/?returnTo=' + encodeURIComponent(location.pathname);
});
document.getElementById('liveAuthRegisterBtn')?.addEventListener('click', () => {
  location.href = '/?mode=register&returnTo=' + encodeURIComponent(location.pathname);
});

document.getElementById('liveChatInput')?.addEventListener('focus', (e) => {
  if (!liveIsAuthed) { e.target.blur(); openLiveAuthModal(); }
});

document.getElementById('liveChatForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!liveIsAuthed) { openLiveAuthModal(); return; }
  const input = document.getElementById('liveChatInput');
  const text = input.value.trim();
  if (!text || !liveSocket) return;
  liveSocket.emit('chat:send', { text });
  input.value = '';
});

// ---------- инициализация страницы ----------

function showPage() {
  document.getElementById('notFound').classList.add('hidden');
  document.getElementById('pageContent').classList.remove('hidden');
}

function showNotFound() {
  document.getElementById('pageContent').classList.add('hidden');
  document.getElementById('notFound').classList.remove('hidden');
}

// ---- предпросмотр из PRO-редактора: /streamers/<имя>?preview=1, открытый вкладкой редактора ----
// Макет приходит сообщением только от окна, которое нас открыло, и только с нашего сайта.
// На сервер и в кэш он не попадает; пока он есть, сохранённый макет его не перебивает
const PREVIEW = new URLSearchParams(location.search).get('preview') === '1' && !!window.opener;
let previewLayout = null;

function applyLayout(layout) {
  window.PWProView?.apply(previewLayout || layout, hasMedia());
}

if (PREVIEW) {
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.opener || e.data?.type !== 'pw-preview-layout') return;
    if (!e.data.layout || typeof e.data.layout !== 'object') return;
    previewLayout = e.data.layout;
    applyLayout(null);
    if (!document.getElementById('pwPreviewBadge')) {
      const badge = document.createElement('div');
      badge.id = 'pwPreviewBadge';
      badge.className = 'pw-preview-badge';
      badge.textContent = t('streamer.previewBadge');
      document.body.appendChild(badge);
    }
  });
}

async function loadProfile() {
  const nameLower = getNameFromUrl();
  if (!nameLower) return showNotFound();
  const enc = encodeURIComponent(nameLower);

  const ownerP = checkOwnership(nameLower);      // идёт параллельно со всем остальным
  loadFollowState();                             // тоже параллельно: число подписчиков и «подписан ли я»
  const cached = await PWCache.get(nameLower);

  // 1) мгновенно рисуем из кэша (isLive там нет: он всегда свежий)
  if (cached) {
    currentStreamer = { ...cached.streamer };
    renderProfile(currentStreamer);
    applyVods(cached.vods);
    if (cached.layout) applyLayout(cached.layout);
    showPage();
  }

  // 2) параллельно: сверка версии и записи
  api('/streamers/' + enc + '/clips').then(applyClips).catch((e) => console.warn('[clips]', e.message));
  const vodsP = api('/streamers/' + enc + '/vods').catch((e) => {
    console.warn('[vods]', e.message);
    return null;
  });

  let b;
  try {
    const q = cached && Number.isFinite(cached.rev) ? '?rev=' + cached.rev : '';
    b = await api('/streamers/' + enc + '/bundle' + q);
  } catch (err) {
    console.warn('[loadProfile]', err.message);
    if (!cached || err.status === 404) {
      if (cached) PWCache.del(nameLower);
      showNotFound();
    }
    return; // нет сети, но есть кэш: оставляем показанное
  }

  const live = { isLive: !!b.isLive, streamPlaybackId: b.streamPlaybackId || null, title: b.title || '', category: b.category || null };
  const same = !!(b.unchanged && cached);
  const stat = same
    ? { streamer: cached.streamer, layout: cached.layout }
    : {
        streamer: {
          streamerName: b.streamerName,
          streamerBio: b.streamerBio || '',
          streamerAvatarUrl: b.streamerAvatarUrl || null,
          streamerBannerUrl: b.streamerBannerUrl || null,
        },
        layout: b.layout || null,
      };

  currentStreamer = { ...stat.streamer, ...live };
  renderLiveInfo();

  if (same) {
    // данные те же: перерисовывать нечего, обновляем только бейдж «В ЭФИРЕ»
    document.getElementById('liveBadge')?.classList.toggle('hidden', !live.isLive);
  } else {
    if (window.PWProView?.active && !stat.layout && !previewLayout) {
      // макет сбросили: проще перезагрузить, кэш к этому моменту уже обновлён
      await PWCache.set(nameLower, { rev: b.rev, ...stat, vods: cachedVods });
      location.reload();
      return;
    }
    renderProfile(currentStreamer);
    if (stat.layout) applyLayout(stat.layout);
    showPage();
  }

  // 3) эфир открываем, когда уже известен владелец (нужно для кнопок модерации); плеер качаем уже сейчас
  if (live.isLive) loadHls();
  await ownerP;
  if (live.isLive && live.streamPlaybackId && !liveOpen) setTimeout(openLiveStrip, 120);

  // 4) записи и обновление кэша
  const vods = await vodsP;
  if (vods) applyVods(vods);
  PWCache.set(nameLower, { rev: b.rev, streamer: stat.streamer, layout: stat.layout, vods: cachedVods });
  if (PREVIEW) window.opener.postMessage({ type: 'pw-preview-ready' }, location.origin);
}

let liveStatusPollTimer = null;

async function pollStreamerLiveStatus() {
  const nameLower = getNameFromUrl();
  if (!nameLower) return;

  try {
    // лёгкий запрос — тот же профиль, но без лишнего UI
    const data = await api('/streamers/' + encodeURIComponent(nameLower) + '/live-status');
    // profileViews++ при каждом poll плохо — лучше отдельный endpoint (см. ниже)
    const wasLive = !!(currentStreamer?.isLive && currentStreamer?.streamPlaybackId);
    const nowLive = !!(data.isLive && data.streamPlaybackId);

    currentStreamer = { ...currentStreamer, ...data };
    document.getElementById('liveBadge')?.classList.toggle('hidden', !data.isLive);
    renderLiveInfo();

    if (nowLive !== wasLive && !isOwnerFlag) {
      if (!nowLive) scheduleBonus(); // эфир кончился — бонус прячем сразу, не ждём ответа сервера
      setTimeout(loadPoints, 1500);
    }
    if (nowLive && !wasLive) {
      // стрим только что начался — открыть плеер без F5
      if (!liveOpen) openLiveStrip();
      else {
        // уже открыт офлайн-экран — перезапустить сессию
        stopLiveSession();
        startLiveSession();
      }
    } else if (!nowLive && wasLive) {
      // эфир кончился — показать «Эфира нет», чат можно оставить
      const video = document.getElementById('liveVideo');
      const offline = document.getElementById('liveOffline');
      if (liveHls) {
        try { liveHls.destroy(); } catch (_) {}
        liveHls = null;
      }
      if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
        video.classList.add('hidden');
      }
      offline?.classList.remove('hidden');
      document.getElementById('liveOverlay')?.classList.add('hidden');
    }
  } catch (e) {
    console.warn('[pollStreamerLiveStatus]', e.message);
  }
}

// в свёрнутой вкладке не опрашиваем (запрос раз в 5 с от каждого зрителя), при возврате — сразу свежий статус
function startStreamerLivePolling() {
  clearInterval(liveStatusPollTimer);
  liveStatusPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pollStreamerLiveStatus();
  }, 5000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && liveStatusPollTimer) pollStreamerLiveStatus();
});

function makeLiveDraggable(el, storageKey) {
  if (!el) return;

  const container = document.getElementById('livePlayerWrap');
  if (!container) return;

  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_THRESHOLD = 6;

  let longPressTimer = null;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function currentMode() {
    return liveIsFullscreen() ? 'fullscreen' : 'normal';
  }

  function storageFullKey() {
    return `pw-pos:live:${storageKey}:${currentMode()}`;
  }

  function resetPosition() {
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
  }

  // позиция хранится долей свободного места (0..1), а не пикселями: плеер меняет размер (окно, панель чата,
  // раскрытие эфира, догрузка страницы), и сохранённые пиксели «не влезали» — кнопка уходила на место по умолчанию
  function freeSpace() {
    const p = container.getBoundingClientRect();
    return { fw: p.width - (el.offsetWidth || 40), fh: p.height - (el.offsetHeight || 40) };
  }

  function applySavedPosition() {
    if (dragging) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageFullKey()) || 'null'); } catch (_) {}
    if (!saved) { resetPosition(); return; }

    const { fw, fh } = freeSpace();
    if (fw <= 0 || fh <= 0) return; // плеер скрыт или ещё раскрывается — применим, когда вырастет (ResizeObserver)

    let { fx, fy } = saved;
    if (typeof fx !== 'number' || typeof fy !== 'number') {
      if (typeof saved.left !== 'number' || typeof saved.top !== 'number') { resetPosition(); return; }
      fx = saved.left / fw; // старый формат — пиксели
      fy = saved.top / fh;
    }
    // не влезает — прижимаем к краю, а не сбрасываем
    el.style.left = Math.round(Math.min(1, Math.max(0, fx)) * fw) + 'px';
    el.style.top = Math.round(Math.min(1, Math.max(0, fy)) * fh) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function savePosition(left, top) {
    const { fw, fh } = freeSpace();
    if (fw <= 0 || fh <= 0) return;
    const fx = Math.round((left / fw) * 10000) / 10000;
    const fy = Math.round((top / fh) * 10000) / 10000;
    try { localStorage.setItem(storageFullKey(), JSON.stringify({ fx, fy })); } catch (_) {}
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    moved = false;
    dragging = false;

    // на тач-устройствах drag отключаем (как в room.js)
    const isTouchUI =
      window.matchMedia('(pointer: coarse)').matches ||
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      window.innerWidth <= 768;
    if (isTouchUI) return;

    const rect = el.getBoundingClientRect();
    const parentRect = container.getBoundingClientRect();
    origLeft = rect.left - parentRect.left;
    origTop = rect.top - parentRect.top;
    startX = e.clientX;
    startY = e.clientY;

    longPressTimer = setTimeout(() => {
      dragging = true;
      el.classList.add('dragging');
      el.style.touchAction = 'none';
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) {
      if (
        Math.abs(e.clientX - startX) > MOVE_CANCEL_THRESHOLD ||
        Math.abs(e.clientY - startY) > MOVE_CANCEL_THRESHOLD
      ) {
        clearTimeout(longPressTimer);
      }
      return;
    }

    moved = true;
    e.preventDefault();

    const parentRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let newLeft = origLeft + (e.clientX - startX);
    let newTop = origTop + (e.clientY - startY);

    newLeft = Math.max(0, Math.min(newLeft, parentRect.width - elRect.width));
    newTop = Math.max(0, Math.min(newTop, parentRect.height - elRect.height));

    el.style.left = newLeft + 'px';
    el.style.top = newTop + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });

  function endDrag() {
    clearTimeout(longPressTimer);
    if (!dragging) return;

    dragging = false;
    el.classList.remove('dragging');
    el.style.touchAction = '';

    if (moved) {
      savePosition(parseFloat(el.style.left), parseFloat(el.style.top));
      // гасим следующий click после drag
      const suppressNextClick = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
        el.removeEventListener('click', suppressNextClick, true);
      };
      el.addEventListener('click', suppressNextClick, true);
    }
  }

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  const onFsForPos = () => requestAnimationFrame(applySavedPosition);
  document.addEventListener('fullscreenchange', onFsForPos);
  document.addEventListener('webkitfullscreenchange', onFsForPos);
  window.addEventListener('resize', applySavedPosition);
  if (window.ResizeObserver) new ResizeObserver(() => applySavedPosition()).observe(container);
  applySavedPosition();
}

try {
  makeLiveDraggable(document.getElementById('liveFullscreenBtn'), 'fullscreenBtn');
  makeLiveDraggable(document.getElementById('liveVolumeBtn'), 'volumeBtn');
  makeLiveDraggable(document.getElementById('liveQualityBtn'), 'qualityBtn');
  makeLiveDraggable(document.getElementById('liveChatToggleBtn'), 'chatToggleBtn');
} catch (e) {
  console.error('[makeLiveDraggable]', e);
}

applyVolumeToLive(getSavedVolume());

// ---- мини-окно (Picture-in-Picture): тот же <video>, без второго потока ----
(function initLiveMini() {
  const video = document.getElementById('liveVideo');
  const btn = document.getElementById('liveMiniBtn');
  if (!video || !btn || !window.PWMini || !PWMini.pipSupported()) return;

  const sync = () => {
    const on = document.pictureInPictureElement === video;
    btn.classList.toggle('active', on);
    btn.textContent = on ? '↩' : '⧉';
    btn.title = on ? t('streamer.live.backToPlayer') : t('common.mini.pip');
  };

  // кнопка видна, только пока в плеере реально есть эфир
  video.addEventListener('loadedmetadata', () => btn.classList.remove('hidden'));
  video.addEventListener('emptied', () => btn.classList.add('hidden'));
  video.addEventListener('enterpictureinpicture', sync);
  video.addEventListener('leavepictureinpicture', sync);

  btn.addEventListener('click', async () => {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture().catch(() => {});
      return;
    }
    const err = await PWMini.enterPip({
      video,
      streamer: getNameFromUrl(),
      returnPath: location.pathname,
    });
    if (err) console.warn('[mini]', err);
  });
})();

// ---- кнопки модерации в чате: данные в data-атрибутах, а не в onclick ----
document.getElementById('liveMessages')?.addEventListener('click', (e) => {
  const masked = e.target.closest('.live-masked');
  if (masked) {
    const row = masked.closest('#liveMessages > div');
    PW.confirm(t('streamer.chat.revealText'), { title: t('streamer.chat.revealTitle'), okText: t('streamer.chat.revealOk') }).then((ok) => {
      if (!ok || !row?._msg) return;
      row._msg.revealed = true;
      row.innerHTML = buildLiveMessageHtml(row._msg);
    });
    return;
  }
  const btn = e.target.closest('.live-mod-btn');
  if (!btn) return;
  const { act, id, uid, name } = btn.dataset;
  if (act === 'del') liveDeleteMessage(id);
  else if (act === 'ban') liveBanUser(uid, name);
  else if (act === 'timeout') liveTimeoutUser(uid, name);
});

// ---- не даём экрану и компьютеру уснуть, пока идёт эфир ----
setInterval(() => {
  const v = document.getElementById('liveVideo');
  const playing = !!v && liveOpen && !v.classList.contains('hidden') && !v.paused && !v.ended && v.readyState > 2;
  window.PWWake?.set('live', playing);
}, 4000);

loadProfile();
startStreamerLivePolling();

// ---------- 🚩 жалоба на эфир (POST /support/stream-report → админка: Обращения → 🚩 Эфиры) ----------
// скриншоты-доказательства (до 5); при «угрозе детям» — без картинок, только описание (сервер тоже не примет)
let reportAttach = null;
function syncReportAttach() {
  const minors = document.getElementById('reportReason').value === 'minors';
  reportAttach?.setEnabled(!minors);
  document.getElementById('reportMinorsHint').classList.toggle('hidden', !minors);
}
function openReport() {
  if (!liveIsAuthed) {
    PW.toast(t('streamer.report.needLogin'), 'info');
    return;
  }
  document.getElementById('reportError').classList.add('hidden');
  document.getElementById('reportText').value = '';
  if (!reportAttach && window.PWAttach) {
    reportAttach = PWAttach.create(document.getElementById('reportAttach'), { max: 5, pasteRoot: document.getElementById('reportModal') });
  }
  reportAttach?.clear();
  syncReportAttach();
  document.getElementById('reportModal').classList.remove('hidden');
}
function closeReport() {
  document.getElementById('reportModal').classList.add('hidden');
}
async function sendReport() {
  const btn = document.getElementById('reportSendBtn');
  const err = document.getElementById('reportError');
  err.classList.add('hidden');
  if (reportAttach?.busy()) {
    err.textContent = t('common.attach.wait');
    err.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  try {
    await api('/support/stream-report', {
      method: 'POST',
      body: {
        streamer: getNameFromUrl(),
        reason: document.getElementById('reportReason').value,
        description: document.getElementById('reportText').value,
        files: reportAttach ? reportAttach.files() : [],
      },
    });
    closeReport();
    PW.toast(t('streamer.report.sent'), 'success');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}
document.getElementById('liveReportBtn')?.addEventListener('click', openReport);
document.getElementById('reportReason')?.addEventListener('change', syncReportAttach);
document.getElementById('reportModal')?.addEventListener('click', (e) => { if (e.target.id === 'reportModal') closeReport(); });

