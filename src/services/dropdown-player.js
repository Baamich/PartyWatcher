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

// Клик по элементу ТОЛЬКО по видимому тексту, без опоры на CSS-классы/data-атрибуты —
// нужно для kinogo2026, где дропдаун сезон/серия сделан кастомным виджетом без
// стабильных селекторов. Ищет лист (элемент без детей), чей trim()-текст точно
// совпадает с targetText, и кликает по нему.
async function clickByVisibleText(context, targetText, { waitAfterMs = 600 } = {}) {
  const clicked = await context.evaluate((text) => {
    const leaves = Array.from(document.querySelectorAll('body *')).filter((el) => el.children.length === 0);
    const target = leaves.find((el) => el.textContent.trim() === text);
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, targetText);
  if (clicked) await new Promise((r) => setTimeout(r, waitAfterMs));
  return clicked;
}

// Пытается открыть дропдаун (клик по любому листу, чей текст матчит паттерн —
// обычно это сам триггер вида "Серия 1") и затем собирает ВСЕ листья, чей текст
// матчит тот же паттерн — после открытия там должны появиться "Серия 1".."Серия N".
// Возвращает уникальные найденные тексты.
async function listEpisodesByVisibleText(context, patternSource = '^Серия\\s*\\d+$') {
  const opened = await context.evaluate((src) => {
    const pattern = new RegExp(src, 'i');
    const leaves = Array.from(document.querySelectorAll('body *')).filter((el) => el.children.length === 0);
    const trigger = leaves.find((el) => pattern.test(el.textContent.trim()));
    if (trigger) {
      trigger.click();
      return true;
    }
    return false;
  }, patternSource);

  if (opened) await new Promise((r) => setTimeout(r, 500));

  const texts = await context.evaluate((src) => {
    const pattern = new RegExp(src, 'i');
    return Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent.trim())
      .filter((t) => pattern.test(t));
  }, patternSource);

  // закрываем обратно кликом по тому же триггеру, если получится (не критично, если нет)
  if (opened) {
    await context.evaluate((src) => {
      const pattern = new RegExp(src, 'i');
      const leaves = Array.from(document.querySelectorAll('body *')).filter((el) => el.children.length === 0);
      const trigger = leaves.find((el) => pattern.test(el.textContent.trim()));
      if (trigger) trigger.click();
    }, patternSource).catch(() => {});
  }

  return [...new Set(texts)];
}

module.exports = {
  findPlayerContext,
  readDropdownTexts,
  selectDropdownOptionByNumber,
  clickByVisibleText,
  listEpisodesByVisibleText,
};