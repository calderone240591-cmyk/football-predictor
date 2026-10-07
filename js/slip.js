// Купон конструктора експресів. Одна подія на матч: події одного матчу пов'язані між собою
// (наприклад, П1 і ТБ 2.5), і множити їхні ймовірності було б неправильно.
FP.slip = (() => {
  const KEY = 'fp_slip';
  let legs = load();
  const listeners = new Set();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(legs)); } catch {}
    listeners.forEach(fn => fn(legs));
  }

  // leg: { slug, id, ts, home, away, key, short, long, p, odds }
  // Повертає 'added' | 'replaced' | 'removed'.
  function toggle(leg) {
    const i = legs.findIndex(x => x.id === leg.id);
    if (i >= 0 && legs[i].key === leg.key) { legs.splice(i, 1); save(); return 'removed'; }
    const res = i >= 0 ? 'replaced' : 'added';
    if (i >= 0) legs[i] = leg; else legs.push(leg);
    save();
    return res;
  }

  function remove(id) { legs = legs.filter(x => x.id !== id); save(); }
  function clear() { legs = []; save(); }
  function setAll(list) { legs = list.slice(); save(); }

  function setOdds(id, odds) {
    const l = legs.find(x => x.id === id);
    if (l) { l.userOdds = odds; save(); }
  }

  const has = (id, key) => legs.some(x => x.id === id && (key == null || x.key === key));
  const all = () => legs.slice();
  const onChange = fn => listeners.add(fn);

  return { toggle, remove, clear, setAll, setOdds, has, all, onChange };
})();
