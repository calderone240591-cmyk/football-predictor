// Журнал прогнозів: що додаток радив до початку матчу. Після матчу ставки розраховуються
// за фінальним рахунком — так видно реальну влучність і прибутковість, а не теоретичну.
// Зберігається в IndexedDB (FP.store, таблиця state) окремо від кешу, тому «Завантажити дані
// наново» його не стирає. Записи за 25 чемпіонатами швидко переросли б ліміт localStorage.
FP.history = (() => {
  const KEEP_DAYS = 120;
  const LEGACY = { singles: 'fp_history', accas: 'fp_accas', live: 'fp_live', version: 'fp_stats_version' };
  // До завантаження зі сховища записи накопичуються тут і потім об'єднуються з ним.
  let data = {};
  let timer = null;

  function saveSingles() {
    const c = Date.now() / 1000 - KEEP_DAYS * 86400;
    for (const id of Object.keys(data)) if (data[id].ts < c) delete data[id];
    clearTimeout(timer);
    timer = setTimeout(() => FP.store.put('state', 'singles', data), 300);
  }

  const r3 = x => +x.toFixed(3);

  function entryOf(slug, ev, pred) {
    return {
      slug, ts: ev.ts,
      home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
      tip: { key: pred.tip.key, short: pred.tip.short, p: r3(pred.tip.p), level: pred.tip.conf.level, odds: pred.tip.odds || null },
      value: pred.value ? { key: pred.value.key, short: pred.value.short, p: r3(pred.value.p), odds: pred.value.odds } : null,
      // Ймовірності 1X2 на момент старту — щоб картка матчу, що почався, не перераховувалась.
      probs: { p1: r3(pred.prob['1']), px: r3(pred.prob.X), p2: r3(pred.prob['2']) },
    };
  }

  // У статистику йдуть лише матчі, що починаються не раніше FP.STATS_FROM.
  const counts = ev => ev.ts >= FP.STATS_FROM;

  // Оновлюємо запис до самого старту: фіксується останній передматчевий прогноз.
  function record(slug, ev, pred) {
    if (ev.ts * 1000 <= Date.now() || !counts(ev)) return;
    const prev = data[ev.id];
    const next = entryOf(slug, ev, pred);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    data[ev.id] = next;
    saveSingles();
  }

  // ---------- серверний журнал ----------
  // GitHub Actions кожні 20 хв записує передматчеві прогнози всіх матчів (tools/record.js) у гілку
  // journal. Телефон і браузер читають той самий журнал, тож статистика однакова на всіх пристроях
  // і не залежить від того, чи був додаток відкритий перед матчем. Записи сервера мають пріоритет,
  // локальні — запасний варіант для матчів, яких у журналі немає.
  const REMOTE = 'https://raw.githubusercontent.com/calderone240591-cmyk/football-predictor/journal/journal.json';
  let remote = {};
  let syncedAt = 0, syncing = null;
  function sync(force) {
    if (syncing) return syncing;
    if (!force && Date.now() - syncedAt < 2 * 60 * 1000) return Promise.resolve();
    const timeout = new Promise(r => setTimeout(r, 10000));
    syncing = Promise.race([timeout, (async () => {
      try {
        const res = await fetch(`${REMOTE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const j = await res.json();
        if (j.version === FP.STATS_VERSION) { remote = j.entries || {}; syncedAt = Date.now(); }
      } catch {}
    })()]).finally(() => { syncing = null; });
    return syncing;
  }

  const all = () => Object.entries({ ...data, ...remote }).map(([id, x]) => ({ id, ...x }));
  const get = id => remote[id] || data[id] || null;

  function clear() {
    data = {};
    FP.store.put('state', 'singles', data);
  }

  // ---------- завантаження ----------
  // Беремо збережене з IndexedDB, а якщо його ще немає — переносимо з localStorage (старі версії).
  // Записи, зроблені до завантаження, мають пріоритет. Нова версія параметрів — скидання з нуля.
  const legacy = key => { try { return JSON.parse(localStorage.getItem(LEGACY[key])); } catch { return null; } };
  const ready = FP.store.ready.then(() => {
    // Сховище не завантажилось — працюємо в пам'яті і нічого не скидаємо й не видаляємо,
    // щоб не втратити збережену статистику. Наступний запуск прочитає її як звичайно.
    if (!FP.store.isLoaded()) {
      data = { ...(legacy('singles') || {}), ...data };
      return;
    }
    data = { ...(FP.store.get('state', 'singles') || legacy('singles') || {}), ...data };
    const version = FP.store.get('state', 'version') || (() => { try { return localStorage.getItem(LEGACY.version); } catch { return null; } })();
    if (version !== FP.STATS_VERSION) clear();
    FP.store.put('state', 'version', FP.STATS_VERSION);
    saveSingles();
    // Експреси й лайв прибрано з додатка — їхні записи більше не потрібні.
    for (const k of ['accas', 'live', 'liveSnaps']) if (FP.store.get('state', k) != null) FP.store.put('state', k, null);
    try { Object.values(LEGACY).forEach(k => localStorage.removeItem(k)); localStorage.removeItem('fp_slip'); } catch {}
  });

  return { ready, record, all, get, clear, sync, entryOf };
})();
