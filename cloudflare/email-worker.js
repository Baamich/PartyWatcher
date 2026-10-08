// Cloudflare Email Worker: письма на support@partywatcher.de → тикеты в админке PartyWatcher.
// Вставляется в панели Cloudflare (Workers & Pages → Create → Worker), в репозитории лежит для справки.
//
// Переменные Worker'а (Settings → Variables and Secrets):
//   INBOUND_URL    — https://partywatcher.de/api/support/inbound
//   INBOUND_SECRET — тип Secret, то же значение, что INBOUND_EMAIL_SECRET в .env сервера
//   FORWARD_TO     — необязательно: личный ящик для копии писем (должен быть подтверждён в Email Routing)

export default {
  // Worker работает только с почтой; открытие по ссылке (workers.dev, Preview в редакторе) — просто 404
  async fetch() {
    return new Response('support-mail: only email', { status: 404 });
  },

  async email(message, env) {
    let delivered = false;

    if (message.rawSize <= 2 * 1024 * 1024) {
      try {
        const raw = await new Response(message.raw).arrayBuffer();
        const res = await fetch(env.INBOUND_URL, {
          method: 'POST',
          headers: {
            'content-type': 'message/rfc822',
            'x-inbound-secret': env.INBOUND_SECRET,
            'x-envelope-from': message.from,
          },
          body: raw,
        });
        delivered = res.ok;
      } catch (_) {
        delivered = false;
      }
    }

    // копия в личный ящик — заодно запасной путь, если сайт недоступен или письмо слишком большое
    if (env.FORWARD_TO) {
      await message.forward(env.FORWARD_TO);
    } else if (!delivered) {
      message.setReject('Temporary error, please try again later');
    }
  },
};
