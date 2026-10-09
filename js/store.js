// Сховище в IndexedDB (ліміт — сотні МБ, на відміну від ≈ 5 МБ у localStorage на iPhone).
// Дві таблиці: kv — кеш даних ESPN, state — статистика, експреси, лайв-записи.
// Читання синхронне з пам'яті: усе вантажиться при запуску (ready), запис — у фоні.
// Якщо IndexedDB недоступна (наприклад, приватний режим), дані живуть лише в пам'яті.
FP.store = (() => {
  const DB_NAME = 'fp-cache';
  const STORES = ['kv', 'state'];
  const data = { kv: new Map(), state: new Map() };
  let db = null;

  const ready = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        db = req.result;
        let pending = STORES.length;
        for (const s of STORES) {
          try {
            const cur = db.transaction(s).objectStore(s).openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) { if (--pending === 0) resolve(); return; }
              data[s].set(c.key, c.value);
              c.continue();
            };
            cur.onerror = () => { if (--pending === 0) resolve(); };
          } catch { if (--pending === 0) resolve(); }
        }
      };
    } catch { resolve(); }
  });

  const get = (s, k) => data[s].get(k);

  function put(s, k, v) {
    data[s].set(k, v);
    if (!db) return;
    try { db.transaction(s, 'readwrite').objectStore(s).put(v, k); } catch {}
  }

  function clear(s) {
    data[s].clear();
    if (!db) return;
    try { db.transaction(s, 'readwrite').objectStore(s).clear(); } catch {}
  }

  return { ready, get, put, clear };
})();
