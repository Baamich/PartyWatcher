// sockets/safeHandlers.js
// Обработчики событий сокета вызываются socket.io через process.nextTick: исключение в синхронном
// обработчике (например, деструктуризация ({ code }) у события, пришедшего без данных) становится
// uncaughtException и роняет весь процесс сервера. Одно такое сообщение от любого клиента = падение сайта.
// Оборачиваем socket.on: ошибка любого обработчика (и отклонённый промис async-обработчика) только логируется.

function safeHandlers(socket, tag) {
  const on = socket.on.bind(socket);
  socket.on = (event, handler) => on(event, (...args) => {
    const fail = (e) => console.error(`[${tag}] ошибка в обработчике «${event}»:`, e && e.message ? e.message : e);
    try {
      const r = handler(...args);
      if (r && typeof r.then === 'function') r.then(undefined, fail);
    } catch (e) {
      fail(e);
    }
  });
  return socket;
}

module.exports = safeHandlers;
