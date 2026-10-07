// Кэш профилей стримеров в IndexedDB (в localStorage base64-картинки не влезают).
// Хранит последние KEEP профилей; любая ошибка хранилища молча превращается в «кэша нет».
(function () {
  const DB_NAME = 'pw-cache';
  const STORE = 'streamers';
  const FORMAT = 1; // поменяй, если изменится структура записи: старый кэш будет проигнорирован
  const KEEP = 10;
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('IndexedDB недоступен'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  }

  function run(mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let out;
      work(tx.objectStore(STORE), (v) => { out = v; });
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));
  }

  function get(name) {
    return run('readonly', (s, ret) => {
      s.get(name).onsuccess = (e) => ret(e.target.result);
    }).then((r) => (r && r.f === FORMAT ? r : null)).catch(() => null);
  }

  function set(name, data) {
    return run('readwrite', (s) => {
      s.put({ ...data, f: FORMAT, t: Date.now() }, name);
      const ir = s.get('__index');
      ir.onsuccess = () => {
        const idx = (ir.result || []).filter((e) => e[0] !== name);
        idx.push([name, Date.now()]);
        idx.sort((a, b) => b[1] - a[1]);
        for (const [k] of idx.splice(KEEP)) s.delete(k); // старые профили выкидываем
        s.put(idx, '__index');
      };
    }).catch(() => {});
  }

  function del(name) {
    return run('readwrite', (s) => { s.delete(name); }).catch(() => {});
  }

  window.PWCache = { get, set, del };
})();