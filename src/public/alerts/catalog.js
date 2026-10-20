// Каталог алертов (студия → 🔔 События, оверлей OBS /overlay/alerts.html): события, встроенные анимации,
// звуки и анимации текста. Общий для сервера (проверка настроек) и браузера (студия, оверлей)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PWAlertCatalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // события: vars — переменные надписи, sample — пример для «Проверить», param — порог (если есть)
  const EVENTS = [
    { id: 'follow', icon: '❤', vars: ['name'], sample: { name: 'Viewer123' }, on: true, anim: 'hearts', sound: 'chime' },
    { id: 'raid', icon: '🚀', vars: ['streamer', 'viewers'], sample: { streamer: 'Neyrite', viewers: 12 }, on: true, anim: 'rocket', sound: 'fanfare' },
    { id: 'reward', icon: '🎁', vars: ['name', 'reward', 'cost', 'message'], sample: { name: 'Viewer123', reward: '🎁 Bonus', cost: 200, message: 'GG!' }, on: true, anim: 'gift', sound: 'magic' },
    { id: 'clip', icon: '✂', vars: ['name', 'title'], sample: { name: 'Viewer123', title: 'GG!' }, on: false, anim: 'stars', sound: 'shutter' },
    { id: 'firstChat', icon: '👋', vars: ['name', 'message'], sample: { name: 'NewViewer', message: '👋' }, on: false, anim: 'balloons', sound: 'pop' },
    { id: 'viewers', icon: '👀', vars: ['count'], sample: { count: 25 }, on: false, anim: 'fireworks', sound: 'levelup' },
    { id: 'followGoal', icon: '🏆', vars: ['count'], sample: { count: 100 }, on: false, anim: 'trophy', sound: 'victory' },
    { id: 'hype', icon: '🔥', vars: ['count'], sample: { count: 30 }, on: false, anim: 'fire', sound: 'drumroll', param: { def: 20, min: 5, max: 500 } },
    { id: 'emoteCombo', icon: '😂', vars: ['emote', 'count'], sample: { emote: 'hype', count: 5 }, on: false, anim: 'party', sound: 'boing', param: { def: 5, min: 3, max: 50 } },
    { id: 'command', icon: '⌨', vars: ['name', 'command'], sample: { name: 'Viewer123', command: '!roll' }, on: false, anim: 'sparkles', sound: 'blip' },
    { id: 'ban', icon: '🔨', vars: ['name'], sample: { name: 'Spammer' }, on: false, anim: 'lightning', sound: 'thunder' },
    { id: 'pointsGoal', icon: '💰', vars: ['name', 'points'], sample: { name: 'Viewer123', points: 1000 }, on: false, anim: 'coins', sound: 'coin', param: { def: 1000, min: 100, max: 1000000 } },
    { id: 'mod', icon: '🛡', vars: ['name'], sample: { name: 'helper' }, on: false, anim: 'crown', sound: 'bell' },
    // зритель поделился серией просмотров (services/streaks): count — сколько эфиров подряд
    { id: 'streak', icon: '🔥', vars: ['name', 'count', 'message'], sample: { name: 'Viewer123', count: 10, message: 'GG!' }, on: true, anim: 'fire', sound: 'levelup' },
  ];

  // анимации: эмодзи-частицы и большой значок в центре. kind — как летят частицы
  const ANIMS = [
    { id: 'confetti', kind: 'burst', icon: '🎉', parts: ['🎊', '✨', '🎉', '⭐'] },
    { id: 'fireworks', kind: 'burst', icon: '🎆', parts: ['💥', '✨', '🎇', '⭐'] },
    { id: 'hearts', kind: 'rise', icon: '💜', parts: ['❤️', '💖', '💜', '💗'] },
    { id: 'stars', kind: 'orbit', icon: '🌟', parts: ['⭐', '✨', '🌟'] },
    { id: 'rocket', kind: 'fly', icon: '🚀', parts: ['💨', '✨', '🔥'] },
    { id: 'coins', kind: 'rain', icon: '💰', parts: ['💰', '💵', '✨'] },
    { id: 'trophy', kind: 'pulse', icon: '🏆', parts: ['✨', '⭐', '🎉'] },
    { id: 'fire', kind: 'rise', icon: '🔥', parts: ['🔥', '💥', '🔥'] },
    { id: 'balloons', kind: 'rise', icon: '🎈', parts: ['🎈', '🎈', '🎈', '🎉'] },
    { id: 'sparkles', kind: 'twinkle', icon: '✨', parts: ['✨', '💫', '⭐'] },
    { id: 'rainbow', kind: 'wave', icon: '🌈', parts: ['🌈', '☁️', '✨'] },
    { id: 'crown', kind: 'drop', icon: '👑', parts: ['✨', '💎', '⭐'] },
    { id: 'gift', kind: 'shake', icon: '🎁', parts: ['🎊', '✨', '🎉', '💝'] },
    { id: 'lightning', kind: 'flash', icon: '⚡', parts: ['⚡', '💥'] },
    { id: 'party', kind: 'burst', icon: '🥳', parts: ['🎉', '🎊', '🥳', '🎈'] },
    { id: 'music', kind: 'wave', icon: '🎵', parts: ['🎵', '🎶', '🎼'] },
    { id: 'bubbles', kind: 'rise', icon: '💧', parts: ['💧', '💦', '⚪'] },
    { id: 'snow', kind: 'rain', icon: '❄️', parts: ['❄️', '❄️', '✨'] },
    { id: 'diamond', kind: 'spin', icon: '💎', parts: ['💎', '✨', '💠'] },
    { id: 'clap', kind: 'bounce', icon: '👏', parts: ['👏', '🙌', '✨'] },
  ];

  // звуки — синтез в браузере (WebAudio), без файлов: id → рецепт в alerts/render.js
  const SOUNDS = ['chime', 'fanfare', 'coin', 'pop', 'whoosh', 'laser', 'levelup', 'magic', 'drumroll', 'bell',
    'boing', 'blip', 'victory', 'thunder', 'shutter', 'bubble', 'siren', 'jump', 'success', 'harp'];

  const TEXT_ANIMS = ['pop', 'fade', 'slideUp', 'slideDown', 'zoom', 'bounce', 'wave', 'typewriter', 'shake', 'glow', 'rainbow', 'flip', 'jelly', 'letters'];

  const DEFAULTS = { volume: 70, textAnim: 'pop', color: '#ffffff', accent: '#c4b5fd', tts: false, sec: 6 };
  const SEC_MIN = 3, SEC_MAX = 10;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const MEDIA_RE = /^media:[a-f0-9]{24}$/i;

  const eventById = (id) => EVENTS.find((e) => e.id === id) || null;

  // настройки одного события: всё лишнее и неверное отбрасывается, время — в пределах 3–10 с
  function cleanEvent(id, raw) {
    const ev = eventById(id);
    if (!ev) return null;
    const r = raw && typeof raw === 'object' ? raw : {};
    const anim = ANIMS.some((a) => a.id === r.anim) || MEDIA_RE.test(r.anim || '') ? r.anim : ev.anim;
    const sound = r.sound === 'none' || SOUNDS.includes(r.sound) || MEDIA_RE.test(r.sound || '') ? r.sound : ev.sound;
    const num = (v, min, max, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    const out = {
      on: typeof r.on === 'boolean' ? r.on : ev.on,
      anim,
      sound,
      volume: num(r.volume, 0, 100, DEFAULTS.volume),
      text: String(r.text || '').slice(0, 200),
      textAnim: TEXT_ANIMS.includes(r.textAnim) ? r.textAnim : DEFAULTS.textAnim,
      color: COLOR_RE.test(r.color || '') ? r.color : DEFAULTS.color,
      accent: COLOR_RE.test(r.accent || '') ? r.accent : DEFAULTS.accent,
      tts: !!r.tts,
      sec: num(r.sec, SEC_MIN, SEC_MAX, DEFAULTS.sec),
    };
    if (ev.param) out.param = num(r.param, ev.param.min, ev.param.max, ev.param.def);
    return out;
  }

  return { EVENTS, ANIMS, SOUNDS, TEXT_ANIMS, DEFAULTS, SEC_MIN, SEC_MAX, eventById, cleanEvent };
});
