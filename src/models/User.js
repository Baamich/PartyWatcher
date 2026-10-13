const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // friend — друг администратора: ему открыты «Просмотр фильма» и комнаты 18+ (services/roles.js); ставится в базе
    role: { type: String, enum: ['user', 'friend', 'admin'], default: 'user' },
    createdAt: { type: Date, default: Date.now },

    // ---- сброс пароля ----
    // храним только sha256 от токена: утечка базы не даёт готовых ссылок сброса
    resetTokenHash: { type: String, default: undefined, index: { sparse: true } },
    resetTokenExpires: { type: Date, default: undefined },
    // растёт при смене пароля — все старые JWT с меньшей версией перестают действовать
    tokenVersion: { type: Number, default: 0 },

    // ---- подтверждение почты (новые регистрации; у старых аккаунтов полей нет — они подтверждены) ----
    // пока verifyPending — входа нет; не подтвердил за 30 минут — запись удаляет TTL-индекс (логин и почта свободны)
    verifyPending: { type: Boolean, default: undefined },
    verifyTokenHash: { type: String, default: undefined, index: { sparse: true } }, // sha256 токена из письма
    verifyExpires: { type: Date, default: undefined },
    verifySentAt: { type: Date, default: undefined },

    // ---- условия пользования (services/terms.js) ----
    termsVersion: { type: String, default: null }, // какую версию принял; не текущая — окно «условия изменились»
    termsAt: { type: Date, default: null },

    // ---- блокировка аккаунта (админка) ----
    banPerm: { type: Boolean, default: false }, // забанен навсегда
    banUntil: { type: Date, default: null }, // заблокирован до (временная блокировка)
    banReason: { type: String, default: '' },
    banAt: { type: Date, default: null },
    banBy: { type: String, default: '' }, // логин админа

    // ---- откуда заходит (services/analytics.js; история — UserSeen) ----
    regIp: { type: String, default: '' },
    regDevice: { type: String, default: '' }, // «Windows 11 · Chrome 141»
    lastSeenAt: { type: Date, default: null },
    lastIp: { type: String, default: '' },

    // ---- 18+ ----
    adultConfirmed: { type: Boolean, default: false }, // хоть раз подтвердил, что ему есть 18 (в комнате с контентом 18+)
    showAdult: { type: Boolean, default: false }, // показывать комнаты 18+ в публичном списке (галочка «18+» на главной)

    // ---- стример ----
    streamerName: { type: String, default: undefined, trim: true },
    streamerNameLower: { type: String, default: undefined, unique: true, sparse: true },
    isLive: { type: Boolean, default: false },
    liveStartedAt: { type: Date, default: null },
    streamerBio: { type: String, default: '' },
    streamerAvatarUrl: { type: String, default: null },
    streamerBannerUrl: { type: String, default: null },
    profileViews: { type: Number, default: 0 },
    followersCount: { type: Number, default: 0 }, // меняется $inc вместе с коллекцией Follow
    profileLayout: { type: mongoose.Schema.Types.Mixed, default: null },
    profileRev: { type: Number, default: 0 },

    // ---- творческая студия ----
    streamTitle: { type: String, default: '' },
    streamDescription: { type: String, default: '' },
    streamCategoryId: { type: String, default: null }, // Category.tid, выбирается в студии
    liveNotice: { type: String, default: '' }, // текст в уведомлении подписчикам «вышел в эфир»
    chatFollowMin: { type: Number, default: null }, // чат только для подписчиков: null — выкл, 0 — сразу, N — подписан не меньше N минут
    chatFilter: { type: Number, default: 0 }, // фильтр слов в чате: 0 — выкл … 4 — очень сильно (services/chatFilter)
    chatSlowSec: { type: Number, default: 0 }, // медленный режим: секунд между сообщениями зрителя (0 — выкл)
    modPerms: { type: mongoose.Schema.Types.Mixed, default: null }, // права модераторов { mod: [...], senior: [...] } (services/channelMods)
    // ---- стрим-поинты канала (студия → 🎁 Награды) ----
    pointsName: { type: String, default: null }, // своё название; null — «стрим-поинты» на языке зрителя
    pointsNameAt: { type: Date, default: null }, // когда меняли название (раз в 30 дней)
    pointsIcon: { type: String, default: null }, // 'media:<id>' — свой значок
    rewardsSeeded: { type: Boolean, default: false }, // стартовые награды уже созданы
    streamKey: { type: String, default: undefined, unique: true, sparse: true },
    streamPlaybackId: { type: String, default: undefined, unique: true, sparse: true },

    // ---- API чата (OBS-оверлей, боты, мосты) ----
    chatApiKey: { type: String, default: undefined, unique: true, sparse: true },
  },
  { versionKey: false }
);

userSchema.pre('validate', function (next) {
  if (this.username) {
    this.usernameLower = this.username.toLowerCase();
  }

  if (this.streamerName) {
    this.streamerNameLower = this.streamerName.toLowerCase();
  } else {
    this.streamerNameLower = undefined;
  }

  next();
});

userSchema.index({ createdAt: -1 }); // админка: новые аккаунты сверху
// неподтверждённая регистрация живёт до verifyExpires, потом MongoDB сама удаляет её (проверка раз в минуту).
// partialFilter — страховка: подтверждённый аккаунт этот индекс не тронет, даже если поле где-то осталось
userSchema.index({ verifyExpires: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { verifyPending: true } });

module.exports = mongoose.model('User', userSchema);