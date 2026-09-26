// Ступенчатая схема переподключения: 1-3 попытки каждые 2с, 4-7 каждые 4с, 8-10 каждые 5с.
// После 10 попыток — прекращаем (вызывающий код решает, что делать дальше).
function reconnectDelayForAttempt(attempt) {
  if (attempt <= 3) return 2000;
  if (attempt <= 7) return 4000;
  if (attempt <= 10) return 5000;
  return null; // сигнал "хватит пытаться"
}

function createReconnectScheduler(tryFn, onGiveUp) {
  let attempt = 0;
  let timer = null;

  function attemptNow() {
    attempt += 1;
    const delay = reconnectDelayForAttempt(attempt);
    if (delay === null) {
      onGiveUp?.();
      return;
    }
    timer = setTimeout(async () => {
      const ok = await tryFn();
      if (!ok) attemptNow();
    }, delay);
  }

  return {
    start: () => { attempt = 0; attemptNow(); },
    reset: () => { attempt = 0; clearTimeout(timer); },
    stop: () => clearTimeout(timer),
  };
}