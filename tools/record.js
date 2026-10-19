// Серверний журнал прогнозів. Запускається GitHub Actions кожні 15 хвилин (.github/workflows/journal.yml):
// рахує передматчеві прогнози всіх матчів найближчих 48 годин тим самим кодом, що й додаток
// (js/config.js, js/api.js, js/model.js, js/history.js), і оновлює їх до самого старту.
// Журнал лежить у гілці journal; телефон і браузер читають його, тож статистика в них однакова.
//
// Використання: node tools/record.js <journal.json> [cache.json]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || 'journal.json';
const CACHE = process.argv[3] || null;
const WINDOW_H = 48;
const KEEP_DAYS = 60;

// ---------- середовище браузера, якого потребують файли додатка ----------
global.window = global;
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const kv = new Map(), st = new Map();
if (CACHE && fs.existsSync(CACHE)) {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8')))) kv.set(k, v); } catch {}
}
global.FP = {
  store: {
    ready: Promise.resolve(),
    get: (s, k) => (s === 'kv' ? kv : st).get(k),
    put: (s, k, v) => (s === 'kv' ? kv : st).set(k, v),
    clear: s => (s === 'kv' ? kv : st).clear(),
    isLoaded: () => true,
  },
};
for (const f of ['config.js', 'api.js', 'model.js', 'history.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f });
}
const { api, model, LEAGUES, LEAGUE_BY_SLUG } = FP;

// ---------- моделі (як buildModel у js/app.js) ----------
const models = new Map();
async function buildModel(slug) {
  if (models.has(slug)) return models.get(slug);
  const league = LEAGUE_BY_SLUG.get(slug);
  let entry;
  try {
    let domestic = null;
    if (league.cup) {
      domestic = new Map();
      for (const l of LEAGUES.filter(x => !x.cup)) {
        const e = await buildModel(l.slug);
        if (!e || e.error) continue;
        for (const t of e.m.teams.values()) domestic.set(t.id, { att: t.att, def: t.def, q: l.q, slug: l.slug, season: e.season && e.season.year });
      }
    }
    const season = await api.season(slug, false, !league.cup);
    const results = season.events.filter(model.isResult).length;
    entry = !results && !league.cup
      ? { error: 'no results', events: season.events }
      : { m: model.build(league, season.events, domestic, season.previous), season: season.info, events: season.events };
  } catch (e) {
    entry = { error: e.message, events: [] };
  }
  models.set(slug, entry);
  return entry;
}

// Сезонна статистика команди: для єврокубків — з її чемпіонату (як statsSource у js/app.js).
const teamStats = new Map();
async function statsFor(slug, entry, teamId) {
  if (teamStats.has(teamId)) return teamStats.get(teamId);
  let src = null;
  if (!entry.m.league.cup) src = entry.season ? { slug, season: entry.season.year } : null;
  else {
    const t = entry.m.teams.get(teamId);
    src = t && t.domestic && t.domestic.season ? { slug: t.domestic.slug, season: t.domestic.season } : null;
  }
  let s = null;
  if (src) { try { s = await api.teamSeasonStats(src.slug, src.season, teamId); } catch {} }
  teamStats.set(teamId, s);
  return s;
}

(async () => {
  const now = Date.now() / 1000;
  let journal = { version: null, entries: {} };
  if (fs.existsSync(OUT)) { try { journal = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {} }
  if (journal.version !== FP.STATS_VERSION) journal = { version: FP.STATS_VERSION, entries: {} };
  const before = JSON.stringify(journal.entries);

  // Які турніри мають матчі у вікні: поточний місяць (і наступний — біля кінця місяця).
  const months = api.monthsAround([FP.localDate(0), FP.localDate(1)]);
  const upcoming = [];
  await api.pool(LEAGUES, 6, async l => {
    for (const m of months) {
      try {
        for (const ev of (await api.month(l.slug, m)).events) {
          if (ev.state === 'pre' && ev.ts > now + 60 && ev.ts < now + WINDOW_H * 3600 && ev.ts >= FP.STATS_FROM
            && !/POSTPONED|CANCELED|ABANDONED/.test(ev.status)) upcoming.push({ slug: l.slug, ev });
        }
      } catch {}
    }
  });
  const uniq = [...new Map(upcoming.map(x => [x.ev.id, x])).values()];

  // Спершу чемпіонати, потім єврокубки (їм потрібні рейтинги чемпіонатів).
  const slugs = [...new Set(uniq.map(x => x.slug))];
  for (const s of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) await buildModel(s);

  let written = 0;
  for (const { slug, ev } of uniq) {
    const entry = models.get(slug);
    if (!entry || entry.error) continue;
    const ctx = { home: await statsFor(slug, entry, ev.home.id), away: await statsFor(slug, entry, ev.away.id) };
    const pred = model.predict(entry.m, ev, ctx);
    if (!pred) continue;
    journal.entries[ev.id] = FP.history.entryOf(slug, ev, pred);
    written++;
  }

  const cutoff = now - KEEP_DAYS * 86400;
  for (const id of Object.keys(journal.entries)) if (journal.entries[id].ts < cutoff) delete journal.entries[id];

  const changed = JSON.stringify(journal.entries) !== before;
  if (changed) {
    journal.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(journal));
  }
  if (CACHE) {
    // Кешуємо лише минулі місяці й минулі сезони — вони не змінюються.
    const keep = {};
    for (const [k, v] of kv) if (/^pm:/.test(k) || (/^m:/.test(k) && !months.some(m => k.endsWith(':' + m)))) keep[k] = v;
    fs.writeFileSync(CACHE, JSON.stringify(keep));
  }
  console.log(`matches in window: ${uniq.length}, written: ${written}, journal: ${Object.keys(journal.entries).length}, changed: ${changed}`);
  process.exit(0);
})();
