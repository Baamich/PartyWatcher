// services/profanity.js — мат и грубые оскорбления в названиях комнат, логинах и именах стримеров.
// Слово приводится к «скелету»: кириллица → латиница, лит-замены (0→o, 3→e, @→a…), латинские двойники
// русских букв (cyka, xyй), повторы букв схлопываются. Скелет сверяется с основами (тоже скелетами).
// Разбивку пробелами и точками ловим склейкой: подряд идущие одиночные буквы («б л я т ь», «х.у.й») — в одно слово,
// соседние слова, если одно из них короткое («pi zda», «долба ёб»), — проверяются ещё и вместе.
// Английские основы проверяем только в словах латиницей: иначе «шить» (shit), «сунь» и т.п. попадут под запрет.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g',
};
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'b', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e' };

const toLatin = (text) => String(text || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[а-яёіїєґ]/g, (ch) => CYR[ch] ?? ch)
  .replace(/[0-9@$!|€]/g, (ch) => LEET[ch] ?? ch);

// латинские буквы одного слова → скелеты. «y» — и двойник «у» (cyka = сука), и транслит «ы/й»: два прочтения
function skeletons(word) {
  const base = word
    .replace(/ch/g, 'C') // «ч» не путаем с «ш» после c→s (сучка ≠ сушка)
    .replace(/kh/g, 'h').replace(/x/g, 'h')
    .replace(/ck/g, 'k').replace(/q/g, 'k').replace(/w/g, 'v').replace(/ph/g, 'f')
    .replace(/c/g, 's'); // латинская «c» — двойник «с»
  const fin = (t) => t.replace(/j[oe]/g, 'e').replace(/j/g, 'i').replace(/(.)\1+/g, '$1');
  return [
    fin(base.replace(/y[oe]/g, 'e').replace(/y/g, 'i')), // y — транслит: yob → eb, blyat → bliat
    fin(base.replace(/y/g, 'u')), // y — двойник «у»: cyka → suka, xyета → hueta
  ];
}
const prep = (list) => [...new Set(list.flatMap((w) => skeletons(toLatin(w))))];

// основы внутри слова (специфичные — ложных совпадений мало)
const RU_ANY = prep([
  'pizd', 'pisd', 'pezd', 'bliat', 'bliad', 'ebat', 'ebal', 'eban', 'ebuch', 'eblan', 'eblo', 'ebnu', 'ebash', 'zaeb',
  'uebok', 'uebi', 'dolbaeb', 'dolboeb', 'vieb', 'mudak', 'mudil', 'mudoz', 'pidor', 'pidar', 'pidr', 'pederas',
  'gandon', 'gondon', 'zalup', 'shluh', 'shliuh', 'huev', 'hues', 'huil', 'huin', 'huep', 'huet', 'huen', 'huel',
  'nahui', 'pohui', 'ohuit', 'otsos', 'govn', 'gavn', 'dermo', 'mraz', 'sukin',
]);
// короткие или многозначные — только с начала слова
const RU_START = prep(['hui', 'blia', 'suka', 'suchk', 'suchar', 'zhop', 'sran', 'debil', 'ebu', 'ebi', 'manda']);
const RU_START_CYR = prep(['suki']); // латиницей «suki» — японское «нравится», не трогаем
const RU_EXACT = new Set(prep(['eb'])); // «ёб» отдельным словом
// повторы букв схлопываются, поэтому nigg = nig (night) — берём полные слова
const EN_ANY = prep(['fuck', 'fuk', 'shit', 'bitch', 'cunt', 'asshol', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'retard', 'wanker']);
const EN_START = prep(['fck', 'fag']);
// безобидные слова с «опасным» куском внутри — вырезаем перед проверкой
const ALLOW = prep(['strahu', 'koleb', 'greb', 'hleb', 'fukus', 'shitak', 'mandar', 'mandat', 'nebal', 'nebat', 'scunth', 'nigeri', 'mandal']);

const strip = (sk) => ALLOW.reduce((s, a) => s.split(a).join('_'), sk);

function hit(word, latinOnly) {
  for (const sk of skeletons(word).map(strip)) {
    if (RU_EXACT.has(sk)) return true;
    if (RU_ANY.some((r) => sk.includes(r))) return true;
    // латиницей «huit» — французское «восемь», а не мат
    if (RU_START.some((r) => sk.startsWith(r) && !(latinOnly && r === 'hui' && sk[3] === 't'))) return true;
    if (!latinOnly && RU_START_CYR.some((r) => sk.startsWith(r))) return true;
    if (latinOnly && (EN_ANY.some((r) => sk.includes(r)) || EN_START.some((r) => sk.startsWith(r)))) return true;
  }
  return false;
}

// слова текста; latinOnly — набрано без кириллицы (для английских основ)
function words(text) {
  const out = [];
  let run = '', runLatin = true;
  const flush = () => { if (run) out.push({ w: run, latinOnly: runLatin }); run = ''; runLatin = true; };
  for (const part of String(text || '').split(/[^\p{L}\p{N}@$!|€]+/u).filter(Boolean)) {
    const w = toLatin(part).replace(/[^a-z]/g, '');
    if (!w) continue;
    const latinOnly = !/[а-яёіїєґ]/i.test(part);
    if (w.length === 1) { run += w; runLatin = runLatin && latinOnly; continue; } // «б л я т ь»
    flush();
    out.push({ w, latinOnly });
  }
  flush();
  return out;
}

function check(text) {
  const ws = words(text);
  if (ws.some(({ w, latinOnly }) => hit(w, latinOnly))) return true;
  // «pi zda», «долба ёб»: соседние слова вместе, если одно из них короткое
  for (let i = 0; i + 1 < ws.length; i++) {
    const a = ws[i], b = ws[i + 1];
    if (Math.min(a.w.length, b.w.length) <= 3 && hit(a.w + b.w, a.latinOnly && b.latinOnly)) return true;
  }
  return false;
}

// «3» по-русски заменяет и «з» (пи3да), и «е» — проверяем оба прочтения
function hasProfanity(text) {
  const t = String(text || '');
  return check(t) || (t.includes('3') && check(t.replace(/3/g, 'з')));
}

// разбор слов нужен и фильтру чата (services/chatFilter.js)
module.exports = { hasProfanity, toLatin, skeletons, prep, strip };
