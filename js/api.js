// Дані ESPN: безкоштовно, без ключа, поточний сезон, запити дозволені прямо з браузера.
// Це неофіційний публічний API, тож формат може змінитися.
//
// Матчі вантажимо помісячно (одна відповідь містить усі матчі турніру за місяць —
// і зіграні з рахунком, і майбутні з коефіцієнтами букмекера). Минулі місяці
// кешуються надовго, поточний оновлюється кожні 2 хвилини.
FP.api = (() => {
  // Саме site.web.api — браузери блокують запити до site.api.espn.com, хоча дані ті самі.
  const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/';
  const STANDINGS = 'https://site.web.api.espn.com/apis/v2/sports/soccer/';
  const CACHE_PREFIX = 'fpe:';
  const MIN = 60 * 1000;
  const TTL_PAST_MONTH = 3 * 24 * 60 * MIN;
  const TTL_CURRENT_MONTH = 2 * MIN;
  const TTL_FUTURE_MONTH = 30 * MIN;
  const TTL_STANDINGS = 20 * MIN;
  const TTL_LINEUPS_EMPTY = 5 * MIN;
  const TTL_LINEUPS_READY = 12 * 60 * MIN;

  // Прибираємо дані попередньої версії (API-Football), щоб не займали місце.
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('fpc:') || k === 'fp_key' || k === 'fp_req')
      .forEach(k => localStorage.removeItem(k));
  } catch {}

  function cacheEntry(k) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + k);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function cacheSet(k, data) {
    const value = JSON.stringify({ t: Date.now(), data });
    try {
      localStorage.setItem(CACHE_PREFIX + k, value);
    } catch {
      clearCache();
      try { localStorage.setItem(CACHE_PREFIX + k, value); } catch {}
    }
  }

  function clearCache() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  async function getJson(url) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('Немає з\'єднання з сервером даних. Перевірте інтернет.');
    }
    if (!res.ok) throw new Error(`Сервер даних відповів помилкою (${res.status}).`);
    return res.json();
  }

  // Якщо мережа недоступна, віддаємо застарілий кеш, ніж нічого.
  async function cached(k, ttl, url, transform, force) {
    const e = cacheEntry(k);
    if (!force && e && Date.now() - e.t < ttl) return e.data;
    try {
      const data = transform(await getJson(url));
      cacheSet(k, data);
      return data;
    } catch (err) {
      if (e) return e.data;
      throw err;
    }
  }

  // ---------- перетворення відповідей ESPN у компактний вигляд ----------

  // Американський коефіцієнт (+145 / -260 / EVEN) → десятковий (2.45 / 1.38 / 2.00).
  function decimalOdds(s) {
    if (s == null) return null;
    const str = String(s).trim().toUpperCase();
    if (str === 'EVEN' || str === 'EV') return 2;
    const n = parseFloat(str);
    if (!isFinite(n) || n === 0) return null;
    const d = n > 0 ? 1 + n / 100 : 1 + 100 / -n;
    return Math.round(d * 100) / 100;
  }

  const closeOdds = x => x && ((x.close && x.close.odds) || (x.open && x.open.odds));

  function slimOdds(o) {
    if (!o) return null;
    const ml = o.moneyline || {};
    const home = decimalOdds(closeOdds(ml.home));
    const away = decimalOdds(closeOdds(ml.away));
    const draw = decimalOdds(closeOdds(ml.draw)) || decimalOdds(o.drawOdds && o.drawOdds.moneyLine);
    if (!home || !away || !draw) return null;
    const out = { home, draw, away, provider: o.provider && (o.provider.displayName || o.provider.name) };
    const t = o.total || {};
    const over = t.over && (t.over.close || t.over.open);
    const under = t.under && (t.under.close || t.under.open);
    const line = over && parseFloat(String(over.line || '').replace(/[^\d.]/g, ''));
    if (line && [1.5, 2.5, 3.5].includes(line)) {
      out.line = line;
      out.over = decimalOdds(over.odds);
      out.under = decimalOdds(under && under.odds);
    }
    return out;
  }

  function slimSide(c, ha) {
    const t = c.competitors.find(x => x.homeAway === ha) || {};
    const team = t.team || {};
    const score = t.score === undefined || t.score === null || t.score === '' ? null : Number(t.score);
    return { id: String(team.id), name: team.displayName, short: team.shortDisplayName, logo: team.logo, score };
  }

  function slimEvent(e) {
    const c = e.competitions[0];
    const st = e.status.type;
    return {
      id: String(e.id),
      ts: Math.floor(Date.parse(e.date) / 1000),
      state: st.state,                 // pre / in / post
      status: st.name,                 // STATUS_FULL_TIME, STATUS_POSTPONED…
      completed: !!st.completed,
      clock: e.status.displayClock,
      detail: st.shortDetail,
      season: e.season && e.season.year,
      round: c.notes && c.notes[0] && c.notes[0].headline,
      home: slimSide(c, 'home'),
      away: slimSide(c, 'away'),
      odds: slimOdds(c.odds && c.odds[0]),
    };
  }

  function slimMonth(d) {
    const l = d.leagues && d.leagues[0];
    return {
      season: l && l.season ? { year: l.season.year, start: l.season.startDate, name: l.season.displayName } : null,
      events: (d.events || []).map(slimEvent),
    };
  }

  function slimStandings(d) {
    const rows = [];
    for (const ch of d.children || []) {
      for (const e of (ch.standings && ch.standings.entries) || []) {
        const s = Object.fromEntries((e.stats || []).map(x => [x.name, x.value]));
        rows.push({
          group: ch.name,
          team: { id: String(e.team.id), name: e.team.displayName, logo: e.team.logos && e.team.logos[0] && e.team.logos[0].href },
          rank: s.rank, p: s.gamesPlayed, w: s.wins, d: s.ties, l: s.losses,
          gf: s.pointsFor, ga: s.pointsAgainst, gd: s.pointDifferential, pts: s.points,
          note: e.note && e.note.description,
        });
      }
    }
    return rows;
  }

  function slimSummary(d) {
    return (d.rosters || []).map(r => ({
      homeAway: r.homeAway,
      team: String(r.team && r.team.id),
      formation: r.formation,
      xi: (r.roster || []).filter(p => p.starter).map(p => ({
        name: p.athlete && p.athlete.displayName, number: p.jersey, pos: p.position && p.position.abbreviation,
      })),
    })).filter(r => r.xi.length);
  }

  // ---------- публічні функції ----------

  const ym = d => `${d.getFullYear()}${FP.pad(d.getMonth() + 1)}`;

  function monthTtl(month) {
    const now = ym(new Date());
    return month < now ? TTL_PAST_MONTH : month === now ? TTL_CURRENT_MONTH : TTL_FUTURE_MONTH;
  }

  const month = (slug, m, force) =>
    cached(`m:${slug}:${m}`, monthTtl(m), `${SITE}${slug}/scoreboard?dates=${m}&limit=500`, slimMonth, force);

  // Місяці, які покривають вказані локальні дати (з запасом ±1 день на різницю часових поясів).
  function monthsAround(dates) {
    const set = new Set();
    for (const s of dates) {
      for (const shift of [-1, 0, 1]) {
        const d = new Date(`${s}T12:00:00`);
        d.setDate(d.getDate() + shift);
        set.add(ym(d));
      }
    }
    return [...set].sort();
  }

  // Минулий сезон потрібен лише моделі: зберігаємо в мінімальному вигляді і надовго.
  const lite = s => ({ id: s.id, score: s.score });
  const monthLite = (slug, m) =>
    cached(`pm:${slug}:${m}`, 30 * 24 * 60 * MIN, `${SITE}${slug}/scoreboard?dates=${m}&limit=500`,
      d => ({
        events: (d.events || []).map(slimEvent).filter(e => e.state === 'post' && e.completed)
          .map(e => ({ id: e.id, ts: e.ts, state: e.state, completed: e.completed, season: e.season, home: lite(e.home), away: lite(e.away) })),
      }));

  async function previousSeason(slug, info) {
    if (!info || !info.start) return [];
    const start = new Date(info.start);
    const months = [];
    const d = new Date(start.getFullYear() - 1, start.getMonth(), 1);
    while (d < new Date(start.getFullYear(), start.getMonth(), 1)) { months.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    const parts = await pool(months, 4, m => monthLite(slug, m).catch(() => ({ events: [] })));
    const byId = new Map();
    for (const p of parts) for (const e of p.events) if (e.season === info.year - 1) byId.set(e.id, e);
    return [...byId.values()];
  }

  // Усі матчі поточного сезону турніру: від місяця старту сезону до наступного місяця.
  // withPrevious — додати результати минулого сезону (для рейтингів на початку сезону).
  async function season(slug, force, withPrevious) {
    const now = new Date();
    const cur = await month(slug, ym(now), force);
    const info = cur.season;
    const start = info && info.start ? new Date(info.start) : new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const months = [];
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    while (d <= next) { months.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    const parts = await pool(months, 4, m => (m === ym(now) ? cur : month(slug, m, force)));
    const byId = new Map();
    for (const p of parts) {
      for (const e of p.events) if (!info || e.season === info.year) byId.set(e.id, e);
    }
    const previous = withPrevious ? await previousSeason(slug, info) : [];
    return { info, events: [...byId.values()].sort((a, b) => a.ts - b.ts), previous };
  }

  const standings = (slug, force) =>
    cached(`st:${slug}`, TTL_STANDINGS, `${STANDINGS}${slug}/standings`, slimStandings, force);

  async function lineups(slug, eventId) {
    const k = `ln:${eventId}`;
    const e = cacheEntry(k);
    if (e && Date.now() - e.t < (e.data.length ? TTL_LINEUPS_READY : TTL_LINEUPS_EMPTY)) return e.data;
    return cached(k, 0, `${SITE}${slug}/summary?event=${eventId}`, slimSummary, true);
  }

  // Факти зіграного матчу для розрахунку ставок: рахунок першого тайму, кутові, жовті картки.
  // Матч уже не зміниться, тож кешуємо надовго.
  function matchFacts(slug, eventId) {
    return cached(`mf:${eventId}`, 60 * 24 * 60 * MIN, `${SITE}${slug}/summary?event=${eventId}`, d => {
      const comp = d.header && d.header.competitions && d.header.competitions[0];
      const side = ha => (comp ? comp.competitors.find(c => c.homeAway === ha) : null);
      const h = side('home'), a = side('away');
      const first = c => (c && c.linescores && c.linescores[0] ? Number(c.linescores[0].displayValue) : null);
      const stat = (teamId, name) => {
        const t = ((d.boxscore && d.boxscore.teams) || []).find(x => String(x.team.id) === String(teamId));
        const s = t && (t.statistics || []).find(x => x.name === name);
        return s ? Number(s.displayValue) : null;
      };
      const ht = first(h) != null && first(a) != null ? { home: first(h), away: first(a) } : null;
      const hc = h && stat(h.id, 'wonCorners'), ac = a && stat(a.id, 'wonCorners');
      const hy = h && stat(h.id, 'yellowCards'), ay = a && stat(a.id, 'yellowCards');
      const box = [hc, ac, hy, ay].every(v => v != null && !isNaN(v))
        ? { homeCorners: hc, awayCorners: ac, homeYellow: hy, awayYellow: ay } : null;
      return { ht, box };
    });
  }

  // Сезонна статистика команди: xG, кутові, картки, удари. Для ліг без xG ESPN віддає нулі —
  // тоді xG вважаємо недоступним.
  const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/';
  function teamSeasonStats(slug, season, teamId) {
    return cached(`ts:${slug}:${season}:${teamId}`, 6 * 60 * MIN,
      `${CORE}${slug}/seasons/${season}/types/1/teams/${teamId}/statistics`,
      d => {
        const s = {};
        for (const c of (d.splits && d.splits.categories) || []) for (const x of c.stats) s[x.name] = x.value;
        const app = s.appearances || 0;
        const hasXg = !!(s.avgExpectedGoalsConceded || s.avgExpectedGoalDifferential);
        return {
          app,
          cornersFor: s.wonCorners || 0,
          cornersAgainst: s.lostCorners || 0,
          yellow: s.yellowCards || 0,
          red: s.redCards || 0,
          fouls: s.foulsCommitted || 0,
          shots: s.totalShots || 0,
          shotsOnTarget: s.shotsOnTarget || 0,
          shotsFaced: s.shotsFaced || 0,
          cleanSheets: s.cleanSheet || 0,
          possession: s.possessionPct || null,
          xgf: hasXg ? (s.avgExpectedGoalDifferential || 0) + (s.avgExpectedGoalsConceded || 0) : null,
          xga: hasXg ? s.avgExpectedGoalsConceded || 0 : null,
        };
      });
  }

  // Виконує fn для кожного елемента, не більше n запитів одночасно.
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  return { month, monthsAround, season, standings, lineups, teamSeasonStats, matchFacts, clearCache, pool };
})();
