// Запуск: node /seedPresets.js ИмяСтримера
const mongoose = require('mongoose');
const connectDB = require('./db/mongoose');
const User = require('./models/User');
const Preset = require('./models/Preset');
const PWStyle = require('./public/js/pwstyle.js');
const { parseArgsInput } = require('./services/chatCommands');

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

  console.log('Готово, добавлено:', made);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });