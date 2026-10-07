// Журнал прогнозів: що додаток радив до початку матчу. Після матчу ставки розраховуються
// за фінальним рахунком — так видно реальну влучність і прибутковість, а не теоретичну.
// Зберігається окремо від кешу, тому «Очистити кеш» його не стирає.
FP.history = (() => {
  const KEY = 'fp_history';
  const KEEP_DAYS = 90;
  let data = load();
  let saveTimer = null;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const cutoff = Date.now() / 1000 - KEEP_DAYS * 86400;
      for (const id of Object.keys(data)) if (data[id].ts < cutoff) delete data[id];
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
    }, 500);
  }

  // Оновлюємо запис до самого старту: фіксується останній передматчевий прогноз.
  function record(slug, ev, pred) {
    if (ev.ts * 1000 <= Date.now()) return;
    const prev = data[ev.id];
    const next = {
      slug, ts: ev.ts,
      home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
      tip: { key: pred.tip.key, short: pred.tip.short, p: +pred.tip.p.toFixed(3), level: pred.tip.conf.level, odds: pred.tip.odds || null },
      value: pred.value ? { key: pred.value.key, short: pred.value.short, p: +pred.value.p.toFixed(3), odds: pred.value.odds } : null,
    };
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    data[ev.id] = next;
    save();
  }

  const all = () => Object.entries(data).map(([id, x]) => ({ id, ...x }));

  function clear() {
    data = {};
    try { localStorage.removeItem(KEY); } catch {}
  }

  return { record, all, clear };
})();
