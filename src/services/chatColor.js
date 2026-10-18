// Цвет ника в чатах (профиль → «Вид чата»): чат эфира, студия, OBS-оверлей и чат комнат.
// Не выбирал — при первом сообщении (или открытии профиля) получает случайный цвет из палитры, и он закрепляется.
// Цвета светлые — под тёмный чат; в светлой теме браузер их затемняет (common.css, .pw-nick)
const User = require('../models/User');

const PALETTE = [
  '#ff7a7a', '#ffa25c', '#ffd25c', '#b5e05a', '#5fd68a', '#4fd6c6',
  '#5cc2ff', '#7d9dff', '#a98bff', '#df7aff', '#ff7ac0', '#d7b98f',
];
const HEX = /^#[0-9a-f]{6}$/i;

const cache = new Map(); // userId → цвет (процесс один; меняется только через set)

const random = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

async function of(userId) {
  const id = String(userId);
  const hit = cache.get(id);
  if (hit) return hit;
  const u = await User.findById(id).select('chatColor').lean();
  if (!u) return null;
  let c = HEX.test(u.chatColor || '') ? u.chatColor : null;
  if (!c) {
    c = random();
    // только если цвета так и нет (два сообщения сразу — не перезапишут друг друга)
    const r = await User.updateOne({ _id: id, chatColor: { $in: [null, ''] } }, { $set: { chatColor: c } });
    if (!r.modifiedCount) c = (await User.findById(id).select('chatColor').lean())?.chatColor || c;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(id, c);
  return c;
}

async function set(userId, color) {
  const c = String(color || '').toLowerCase();
  if (!PALETTE.includes(c)) return false;
  await User.updateOne({ _id: userId }, { $set: { chatColor: c } });
  cache.set(String(userId), c);
  return true;
}

module.exports = { PALETTE, of, set };
