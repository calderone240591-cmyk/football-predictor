// Журнал прогнозів: що додаток радив до початку матчу. Після матчу ставки розраховуються
// за фінальним рахунком — так видно реальну влучність і прибутковість, а не теоретичну.
// Зберігається окремо від кешу, тому «Завантажити дані наново» його не стирає.
FP.history = (() => {
  const KEY = 'fp_history';
  const ACCA_KEY = 'fp_accas';
  const KEEP_DAYS = 120;
  let data = load(KEY, {});
  let accas = load(ACCA_KEY, { slots: {}, archive: [] });
  const timers = {};

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }

  function save(key, get) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      try { localStorage.setItem(key, JSON.stringify(get())); } catch {}
    }, 300);
  }

  const cutoff = () => Date.now() / 1000 - KEEP_DAYS * 86400;

  function saveSingles() {
    const c = cutoff();
    for (const id of Object.keys(data)) if (data[id].ts < c) delete data[id];
    save(KEY, () => data);
  }

  function saveAccas() {
    const c = cutoff();
    accas.archive = accas.archive.filter(a => a.createdAt / 1000 > c);
    save(ACCA_KEY, () => accas);
  }

  // ---------- одиночні ----------
  const r3 = x => +x.toFixed(3);

  function entryOf(slug, ev, pred) {
    return {
      slug, ts: ev.ts,
      home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
      tip: { key: pred.tip.key, short: pred.tip.short, p: r3(pred.tip.p), level: pred.tip.conf.level, odds: pred.tip.odds || null },
      value: pred.value ? { key: pred.value.key, short: pred.value.short, p: r3(pred.value.p), odds: pred.value.odds } : null,
      // Найкращі варіанти по групах ринків.
      picks: pred.groups.filter(g => g.pick).map(g => ({ group: g.name, key: g.pick.key, short: g.pick.short, p: r3(g.pick.p) })),
      // Рекомендації в діапазонах кф 1.64–9.99.
      bands: pred.bands.filter(b => b.pick).map(b => ({
        band: `${b.lo}–${b.hi}`, key: b.pick.key, short: b.pick.short, p: r3(b.pick.p),
        odds: b.pick.odds || null, k: r3(b.pick.odds || 1 / b.pick.p), value: b.isValue,
      })),
    };
  }

  // Оновлюємо запис до самого старту: фіксується останній передматчевий прогноз.
  function record(slug, ev, pred) {
    if (ev.ts * 1000 <= Date.now()) return;
    const prev = data[ev.id];
    const next = entryOf(slug, ev, pred);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    data[ev.id] = next;
    saveSingles();
  }


  // ---------- лайв-рекомендації (у перерві) ----------
  const LIVE_KEY = 'fp_live';
  let live = load(LIVE_KEY, {});

  // Фіксуємо рекомендації, поки триває перерва (останній варіант перед 2-м таймом).
  function recordLive(slug, ev, ht, recs) {
    live[ev.id] = {
      slug, ts: ev.ts, home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name, ht,
      picks: recs.map(m => ({ key: m.key, group: m.group, short: m.short, p: r3(m.p), k: r3(1 / m.p) })),
    };
    const c = cutoff();
    for (const id of Object.keys(live)) if (live[id].ts < c) delete live[id];
    save(LIVE_KEY, () => live);
  }

  const allLive = () => Object.entries(live).map(([id, x]) => ({ id, ...x }));

  const all = () => Object.entries(data).map(([id, x]) => ({ id, ...x }));

  // ---------- готові експреси ----------
  // slots: активний експрес у кожному з 11 слотів; archive: замінені експреси (для статистики).
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
    try { localStorage.removeItem(KEY); localStorage.removeItem(ACCA_KEY); localStorage.removeItem(LIVE_KEY); } catch {}
  }

  // Нова версія параметрів рекомендацій — статистика ведеться з нуля (одноразове скидання).
  try {
    if (localStorage.getItem('fp_stats_version') !== FP.STATS_VERSION) {
      clear();
      localStorage.setItem('fp_stats_version', FP.STATS_VERSION);
    }
  } catch {}

  return { record, recordLive, allLive, all, activeAccas, archivedAccas, setActive, retire, clear };
})();
