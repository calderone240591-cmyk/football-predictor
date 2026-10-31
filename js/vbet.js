// Коефіцієнти VBET (vbet.ua). Пріоритетне джерело кф: якщо матч є в лінії VBET, прогноз і цінні
// ставки рахуються за його кф, інакше — за DraftKings з ESPN.
//
// VBET працює на платформі BetConstruct: лінію віддає WebSocket-сервер Swarm, яким користується
// сам сайт. Це неофіційний інтерфейс (як і ESPN), тож формат може змінитися — тоді VBET просто
// не знайде матчів, і додаток сам повернеться до DraftKings.
FP.vbet = (() => {
  const SOCKET = 'wss://eu-swarm-newm.betcoswarm.com/';
  const SITE_ID = 18746530;   // vbet.ua (з https://www.vbet.ua/conf.json)
  const TTL = 2 * 60 * 1000;
  const TIMEOUT = 15000;

  // Турнір ESPN → ID турніру в VBET.
  const COMPS = {
    'uefa.champions': 566, 'uefa.europa': 1861, 'uefa.europa.conf': 18278410,
    'eng.1': 538, 'esp.1': 545, 'ita.1': 543, 'ger.1': 541, 'fra.1': 548, 'ned.1': 1957, 'por.1': 560,
    'bel.1': 557, 'tur.1': 3013, 'eng.2': 539, 'sco.1': 555, 'aut.1': 556, 'gre.1': 1884, 'den.1': 1833,
    'bra.1': 1792, 'ger.2': 542, 'esp.2': 553, 'ita.2': 544, 'fra.2': 549, 'nor.1': 562, 'swe.1': 3000,
    'usa.1': 3025, 'arg.1': 1685, 'mex.1': 1951, 'ksa.1': 2971,
  };

  // Ринки VBET → ключі моделі (js/model.js). Тотали — лише лінії .5, фори — ті, що є в моделі.
  // Кутові 1-го тайму не беремо: ESPN рахує їх лише з текстового коментаря, якого немає в багатьох
  // лігах, тож такі ставки часто неможливо розрахувати.
  const TYPES = ['P1XP2', '1X12X2', 'OverUnder', 'AsianHandicap', 'HalfTimeOverUnder',
    'CornersOverUnder', 'YellowCardsOverUnder', 'RedCardsOverUnder'];
  const HCP = new Set([0, 1, -1, 1.5, -1.5, 2.5, -2.5]);
  const half = b => b != null && Math.abs(b * 2 % 2) === 1;
  const ou = (prefix, lines) => (mk, ev) => {
    const b = +mk.base;
    if (!lines(b)) return null;
    return /^over$/i.test(ev.type) ? `${prefix}O${b}` : /^under$/i.test(ev.type) ? `${prefix}U${b}` : null;
  };
  const MAP = {
    P1XP2: (mk, ev) => ({ P1: '1', X: 'X', P2: '2' }[ev.type] || null),
    '1X12X2': (mk, ev) => ({ '1X': '1X', X2: 'X2' }[ev.type] || null),
    OverUnder: (mk, ev) => {
      const b = +mk.base;
      if (![1.5, 2.5, 3.5].includes(b)) return null;
      const k = String(b).replace('.', '');
      return /^over$/i.test(ev.type) ? `O${k}` : /^under$/i.test(ev.type) ? `U${k}` : null;
    },
    AsianHandicap: (mk, ev) => {
      const b = +ev.base;
      if (!HCP.has(b) || !/^(home|away)$/i.test(ev.type)) return null;
      return `${/^home$/i.test(ev.type) ? 'H' : 'A'}${b > 0 ? '+' : ''}${b}`;
    },
    HalfTimeOverUnder: (mk, ev) => (/^over$/i.test(ev.type) && [0.5, 1.5].includes(+mk.base) ? `HTO${String(+mk.base).replace('.', '')}` : null),
    CornersOverUnder: ou('C', b => half(b) && b >= 7.5 && b <= 12.5),
    YellowCardsOverUnder: ou('Y', b => half(b) && b >= 2.5 && b <= 5.5),
    RedCardsOverUnder: ou('R', b => b === 0.5),
  };

  // ---------- запит до Swarm ----------
  function request(ids) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(SOCKET); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('VBET: немає відповіді')); }, TIMEOUT);
      const send = (rid, command, params) => ws.send(JSON.stringify({ command, params, rid }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('VBET: помилка з\'єднання')); };
      ws.onopen = () => send('s', 'request_session', { site_id: SITE_ID, language: 'eng' });
      ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.rid === 's') {
          if (m.code !== 0) { clearTimeout(timer); ws.close(); reject(new Error('VBET: сесію не відкрито')); return; }
          send('g', 'get', {
            source: 'betting',
            what: { competition: ['id'], game: ['id', 'team1_name', 'team2_name', 'start_ts'], market: ['type', 'base'], event: ['type', 'price', 'base'] },
            where: { sport: { alias: 'Soccer' }, competition: { id: { '@in': ids } }, game: { type: { '@in': [0, 2] } }, market: { type: { '@in': TYPES } } },
          });
        } else if (m.rid === 'g') {
          clearTimeout(timer);
          ws.close();
          if (m.code !== 0 || !m.data || !m.data.data) reject(new Error('VBET: лінію не отримано'));
          else resolve(m.data.data);
        }
      };
    });
  }

  // Матч VBET → { id, ts, home, away, book: { ключ ринку → кф } }.
  function slimGame(g) {
    const book = {};
    for (const mk of Object.values(g.market || {})) {
      const f = MAP[mk.type];
      if (!f) continue;
      for (const ev of Object.values(mk.event || {})) {
        const k = f(mk, ev);
        if (k && ev.price > 1) book[k] = ev.price;
      }
    }
    return { id: g.id, ts: g.start_ts, home: g.team1_name, away: g.team2_name, book };
  }

  let games = new Map();   // ID турніру VBET → [матчі]
  let loadedAt = 0, loading = null, lastError = null;

  // Завантажує лінію всіх турнірів (раз на 2 хв). Помилка не ламає додаток: кф беруться з DraftKings.
  function load(force) {
    if (loading) return loading;
    if (!force && loadedAt && Date.now() - loadedAt < TTL) return Promise.resolve();
    loading = request(Object.values(COMPS)).then(data => {
      const next = new Map();
      for (const [id, c] of Object.entries(data.competition || {})) {
        next.set(+id, Object.values(c.game || {}).map(slimGame).filter(g => Object.keys(g.book).length));
      }
      games = next;
      matched.clear();
      loadedAt = Date.now();
      lastError = null;
    }).catch(e => { lastError = e.message; loadedAt = Date.now(); }).finally(() => { loading = null; });
    return loading;
  }

  // ---------- зіставлення матчів ESPN і VBET ----------
  // За часом початку (±90 хв) і назвами команд: «Brighton & Hove Albion» = «Brighton and Hove Albion»,
  // «1. FC Köln» = «FC Koln» тощо.
  const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'cd', 'ud', 'sd', 'rc', 'us', 'fk', 'sk', 'if', 'bk', 'club', 'de', 'the', 'and', 'calcio', 'sv', 'vfl', 'vfb', 'tsg', 'ca', 'cs', 'se', 'rcd', 'ogc', 'losc', 'stade']);
  const tokens = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t) && !/^\d+$/.test(t));
  const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  function sim(a, b) {
    const x = tokens(a), y = tokens(b);
    if (!x.length || !y.length) return 0;
    const hit = x.filter(t => y.some(u => same(t, u))).length;
    return hit / Math.min(x.length, y.length);
  }

  const matched = new Map();   // id матчу ESPN → матч VBET або null
  function find(slug, ev) {
    if (matched.has(ev.id)) return matched.get(ev.id);
    const list = games.get(COMPS[slug]) || [];
    let best = null, bestScore = 0;
    for (const g of list) {
      const dt = Math.abs(g.ts - ev.ts);
      if (dt > 90 * 60) continue;
      const sh = Math.max(sim(ev.home.name, g.home), sim(ev.home.short, g.home));
      const sa = Math.max(sim(ev.away.name, g.away), sim(ev.away.short, g.away));
      const ok = (sh >= 0.5 && sa >= 0.5) || (dt <= 10 * 60 && sh + sa >= 1);
      if (ok && sh + sa > bestScore) { best = g; bestScore = sh + sa; }
    }
    if (loadedAt) matched.set(ev.id, best);
    return best;
  }

  // Кф для моделі у форматі ESPN (1X2 + тотал 2.5) плюс усі ринки VBET у book.
  function oddsOf(slug, ev) {
    const g = find(slug, ev);
    if (!g || !g.book['1'] || !g.book.X || !g.book['2']) return null;
    const b = g.book;
    const out = { provider: 'VBET', src: 'vbet', home: b['1'], draw: b.X, away: b['2'], book: b, game: g.id };
    if (b.O25 && b.U25) Object.assign(out, { line: 2.5, over: b.O25, under: b.U25 });
    return out;
  }

  // Матч з кф VBET (якщо він є в лінії) або як є — з кф DraftKings.
  function withOdds(slug, ev) {
    if (ev.state !== 'pre') return ev;
    const o = oddsOf(slug, ev);
    return o ? { ...ev, odds: o } : ev;
  }

  const status = () => ({ loadedAt, error: lastError, games: [...games.values()].reduce((s, l) => s + l.length, 0) });

  return { load, withOdds, status, COMPS };
})();
