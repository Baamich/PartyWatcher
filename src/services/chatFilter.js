// chatFilter.js — фильтр слов в чате эфира по уровню, который выбирает стример (или модератор с правом):
// 0 — выкл, 1 — слабо (только самый грубый мат), 2 — средне (+ оскорбления), 3 — сильно (+ грубые слова),
// 4 — очень сильно (+ мягкие оскорбления). Уровень включает все слабее. Найденные слова → «****».
// Это вежливый фильтр для зрителя, а не цензура: оригинал уходит вместе с маской, зритель может его открыть.
// Слова сверяются по «скелетам», как в services/profanity.js (кириллица → латиница, лит-замены, двойники букв)
const { toLatin, skeletons, prep, strip } = require('./profanity');

const LEVELS = [0, 1, 2, 3, 4];

// any — основа где угодно в слове, start — только с начала, exact — слово целиком; en — только для слов латиницей
const TIERS = [
  null,
  { // 1 — слабо: мат
    any: ['pizd', 'pisd', 'pezd', 'bliat', 'bliad', 'ebat', 'ebal', 'eban', 'ebuch', 'eblan', 'eblo', 'ebnu', 'ebash',
      'zaeb', 'uebok', 'uebi', 'dolbaeb', 'dolboeb', 'vieb', 'huev', 'hues', 'huil', 'huin', 'huep', 'huet', 'huen', 'huel',
      'nahui', 'pohui', 'ohuit', 'ohuen'],
    start: ['hui', 'blia', 'ebu', 'ebi'],
    exact: ['eb'],
    en: { any: ['fuck', 'fuk', 'cunt', 'motherf'], start: ['fck'] },
  },
  { // 2 — средне: оскорбления
    any: ['mudak', 'mudil', 'mudoz', 'pidor', 'pidar', 'pidr', 'pederas', 'gandon', 'gondon', 'zalup', 'shluh', 'shliuh',
      'otsos', 'mraz', 'sukin', 'suchar', 'tvar', 'debil', 'dauni', 'shalav'],
    start: ['suka', 'suchk', 'suki', 'manda', 'chmo', 'urod'],
    exact: [],
    en: { any: ['bitch', 'asshol', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'retard', 'wanker', 'bastard'], start: ['fag'] },
  },
  { // 3 — сильно: грубые слова
    any: ['govn', 'gavn', 'dermo', 'zasran', 'obosr', 'nasral', 'dristn', 'peden', 'zadnic'],
    start: ['zhop', 'sran', 'srat', 'ssat', 'ssan', 'perd', 'sisk'],
    exact: [],
    en: { any: ['shit', 'crap', 'piss', 'dick', 'cock', 'pussy', 'bullsh'], start: ['damn'] },
  },
  { // 4 — очень сильно: мягкие оскорбления
    any: ['idiot', 'kretin', 'tupic', 'tupor', 'pridur', 'ublud', 'nedonos', 'loshar', 'lohush'],
    start: ['durak', 'dura', 'tupoi', 'tupai', 'tupi', 'loh', 'kozel', 'kozl', 'bydl', 'chert', 'gad', 'svoloch', 'skotin', 'dibil'],
    exact: [],
    en: { any: ['idiot', 'stupid', 'moron', 'loser', 'dumbass', 'jerk'], start: ['dumb', 'sucks'] },
    cyrOnly: true, // «дура», «гад» латиницей — это durable, gadget
  },
].map((t) => t && {
  cyrOnly: !!t.cyrOnly,
  any: prep(t.any), start: prep(t.start), exact: new Set(prep(t.exact)),
  enAny: prep(t.en.any), enStart: prep(t.en.start),
});

// безобидные слова с «опасным» началом (повторы букв в скелете схлопнуты, поэтому основы — не короче 4 букв)
const SOFT_ALLOW = prep(['gadal', 'gadat', 'gadai', 'gadan', 'gadk', 'lohm', 'loha', 'chertezh', 'chertit', 'cherta', 'cherti',
  'durach', 'kozelok', 'damnat', 'dickens', 'cockpit', 'peacock', 'perdu']);

function tierHit(sk, latinOnly, t) {
  if (t.cyrOnly && latinOnly) return t.enAny.some((r) => sk.includes(r)) || t.enStart.some((r) => sk.startsWith(r));
  if (t.exact.has(sk)) return true;
  if (t.any.some((r) => sk.includes(r))) return true;
  if (t.start.some((r) => sk.startsWith(r))) return true;
  if (latinOnly && (t.enAny.some((r) => sk.includes(r)) || t.enStart.some((r) => sk.startsWith(r)))) return true;
  return false;
}

function wordHits(raw, level) {
  const latin = toLatin(raw).replace(/[^a-z]/g, '');
  if (!latin) return false;
  const latinOnly = !/[а-яёіїєґ]/i.test(raw);
  for (const sk0 of skeletons(latin)) {
    const sk = strip(sk0);
    if (SOFT_ALLOW.some((a) => sk.startsWith(a))) continue;
    for (let i = 1; i <= level; i++) if (tierHit(sk, latinOnly, TIERS[i])) return true;
  }
  return false;
}

// текст → текст с «****» вместо найденных слов, или null, если менять нечего
function mask(text, level) {
  level = Number(level) || 0;
  if (!level || !text) return null;
  const src = String(text);
  const tokens = [];
  const re = /[\p{L}\p{N}@$!|€*]+/gu;
  let m;
  while ((m = re.exec(src))) tokens.push({ s: m.index, e: m.index + m[0].length, w: m[0] });

  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    // «б л я т ь», «х.у.й»: подряд идущие одиночные буквы — одним словом
    if (tokens[i].w.length === 1) {
      let j = i;
      while (j + 1 < tokens.length && tokens[j + 1].w.length === 1 && tokens[j + 1].s - tokens[j].e <= 2) j++;
      if (j > i) {
        const joined = tokens.slice(i, j + 1).map((x) => x.w).join('');
        if (wordHits(joined, level) || (joined.includes('3') && wordHits(joined.replace(/3/g, 'з'), level))) {
          spans.push([tokens[i].s, tokens[j].e]);
        }
        i = j;
        continue;
      }
    }
    const w = tokens[i].w;
    if (wordHits(w, level) || (w.includes('3') && wordHits(w.replace(/3/g, 'з'), level))) spans.push([tokens[i].s, tokens[i].e]);
  }
  if (!spans.length) return null;
  let out = '', pos = 0;
  for (const [s, e] of spans) {
    out += src.slice(pos, s) + '*'.repeat(Math.min(8, Math.max(3, e - s)));
    pos = e;
  }
  return out + src.slice(pos);
}

module.exports = { mask, LEVELS };
