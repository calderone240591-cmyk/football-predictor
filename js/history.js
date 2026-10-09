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

  // Відтворений прогноз для вже зіграного матчу, якого немає в журналі (рахується за даними до матчу).
  function recordReconstructed(slug, ev, pred) {
    if (data[ev.id]) return;
    data[ev.id] = { ...entryOf(slug, ev, pred), rec: true };
    saveSingles();
  }

  const has = id => !!data[id];

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
    try { localStorage.removeItem(KEY); localStorage.removeItem(ACCA_KEY); } catch {}
  }

  return { record, recordReconstructed, has, all, activeAccas, archivedAccas, setActive, retire, clear };
})();
