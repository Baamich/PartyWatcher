// Запуск: node /seedPresets.js ИмяСтримера
const mongoose = require('mongoose');
const connectDB = require('./db/mongoose');
const User = require('./models/User');
const Preset = require('./models/Preset');
const PWStyle = require('./public/js/pwstyle.js');
const { parseArgsInput } = require('./services/chatCommands');
const WC = require('./public/widgets/catalog');

const STYLES = [
  {
    name: 'Неоновая ночь',
    description: 'Тёмные плашки с фиолетовой рамкой и свечением. Ники зрителей разноцветные.',
    data: {
      color: 'f5f3ff', weight: 700, bgOn: true, bg: '0b0b1a', bgalpha: 78,
      radius: 10, pad: 12, gap: 8, borderOn: true, bc: 'a855f7', bw: 2,
      glowOn: true, glowC: 'a855f7', glowS: 16, owner: 'a855f7', nickMode: 'auto', anim: 'pop',
    },
  },
  {
    name: 'Терминал',
    description: 'Зелёный текст на чёрном, как в старых компьютерах. Ники заглавными.',
    data: {
      font: 'Courier New', color: '39ff14', weight: 700, shadow: false, ls: 1,
      bgOn: true, bg: '000000', bgalpha: 85, radius: 0, pad: 10, gap: 6,
      borderOn: true, bc: '39ff14', bw: 1, stripeOn: true, stripeC: '39ff14', stripeW: 4,
      nickCaps: true, owner: '15803d', anim: 'fade',
    },
  },
  {
    name: 'Сакура',
    description: 'Нежный розовый градиент и мягкие скруглённые плашки.',
    data: {
      color: '4a2c3a', weight: 600, shadow: false,
      bgOn: true, grad: true, bg: 'ffd6e8', bg2: 'ffeef6', bgalpha: 92,
      radius: 20, pad: 14, gap: 8, borderOn: true, bc: 'ff9ec9', bw: 2,
      nickMode: 'auto', owner: 'ff7ab8', anim: 'pop',
    },
  },
  {
    name: 'Киберпанк: закат',
    description: 'Розово-фиолетовый градиент, бирюзовая полоска слева и неоновое свечение.',
    data: {
      color: 'fff1e6', weight: 700, ls: 1,
      bgOn: true, grad: true, bg: 'ff2a6d', bg2: '3a0ca3', bgalpha: 80,
      radius: 4, pad: 12, gap: 8, stripeOn: true, stripeC: '05d9e8', stripeW: 6,
      glowOn: true, glowC: '05d9e8', glowS: 12, nickCaps: true, owner: '7c3aed', anim: 'slide',
    },
  },
  {
    name: 'Стекло: плашка',
    description: 'Одно последнее сообщение на размытой стеклянной плашке внизу экрана.',
    data: {
      layout: 'bar', align: 'center', size: 26, weight: 600, shadow: false,
      bgOn: true, bg: '0f172a', bgalpha: 55, blur: 16, pad: 18, radius: 0,
      nickMode: 'auto', anim: 'fade',
    },
  },
];

const COMMANDS = [
  {
    name: 'Рулетка', description: 'Случайное число от 1 до выбранного: !рулетка 30.',
    data: { name: 'рулетка', args: [{ name: 'число', optional: false }],
      response: '🎰 {user} крутит рулетку 1–{число}: выпало {random:{число}}' },
  },
  {
    name: 'Волшебный шар', description: 'Шар отвечает на любой вопрос: да, нет или «спроси позже».',
    data: { name: 'шар', args: [],
      response: '🔮 {user}, шар говорит: {choice:Да|Нет|Скорее да|Скорее нет|Спроси позже|Определённо!|Даже не думай}' },
  },
  {
    name: 'Совместимость', description: 'Шуточный процент совместимости с кем-то: !любовь Вася.',
    data: { name: 'любовь', args: [{ name: 'кого', optional: false }],
      response: '💘 Совместимость {user} и {кого}: {random:100}%' },
  },
  {
    name: 'Лут-дроп', description: 'Случайный предмет от обычного до легендарного.',
    data: { name: 'дроп', args: [],
      response: '📦 {user} получает: {choice:Деревянный меч|Железный щит|Редкий шлем 🔹|Эпический лук 🟣|Легендарный посох 🌟}' },
  },
  {
    name: 'Инфо об эфире', description: 'Название стрима, сколько идёт эфир и сколько зрителей в чате.',
    data: { name: 'инфо', args: [],
      response: '📡 «{title}» идёт уже {uptime}. В чате {viewers}. Приятного просмотра, {user}!' },
  },
  {
    name: 'Сколько я подписан', description: 'Зритель узнаёт, как давно он подписан на канал: !подписка.',
    data: { name: 'подписка', args: [],
      response: '❤ {user}, ты с нами уже {followage}! Спасибо, что ты здесь.' },
  },
  {
    name: 'Мои поинты', description: 'Баланс стрим-поинтов зрителя на этом канале: !поинты.',
    data: { name: 'поинты', args: [],
      response: '💰 {user}, у тебя {points} {points_name}. Награды — по кнопке под чатом.' },
  },
  {
    name: 'Случайный победитель', description: 'Розыгрыш среди тех, кто сейчас на странице канала: !победитель.',
    data: { name: 'победитель', args: [],
      response: '🎉 Барабанная дробь… Победитель: {random_user}! Поздравляем!' },
  },
];

// виджеты OBS (тип и настройки — widgets/catalog.js): добавляются стримеру в «⏱️ Виджеты»
const WIDGETS = [
  {
    name: 'Счётчик смертей', description: 'Крупный счётчик «💀 Смерти: N» с обводкой. +1 — кнопкой или /count deaths.',
    data: { type: 'counter', name: 'Смерти', slug: 'deaths', opts: { template: '💀 Смерти: {n}' },
      style: { font: 'impact', size: 56, color: '#ffffff', stroke: 3, strokeColor: '#7f1d1d', shadow: true } },
  },
  {
    name: 'Перерыв 5 минут', description: 'Плашка «☕ Перерыв» с обратным отсчётом, полосой времени и звонком в конце.',
    data: { type: 'countdown', name: 'Перерыв', slug: 'brb', opts: { sec: 300, prefix: '☕ Перерыв:', endText: 'Уже иду!', bar: true, sound: 'bell', volume: 70 },
      style: { size: 44, color: '#f8fafc', accent: '#38bdf8', bg: '#0f172a', bgAlpha: 70, pad: 18, radius: 14 } },
  },
  {
    name: 'Цель на эфир: подписчики', description: 'Полоса прогресса новых подписчиков за эфир, цель — 10. Считается сама.',
    data: { type: 'goal', name: 'Подписчики за эфир', slug: 'subgoal', opts: { source: 'followersStream', target: 10, title: '❤ Новые подписчики за эфир', endText: '🎉 Цель достигнута!', barH: 28 },
      style: { size: 26, color: '#ffffff', accent: '#f472b6', bg: '#1e1b2e', bgAlpha: 65, pad: 16, radius: 14 } },
  },
  {
    name: 'Инфо-панель', description: 'По очереди: игра, зрители, последний подписчик и время эфира. Свой виджет из строк.',
    data: { type: 'custom', name: 'Инфо-панель', slug: 'info',
      opts: { mode: 'rotate', rotateSec: 6, anim: 'slide', lines: [
        { text: '🎮 Играем: {category}' }, { text: '👀 Сейчас смотрят: {viewers}' },
        { text: '❤ Последний подписчик: {last_follower}' }, { text: '⏱ В эфире уже {uptime}' }] },
      style: { size: 30, color: '#e5e7eb', bg: '#111827', bgAlpha: 75, pad: 14, radius: 12 } },
  },
  {
    name: 'Колесо испытаний', description: 'Случайное испытание для стримера. Крутить — кнопкой 🎲, /w wheel roll или наградой.',
    data: { type: 'custom', name: 'Колесо испытаний', slug: 'wheel',
      opts: { mode: 'all', anim: 'pop', lines: [
        { text: '🎡 Колесо испытаний', size: 60, bold: true },
        { text: '{choice:10 отжиманий|Без звука 5 минут|Говорю с акцентом|Выбор чата|Пей воду!|Комплимент чату|Играю одной рукой}', size: 110, bold: true }] },
      style: { font: 'trebuchet', size: 40, color: '#fde68a', accent: '#f59e0b', bg: '#1c1917', bgAlpha: 70, pad: 18, radius: 18 } },
  },
];

// награды за стрим-поинты: {user} купивший, {reward} награда, {cost} цена, {message} текст зрителя, {points} название поинтов, {balance} остаток
const REWARDS = [
  {
    name: 'Пей воду!', description: 'Зритель напоминает стримеру попить воды — бот пишет в чат.',
    data: { title: 'Пей воду!', description: 'Стример сделает глоток воды', cost: 300, color: '#0ea5e9', needInput: false,
      reply: '💧 {user} заботится о стримере: пора попить воды!' },
  },
  {
    name: '10 отжиманий', description: 'Стример делает 10 отжиманий прямо в эфире.',
    data: { title: '10 отжиманий', description: 'Стример сделает 10 отжиманий в эфире', cost: 1000, color: '#dc2626', needInput: false,
      reply: '💪 {user} потратил {cost} {points}: стример, 10 отжиманий!' },
  },
  {
    name: 'Вопрос стримеру', description: 'Зритель пишет вопрос — бот выделяет его в чате, стример отвечает голосом.',
    data: { title: 'Вопрос стримеру', description: 'Напиши вопрос — стример ответит в эфире', cost: 500, color: '#7c3aed', needInput: true,
      reply: '❓ Вопрос от {user}: {message}' },
  },
  {
    name: 'Заказ песни', description: 'Зритель пишет название песни, стример включает её на фоне.',
    data: { title: 'Заказ песни', description: 'Напиши исполнителя и название песни', cost: 1500, color: '#db2777', needInput: true,
      reply: '🎵 {user} заказывает: {message}' },
  },
  {
    name: 'Выбор следующей игры', description: 'Зритель предлагает, во что стример сыграет дальше.',
    data: { title: 'Выбери следующую игру', description: 'Напиши игру — стример сыграет в неё следующей', cost: 5000, color: '#16a34a', needInput: true,
      reply: '🎮 {user} выбирает следующую игру: {message}. Осталось {balance} {points}.' },
  },
  // новые: ограничения (перезарядка, лимиты за эфир) и действия с виджетами из пре-сетов выше
  {
    name: '+1 минута к таймеру', description: 'Добавляет минуту к виджету «Обратный отсчёт» (имя для команд — timer). Раз в 30 секунд.',
    data: { title: '+1 минута к таймеру', description: 'Продли таймер на экране на минуту', cost: 500, color: '#0ea5e9', needInput: false,
      reply: '⏳ {user} добавил минуту к таймеру!', cooldownSec: 30, perStream: 0, perUserStream: 0, onlyLive: true,
      action: { widget: 'timer', op: 'add', value: '60' } },
  },
  {
    name: 'Сообщение на экран', description: 'Текст зрителя появляется в виджете «Надпись» (имя для команд — text). Раз в минуту.',
    data: { title: 'Сообщение на экран', description: 'Напиши, что показать на стриме', cost: 800, color: '#a855f7', needInput: true,
      reply: '📺 {user} выводит на экран: {message}', cooldownSec: 60, perStream: 0, perUserStream: 0, onlyLive: true,
      action: { widget: 'text', op: 'text', value: '{user}: {message}' } },
  },
  {
    name: 'Крутить колесо испытаний', description: 'Крутит виджет «Колесо испытаний» из пре-сетов. Не чаще раза в 2 минуты.',
    data: { title: 'Крутить колесо', description: 'Стример выполнит то, что выпадет', cost: 1500, color: '#f59e0b', needInput: false,
      reply: '🎡 {user} крутит колесо испытаний — смотри на экран!', cooldownSec: 120, perStream: 0, perUserStream: 0, onlyLive: true,
      action: { widget: 'wheel', op: 'roll', value: '' } },
  },
  {
    name: 'Обнимашка', description: 'Обнять другого зрителя: бот пишет в чат и считает объятия. Не больше 3 за эфир с человека.',
    data: { title: 'Обнять зрителя', description: 'Напиши ник того, кого обнять', cost: 100, color: '#ec4899', needInput: true,
      reply: '🤗 {user} крепко обнимает {target}! Это уже {count}-е объятие на канале.', cooldownSec: 0, perStream: 0, perUserStream: 3, onlyLive: false, action: null },
  },
  {
    name: 'Бросок d20', description: 'Кубик на 20 граней, как в настольных играх. Раз в 10 секунд.',
    data: { title: 'Бросок d20', description: 'Испытай удачу', cost: 200, color: '#16a34a', needInput: false,
      reply: '🎲 {user} бросает d20 — выпало {random:1-20}! ({count_user}-й бросок за всё время)', cooldownSec: 10, perStream: 0, perUserStream: 0, onlyLive: false, action: null },
  },
];

(async () => {
  const name = String(process.argv[2] || '').trim().toLowerCase();
  if (!name) { console.error('Укажи имя стримера: node scripts/seedPresets.js baamich'); process.exit(1); }

  await connectDB();
  const me = await User.findOne({ streamerNameLower: name }).select('_id streamerName');
  if (!me) { console.error('Стример не найден:', name); process.exit(1); }

  let made = 0;
  const put = async (type, item, data) => {
    const nameLower = item.name.toLowerCase();
    if (await Preset.exists({ authorId: me._id, type, nameLower })) {
      console.log('пропуск (уже есть):', item.name);
      return;
    }
    await Preset.create({
      type, name: item.name, description: item.description, data,
      authorId: me._id, authorName: me.streamerName,
    });
    made++;
    console.log('добавлен:', type, '-', item.name);
  };

  for (const s of STYLES) {
    const data = PWStyle.sanitize(s.data);
    if (PWStyle.isDefault(data)) { console.warn('стиль совпал со стандартным:', s.name); continue; }
    await put('style', s, data);
  }
  for (const c of COMMANDS) {
    const a = parseArgsInput(c.data.args);
    if (a.error) { console.warn('ошибка в аргументах', c.name, a.error); continue; }
    await put('command', c, { name: c.data.name, response: c.data.response, args: a.args });
  }

  for (const r of REWARDS) await put('reward', r, r.data);

  for (const w of WIDGETS) {
    const c = WC.cleanWidget(w.data);
    if (!c) { console.warn('ошибка в виджете', w.name); continue; }
    delete c.id;
    c.state = WC.cleanState(c.type, {}); // состояние не переносим
    await put('widget', w, c);
  }

  console.log('Готово, добавлено:', made);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });