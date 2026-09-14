// services/dropdown-player.js
//
// Утилиты для плееров, у которых сезон/серию можно узнать/переключить
// ТОЛЬКО через открытие выпадающих списков внутри самого плеера
// (adapter.mode === 'dropdown' в site-adapters.js). Пример — плеер "allplay"
// на kinogo: там нет ни JSON с hlsSource, ни отдельной таблицы расписания,
// только дропдауны с текстовыми пунктами ("Серия 1", "Серия 2"...).

// Ищет фрейм (или саму страницу), где реально лежит плеер — по CSS-селектору,
// а не по домену. Домен фрейма может быть любым/меняться, а разметка плеера
// стабильна, поэтому это надёжнее.
async function findPlayerContext(page, markerSelector, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const frames = page.frames(); // сюда входит и сама страница (mainFrame)
    for (const frame of frames) {
      try {
        const found = await frame.$(markerSelector);
        if (found) return frame;
      } catch (e) {
        // фрейм мог отсоединиться/перезагрузиться между попытками — пропускаем
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// Открывает дропдаун и читает текст всех пунктов списка (не кликая).
// Нужно, чтобы узнать сколько всего серий/сезонов есть на сайте.
async function readDropdownTexts(context, triggerSelector, listContainerSelector) {
  await context.waitForSelector(triggerSelector, { timeout: 10000 });

  // кликаем через JS — надёжнее, чем page.click()
  await context.$eval(triggerSelector, (el) => el.click());
  await new Promise((r) => setTimeout(r, 800));

  await context.waitForSelector(listContainerSelector, { timeout: 5000 });

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
  await new Promise((r) => setTimeout(r, 300));

  return texts;
}

// Открывает дропдаун и кликает по пункту, чей текст содержит нужный номер.
async function selectDropdownOptionByNumber(context, triggerSelector, listContainerSelector, number) {
  await context.waitForSelector(triggerSelector, { timeout: 10000 });
  await context.$eval(triggerSelector, (el) => el.click());
  await new Promise((r) => setTimeout(r, 800));
  await context.waitForSelector(listContainerSelector, { timeout: 5000 });
  
  const clicked = await context.evaluate((containerSel, num) => {
    const container = document.querySelector(containerSel);
    if (!container) return false;
    const candidates = Array.from(container.querySelectorAll('*')).filter((el) => el.children.length === 0);
    // сначала пробуем точное совпадение ("2"), потом "похоже на N и не слишком длинный текст"
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