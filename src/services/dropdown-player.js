// services/dropdown-player.js
//
// Утилиты для плееров, у которых сезон/серию можно узнать/переключить
// ТОЛЬКО через открытие выпадающих списков внутри самого плеера
// (adapter.mode === 'dropdown' в site-adapters.js). Пример — плеер "allplay"
// на kinogo: там нет ни JSON с hlsSource, ни отдельной таблицы расписания,
// только дропдауны с текстовыми пунктами ("Серия 1", "Серия 2"...).

const DEFAULT_TIMEOUT = 4000;

// Ищет фрейм (или саму страницу), где реально лежит плеер — по CSS-селектору,
// а не по домену. Домен фрейма может быть любым/меняться, а разметка плеера
// стабильна, поэтому это надёжнее.
async function findPlayerContext(page, markerSelector, { attempts = 8, delayMs = 400 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const found = await frame.$(markerSelector);
        if (found) return frame;
      } catch (e) {
        // фрейм мог отсоединиться/перезагрузиться между попытками
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// Открывает дропдаун и читает текст всех пунктов списка (не кликая).
async function readDropdownTexts(context, triggerSelector, listContainerSelector, timeoutMs = DEFAULT_TIMEOUT) {
  try {
    await context.waitForSelector(triggerSelector, { timeout: timeoutMs });
  } catch (e) {
    console.warn('[dropdown] trigger не появился:', triggerSelector, e.message);
    return [];
  }

  await context.$eval(triggerSelector, (el) => el.click());
  await new Promise((r) => setTimeout(r, 600));

  try {
    await context.waitForSelector(listContainerSelector, { timeout: Math.min(timeoutMs, 4000) });
  } catch (e) {
    console.warn('[dropdown] list container не появился:', listContainerSelector);
    return [];
  }

  const texts = await context.evaluate((containerSel) => {
    const container = document.querySelector(containerSel);
    if (!container) return [];
    return Array.from(container.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }, listContainerSelector);

  // закрываем обратно
  await context.$eval(triggerSelector, (el) => el.click()).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  return texts;
}

// Открывает дропдаун и кликает по пункту, чей текст содержит нужный номер.
async function selectDropdownOptionByNumber(context, triggerSelector, listContainerSelector, number, timeoutMs = DEFAULT_TIMEOUT) {
  try {
    await context.waitForSelector(triggerSelector, { timeout: timeoutMs });
  } catch (e) {
    console.warn('[dropdown] trigger не появился для клика:', triggerSelector);
    return false;
  }

  await context.$eval(triggerSelector, (el) => el.click());
  await new Promise((r) => setTimeout(r, 600));

  try {
    await context.waitForSelector(listContainerSelector, { timeout: Math.min(timeoutMs, 4000) });
  } catch (e) {
    console.warn('[dropdown] list container не появился для клика');
    return false;
  }

  const clicked = await context.evaluate((containerSel, num) => {
    const container = document.querySelector(containerSel);
    if (!container) return false;
    const candidates = Array.from(container.querySelectorAll('*')).filter((el) => el.children.length === 0);

    let target = candidates.find((el) => el.textContent.trim() === String(num));
    if (!target) {
      target = candidates.find((el) => {
        const text = el.textContent.trim();
        return new RegExp(`(^|\\D)${num}(\\D|$)`).test(text) && text.length < 20;
      });
    }
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, listContainerSelector, number);

  return clicked;
}

module.exports = { findPlayerContext, readDropdownTexts, selectDropdownOptionByNumber };