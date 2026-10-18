const mongoose = require('mongoose');

// Личное уведомление (колокольчик в шапке, services/notify.js). Текст не хранится: клиент собирает его по type
// из словаря (common.notify.type.*) и vars — так уведомление читается на текущем языке человека.
// Новости сайта сюда не пишутся (одна запись на всех — services/notify.js собирает их из News на лету).
// Прочитано / нет — по User.notifSeenAt (всё, что старше, прочитано). Живёт 90 дней (TTL-индекс по at)
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, required: true }, // 'support.reply', 'security.login', 'room.expired', … (services/notify.js TYPES)
    vars: { type: mongoose.Schema.Types.Mixed, default: undefined }, // подстановки для текста: тема обращения, устройство, имя комнаты…
    link: { type: String, default: undefined }, // кнопка «Перейти» (путь на сайте)
    // одинаковые подряд (подписки, клипы, лайки) копятся в одну запись, пока её не прочитали: «ник и ещё 3»
    group: { type: String, default: undefined },
    count: { type: Number, default: undefined },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

notificationSchema.index({ userId: 1, at: -1 }); // список и счётчик непрочитанных
notificationSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('Notification', notificationSchema);
