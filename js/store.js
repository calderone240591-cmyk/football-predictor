// Сховище в IndexedDB (ліміт — сотні МБ, на відміну від ≈ 5 МБ у localStorage на iPhone).
// Дві таблиці: kv — кеш даних ESPN, state — статистика, експреси, лайв-записи.
// Читання синхронне з пам'яті: усе вантажиться при запуску (ready), запис — у фоні.
//
// Захист даних: записувати в IndexedDB можна лише після того, як його вміст повністю завантажено
// (loaded). Інакше неповні дані з пам'яті могли б перезаписати збережену статистику.
// Якщо IndexedDB недоступна, дані живуть лише в пам'яті і нічого не перезаписується.
FP.store = (() => {
  const DB_NAME = 'fp-cache';
  const STORES = ['kv', 'state'];
  const data = { kv: new Map(), state: new Map() };
  let db = null;
  let loaded = false;

  const ready = new Promise(resolve => {
    let opened = false, timedOut = false;
    // Запобіжник лише на випадок, коли сховище взагалі не відкривається (наприклад, оновлення
    // заблоковане старою копією додатка в іншій вкладці). Якщо відкрилось — чекаємо повного читання.
    // Якщо запобіжник спрацював, ця сесія до кінця працює лише з пам'яттю: сховище, відкрите
    // пізніше, не використовується — інакше неповні дані з пам'яті перезаписали б збережені.
    setTimeout(() => { if (!opened) { timedOut = true; resolve(); } }, 15000);
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onerror = () => { timedOut = true; resolve(); };
      req.onblocked = () => {};   // чекаємо: або розблокується, або спрацює запобіжник
      req.onsuccess = () => {
        if (timedOut) { req.result.close(); return; }
        opened = true;
        db = req.result;
        // Якщо інша вкладка оновлює сховище — звільняємо з'єднання, щоб не блокувати її.
        db.onversionchange = () => { db.close(); db = null; };
        let pending = STORES.length, failed = false;
        const done = ok => {
          if (!ok) failed = true;
          if (--pending === 0) { loaded = !failed; resolve(); }
        };
        for (const s of STORES) {
          try {
            const cur = db.transaction(s).objectStore(s).openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) return done(true);
              data[s].set(c.key, c.value);
              c.continue();
            };
            cur.onerror = () => done(false);
          } catch { done(false); }
        }
      };
    } catch { resolve(); }
  });

  const get = (s, k) => data[s].get(k);

  function put(s, k, v) {
    data[s].set(k, v);
    if (!db || !loaded) return;
    try { db.transaction(s, 'readwrite').objectStore(s).put(v, k); } catch {}
  }

  function clear(s) {
    data[s].clear();
    if (!db || !loaded) return;
    try { db.transaction(s, 'readwrite').objectStore(s).clear(); } catch {}
  }

  return { ready, get, put, clear, isLoaded: () => loaded };
})();
