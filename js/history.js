// Журнал прогнозів: що додаток радив до початку матчу. Після матчу ставки розраховуються
// за фінальним рахунком — так видно реальну влучність і прибутковість, а не теоретичну.
// Зберігається в IndexedDB (FP.store, таблиця state) окремо від кешу, тому «Завантажити дані
// наново» його не стирає. Записи за 25 чемпіонатами швидко переросли б ліміт localStorage.
// Лайв-рекомендації ведуться окремо (live) і у віртуальний рахунок не йдуть.
FP.history = (() => {
  const KEEP_DAYS = 120;
  const LEGACY = { singles: 'fp_history', accas: 'fp_accas', live: 'fp_live', version: 'fp_stats_version' };
  // До завантаження зі сховища записи накопичуються тут і потім об'єднуються з ним.
  let data = {};
  let accas = { slots: {}, archive: [] };
  let live = {};
  const timers = {};

  function save(key, get) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => FP.store.put('state', key, get()), 300);
  }

  const cutoff = () => Date.now() / 1000 - KEEP_DAYS * 86400;

  function saveSingles() {
    const c = cutoff();
    for (const id of Object.keys(data)) if (data[id].ts < c) delete data[id];
    save('singles', () => data);
  }

  function saveAccas() {
    const c = cutoff();
    accas.archive = accas.archive.filter(a => a.createdAt / 1000 > c);
    save('accas', () => accas);
  }

  function saveLive() {
    const c = cutoff();
    for (const id of Object.keys(live)) if (live[id].ts < c) delete live[id];
    save('live', () => live);
  }

  // ---------- одиночні ----------
  const r3 = x => +x.toFixed(3);

  function entryOf(slug, ev, pred) {
    return {
      slug, ts: ev.ts,
      home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
      tip: { key: pred.tip.key, short: pred.tip.short, p: r3(pred.tip.p), level: pred.tip.conf.level, odds: pred.tip.odds || null },
      value: pred.value ? { key: pred.value.key, short: pred.value.short, p: r3(pred.value.p), odds: pred.value.odds } : null,
      // Ймовірності 1X2 на момент старту — щоб картка матчу, що почався, не перераховувалась.
      probs: { p1: r3(pred.prob['1']), px: r3(pred.prob.X), p2: r3(pred.prob['2']) },
      // Найкращі варіанти по групах ринків.
      picks: pred.groups.filter(g => g.pick).map(g => ({ group: g.name, key: g.pick.key, short: g.pick.short, p: r3(g.pick.p) })),
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

  const all = () => Object.entries(data).map(([id, x]) => ({ id, ...x }));
  const get = id => data[id] || null;

  // ---------- лайв-рекомендації (у перерві) ----------
  // Фіксуємо всі рекомендації, видані в перерві (останній варіант перед 2-м таймом),
  // разом із тоталом 1.5, якщо перший тайм закінчився 0:0.
  function recordLive(slug, ev, ht, recs) {
    if (!counts(ev)) return;
    live[ev.id] = {
      slug, ts: ev.ts, home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name, ht,
      picks: recs.map(m => ({ key: m.key, group: m.group, short: m.short, p: r3(m.p), k: r3(1 / m.p), zero: !!m.zero })),
    };
    saveLive();
  }

  const allLive = () => Object.entries(live).map(([id, x]) => ({ id, ...x }));

  // ---------- готові експреси ----------
  // slots: активний експрес у кожному слоті; archive: замінені експреси (для статистики).
  const activeAccas = () => ({ ...accas.slots });
  const archivedAccas = () => accas.archive.slice();

  function setActive(slot, acca) {
    accas.slots[slot] = acca;
    saveAccas();
  }

  function retire(slot) {
    const a = accas.slots[slot];
    if (a) accas.archive.push(a);
    delete accas.slots[slot];
    saveAccas();
  }

  function clear() {
    data = {};
    accas = { slots: {}, archive: [] };
    live = {};
    FP.store.put('state', 'singles', data);
    FP.store.put('state', 'accas', accas);
    FP.store.put('state', 'live', live);
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
      live = { ...(legacy('live') || {}), ...live };
      return;
    }
    const stored = k => FP.store.get('state', k) || legacy(k);
    data = { ...(stored('singles') || {}), ...data };
    const sa = stored('accas');
    if (sa) accas = { slots: { ...sa.slots, ...accas.slots }, archive: [...(sa.archive || []), ...accas.archive] };
    live = { ...(stored('live') || {}), ...live };
    const version = FP.store.get('state', 'version') || (() => { try { return localStorage.getItem(LEGACY.version); } catch { return null; } })();
    if (version !== FP.STATS_VERSION) clear();
    FP.store.put('state', 'version', FP.STATS_VERSION);
    saveSingles(); saveAccas(); saveLive();
    try { Object.values(LEGACY).forEach(k => localStorage.removeItem(k)); } catch {}
  });

  return { ready, record, recordLive, allLive, all, get, activeAccas, archivedAccas, setActive, retire, clear };
})();
