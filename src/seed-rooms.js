// seed-rooms.js
// node seed-rooms.js          -> добавить 200 тестовых комнат
// node seed-rooms.js 300      -> добавить 300
// node seed-rooms.js --clear  -> удалить все тестовые
const mongoose = require('mongoose');
const connectDB = require('./db/mongoose');
const Room = require('./models/Room');

const TEST_CODE_RE = /^test\d+$/;

async function main() {
  await connectDB();

  if (process.argv.includes('--clear')) {
    const res = await Room.deleteMany({ code: TEST_CODE_RE });
    console.log(`Удалено тестовых комнат: ${res.deletedCount}`);
    return;
  }

  const count = parseInt(process.argv[2], 10) || 200;

  // чужой владелец: свои комнаты в публичном списке не показываются (owner: { $ne: req.user.id })
  const fakeOwner = new mongoose.Types.ObjectId();
  const now = Date.now();

  const longName = 'Очень длинное название комнаты чтобы проверить обрезку текста в карточке';

  const docs = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const hasViewers = Math.random() < 0.3;
    const viewerCount = hasViewers ? 1 + Math.floor(Math.random() * 6) : 0;
    const withThumb = n % 2 === 0; // половина с картинкой, половина с заглушкой 🎬

    return {
      name: n % 10 === 0 ? `${longName} #${n}` : `Тест комната №${n}`,
      code: 'test' + String(n).padStart(4, '0'),
      owner: fakeOwner,
      video: withThumb
        ? { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
        : { type: 'direct', url: `https://example.com/video-${n}.mp4` },
      isPublic: true,
      viewerCount,
      emptySince: viewerCount === 0 ? new Date(now) : null,
      // n=1 самая старая, последняя самая новая: сортировка "Новые/Старые" видна сразу
      createdAt: new Date(now - (count - n) * 60 * 1000),
    };
  });

  await Room.insertMany(docs);
  console.log(`Добавлено комнат: ${docs.length} (страниц по 52: ${Math.ceil(docs.length / 52)})`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());