// Аналітична модель.
//
// 1. Рейтинги команд будуються з результатів сезону: сила атаки й оборони з урахуванням
//    суперників, свіжі матчі важать більше, минулий сезон враховується з меншою вагою.
// 2. У єврокубках відправна точка рейтингу — рейтинг команди у своєму чемпіонаті,
//    перерахований з урахуванням сили чемпіонату.
// 3. Якщо для ліги є xG (очікувані голи за якістю моментів), рейтинги поєднуються з ними:
//    xG стабільніший за реальні голи і краще передбачає майбутнє.
// 4. Очікувані голи → Пуассон з поправкою Діксона–Коулза → ймовірності всіх рахунків і ринків.
// 5. Якщо є коефіцієнти букмекера, ймовірності поєднуються з ринковими (30/70):
//    ринок враховує склади, травми й новини, яких модель не бачить.
// 6. Кутові й картки — окремі моделі за сезонною статистикою команд (від’ємний біноміальний
//    розподіл, бо розкид цих подій більший, ніж у Пуассона).
FP.model = (() => {
  const PRIOR_GAMES = 4;      // «віртуальні» матчі, що тягнуть рейтинг до середнього / до домашнього рейтингу
  const CUP_PRIOR_GAMES = 6;
  const HALF_LIFE_DAYS = 120; // вага матчу чотиримісячної давності — половина
  const RHO = -0.08;          // поправка Діксона–Коулза на рахунки 0:0, 1:0, 0:1, 1:1
  const MAX_GOALS = 10;
  const MARKET_WEIGHT = 0.7;  // ринок зазвичай точніший за чисту статистику
  const XG_WEIGHT = 0.4;      // частка xG в рейтингах, коли xG доступний
  const FIRST_HALF_SHARE = 0.44;
  const MIN_TIP_ODDS = 2.01;  // основні ставки — кф від 2.01
  const VALUE_EDGE = 0.03;    // мінімальна перевага над букмекером, щоб назвати ставку цінною
  const MIN_VALUE_ODDS = 1.51; // цінні ставки — кф букмекера від 1.51

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // Калібрування за бектестом (1091 зіграний матч 25 чемпіонатів за 45 днів, прогноз за даними
  // до матчу; підбір на старших матчах, перевірка на свіжіших): модель недооцінювала голи —
  // господарям ×1.06, гостям ×1.12. Середня кількість карток збігалась, але розкид був зашироким:
  // для карток розподіл майже пуассонівський (1.05), для кутових — ширший (1.45).
  const TUNE = { home: 1.06, away: 1.12, cards: 1 };
  const CORNERS_DISP = 1.45;
  const CARDS_DISP = 1.05;

  const isResult = e => e.state === 'post' && e.completed && e.home.score != null && e.away.score != null;

  // ---------- рейтинги ----------
  // prior(teamId) → { att, def } — відправна точка; null — середній рівень (1, 1).
  // previous — результати минулого сезону: беруть участь із меншою вагою (через давність).
  // Нормалізація (середня команда = 1.00) рахується лише по командах поточного сезону.
  // asOf (секунди) — рахувати ваги матчів станом на цей момент (для відтворення минулих прогнозів).
  function fit(events, previous, prior, priorGames, normalize, asOf) {
    const now = asOf || Date.now() / 1000;
    const current = new Set();
    for (const e of events) { current.add(e.home.id); current.add(e.away.id); }
    const matches = events.concat(previous || []).filter(isResult).map(e => ({
      h: e.home.id, a: e.away.id, hg: e.home.score, ag: e.away.score, ts: e.ts,
      w: Math.pow(0.5, Math.max(0, now - e.ts) / 86400 / HALF_LIFE_DAYS),
    }));

    let sh = 0, sa = 0, sw = 0;
    for (const m of matches) { sh += m.w * m.hg; sa += m.w * m.ag; sw += m.w; }
    const avgH = (sh + 1.45 * 15) / (sw + 15);
    const avgA = (sa + 1.15 * 15) / (sw + 15);
    const avgG = (avgH + avgA) / 2;

    const ids = new Set(current);
    for (const m of matches) { ids.add(m.h); ids.add(m.a); }
    const p0 = new Map([...ids].map(id => [id, (prior && prior(id)) || { att: 1, def: 1 }]));
    const att = new Map([...ids].map(id => [id, p0.get(id).att]));
    const def = new Map([...ids].map(id => [id, p0.get(id).def]));
    const kk = priorGames * avgG;

    for (let it = 0; it < 25; it++) {
      const acc = new Map([...ids].map(id => [id, { gf: 0, ef: 0, ga: 0, ea: 0 }]));
      for (const m of matches) {
        const H = acc.get(m.h), A = acc.get(m.a);
        H.gf += m.w * m.hg; H.ef += m.w * avgH * def.get(m.a);
        H.ga += m.w * m.ag; H.ea += m.w * avgA * att.get(m.a);
        A.gf += m.w * m.ag; A.ef += m.w * avgA * def.get(m.h);
        A.ga += m.w * m.hg; A.ea += m.w * avgH * att.get(m.h);
      }
      for (const id of ids) {
        const x = acc.get(id), p = p0.get(id);
        att.set(id, (x.gf + kk * p.att) / (x.ef + kk));
        def.set(id, (x.ga + kk * p.def) / (x.ea + kk));
      }
      if (normalize) {
        const ma = mean(att, current), md = mean(def, current);
        for (const id of ids) { att.set(id, att.get(id) / ma); def.set(id, def.get(id) / md); }
      }
    }
    return { avgH, avgA, att, def, matches, current };
  }

  const mean = (m, only) => {
    let s = 0, n = 0;
    for (const [k, v] of m) if (only.has(k)) { s += v; n++; }
    return n ? s / n : 1;
  };

  const emptyStats = () => ({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, home: { p: 0, gf: 0, ga: 0 }, away: { p: 0, gf: 0, ga: 0 }, form: '' });

  // Статистика команди для пояснень і таблиці.
  function teamStats(events) {
    const out = new Map();
    const get = id => {
      if (!out.has(id)) out.set(id, emptyStats());
      return out.get(id);
    };
    for (const e of events.filter(isResult)) {
      for (const [side, other, venue] of [[e.home, e.away, 'home'], [e.away, e.home, 'away']]) {
        const t = get(side.id);
        const r = side.score > other.score ? 'W' : side.score === other.score ? 'D' : 'L';
        t.p++; t.gf += side.score; t.ga += other.score;
        t[{ W: 'w', D: 'd', L: 'l' }[r]]++;
        t.pts += { W: 3, D: 1, L: 0 }[r];
        t[venue].p++; t[venue].gf += side.score; t[venue].ga += other.score;
        t.form = (t.form + r).slice(-5);   // від старіших до свіжіших
      }
    }
    return out;
  }

  // league — запис з FP.LEAGUES; domestic — Map teamId → { att, def, q } з рейтингів чемпіонатів;
  // previous — результати минулого сезону того ж чемпіонату (для єврокубків не використовуються).
  function build(league, events, domestic, previous, asOf) {
    let prior = null;
    if (league.cup) {
      prior = id => {
        const d = domestic && domestic.get(id);
        const rel = (d ? d.q : FP.UNKNOWN_Q) / FP.CUP_Q;
        return d ? { att: d.att * rel, def: d.def / rel } : { att: rel, def: 1 / rel };
      };
    } else if (previous && previous.length) {
      // Команди, яких не було в лізі минулого сезону, переважно піднялися з нижчого дивізіону.
      const before = new Set();
      for (const e of previous) { before.add(e.home.id); before.add(e.away.id); }
      prior = id => (before.has(id) ? null : { att: 0.85, def: 1.15 });
    }
    const f = fit(events, league.cup ? null : previous, prior, league.cup ? CUP_PRIOR_GAMES : PRIOR_GAMES, !league.cup, asOf);
    const stats = teamStats(events);
    const teams = new Map();
    for (const id of f.current) {
      const s = stats.get(id) || emptyStats();
      teams.set(id, {
        id, att: f.att.get(id), def: f.def.get(id), stats: s,
        ppg: s.p ? s.pts / s.p : 0,
        domestic: league.cup && domestic ? domestic.get(id) : null,
      });
    }
    return { league, avgH: f.avgH, avgA: f.avgA, teams, results: events.filter(isResult).length, previous: (previous || []).length };
  }

  // Множник форми: команда в кращій формі, ніж її середній рівень за сезон, — до +6% до голів.
  function formFactor(t) {
    const f = t.stats.form;
    if (!f.length || !t.stats.p) return 1;
    const ppg5 = [...f].reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0) / f.length;
    return 1 + clamp((ppg5 - t.ppg) * 0.05, -0.06, 0.06);
  }

  // ---------- розподіли ----------
  function poissonPmf(lambda, max = MAX_GOALS) {
    const out = [Math.exp(-lambda)];
    for (let k = 1; k <= max; k++) out.push(out[k - 1] * lambda / k);
    return out;
  }

  // Від'ємний біноміальний розподіл із середнім mean і дисперсією mean × disp (disp > 1).
  function negBinPmf(mean, disp, max) {
    if (disp <= 1.0001) return poissonPmf(mean, max);
    const r = mean / (disp - 1);
    const q = r / (r + mean);
    const out = [Math.pow(q, r)];
    for (let k = 1; k <= max; k++) out.push(out[k - 1] * (k - 1 + r) / k * (1 - q));
    return out;
  }

  const tailOver = (pmf, line) => pmf.reduce((s, v, k) => s + (k > line ? v : 0), 0);

  function tau(h, a, lh, la) {
    if (h === 0 && a === 0) return 1 - lh * la * RHO;
    if (h === 0 && a === 1) return 1 + lh * RHO;
    if (h === 1 && a === 0) return 1 + la * RHO;
    if (h === 1 && a === 1) return 1 - RHO;
    return 1;
  }

  function grid(lh, la) {
    const ph = poissonPmf(lh), pa = poissonPmf(la);
    const g = [];
    let total = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      g.push([]);
      for (let a = 0; a <= MAX_GOALS; a++) {
        const v = Math.max(0, ph[h] * pa[a] * tau(h, a, lh, la));
        g[h].push(v);
        total += v;
      }
    }
    for (const row of g) for (let a = 0; a < row.length; a++) row[a] /= total;
    return g;
  }

  function core(g, line) {
    let p1 = 0, px = 0, p2 = 0, over = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const v = g[h][a];
        if (h > a) p1 += v; else if (h === a) px += v; else p2 += v;
        if (line && h + a > line) over += v;
      }
    }
    return { p1, px, p2, over };
  }

  // Підбираємо очікувані голи так, щоб ймовірності 1X2 і тоталу збігались із цільовими —
  // тоді всі інші ринки (рахунки, фори, тайми…) залишаються узгодженими.
  function fitLambdas(target, line, lh0, la0) {
    const err = (lh, la) => {
      const c = core(grid(lh, la), line);
      let e = (c.p1 - target.p1) ** 2 + (c.px - target.px) ** 2 + (c.p2 - target.p2) ** 2;
      if (line && target.over != null) e += (c.over - target.over) ** 2;
      return e;
    };
    let best = { lh: lh0, la: la0, e: err(lh0, la0) };
    for (const step of [0.1, 0.03, 0.01]) {
      const span = step === 0.1 ? 1.5 : step * 5;
      const cl = best.lh, ca = best.la;
      for (let lh = Math.max(0.1, cl - span); lh <= cl + span; lh += step) {
        for (let la = Math.max(0.1, ca - span); la <= ca + span; la += step) {
          const e = err(lh, la);
          if (e < best.e) best = { lh, la, e };
        }
      }
    }
    return best;
  }

  // Ринкові ймовірності без маржі букмекера.
  function marketProbs(odds) {
    if (!odds) return null;
    const i1 = 1 / odds.home, ix = 1 / odds.draw, i2 = 1 / odds.away;
    const s = i1 + ix + i2;
    const out = { p1: i1 / s, px: ix / s, p2: i2 / s, margin: s - 1 };
    if (odds.line && odds.over && odds.under) {
      const io = 1 / odds.over, iu = 1 / odds.under;
      out.over = io / (io + iu);
      out.line = odds.line;
    }
    return out;
  }

  // ---------- ринки ----------
  // Ринки за рахунком основного часу. hit(h, a) → true / false / null (повернення ставки).
  // Набір ринків: П1, П2, 1X, X2, фори (0, ±1, ±1.5, ±2.5), тотал голів (1.5 / 2.5 / 3.5),
  // ТБ голів 1-го тайму, кутові (матч і 1-й тайм), жовті картки матчу, червоні картки матчу.
  // Нічия рахується (потрібна для ймовірностей 1X2), але не рекомендується.
  const G = {
    RES: 'Результат', HCP: 'Фори', TOT: 'Тотал голів', HT: 'Голи 1-й тайм',
    CORN1: 'Кутові 1-й тайм', CORN: 'Кутові', CARD: 'Жовті картки', RED: 'Червоні картки',
  };

  const SCORE_MARKETS = [
    ['1', G.RES, 'П1', 'Перемога господарів', (h, a) => h > a],
    ['X', G.RES, 'Нічия', 'Нічия', (h, a) => h === a],
    ['2', G.RES, 'П2', 'Перемога гостей', (h, a) => h < a],
    ['1X', G.RES, '1X', 'Господарі не програють (1X)', (h, a) => h >= a],
    ['X2', G.RES, 'X2', 'Гості не програють (X2)', (h, a) => h <= a],

    ['O15', G.TOT, 'ТБ 1.5', 'Тотал більше 1.5', (h, a) => h + a >= 2],
    ['U15', G.TOT, 'ТМ 1.5', 'Тотал менше 1.5', (h, a) => h + a <= 1],
    ['O25', G.TOT, 'ТБ 2.5', 'Тотал більше 2.5', (h, a) => h + a >= 3],
    ['U25', G.TOT, 'ТМ 2.5', 'Тотал менше 2.5', (h, a) => h + a <= 2],
    ['O35', G.TOT, 'ТБ 3.5', 'Тотал більше 3.5', (h, a) => h + a >= 4],
    ['U35', G.TOT, 'ТМ 3.5', 'Тотал менше 3.5', (h, a) => h + a <= 3],

    // Фори 0 і ±1 — з поверненням ставки (null): Ф1 (0) при нічиїй, Ф1 (−1) при перемозі в один м'яч тощо.
    ['H0', G.HCP, 'Ф1 (0)', 'Фора господарів 0 (при нічиїй — повернення)', (h, a) => (h === a ? null : h > a)],
    ['A0', G.HCP, 'Ф2 (0)', 'Фора гостей 0 (при нічиїй — повернення)', (h, a) => (h === a ? null : a > h)],
    ['H-1', G.HCP, 'Ф1 (−1)', 'Фора господарів −1 (перемога в один м\'яч — повернення)', (h, a) => (h - a === 1 ? null : h - a >= 2)],
    ['H+1', G.HCP, 'Ф1 (+1)', 'Фора господарів +1 (поразка в один м\'яч — повернення)', (h, a) => (a - h === 1 ? null : h >= a)],
    ['A-1', G.HCP, 'Ф2 (−1)', 'Фора гостей −1 (перемога в один м\'яч — повернення)', (h, a) => (a - h === 1 ? null : a - h >= 2)],
    ['A+1', G.HCP, 'Ф2 (+1)', 'Фора гостей +1 (поразка в один м\'яч — повернення)', (h, a) => (h - a === 1 ? null : a >= h)],
    ['H-1.5', G.HCP, 'Ф1 (−1.5)', 'Фора господарів −1.5 (виграють з різницею 2+)', (h, a) => h - a >= 2],
    ['H+1.5', G.HCP, 'Ф1 (+1.5)', 'Фора господарів +1.5 (не програють з різницею 2+)', (h, a) => a - h <= 1],
    ['H-2.5', G.HCP, 'Ф1 (−2.5)', 'Фора господарів −2.5 (виграють з різницею 3+)', (h, a) => h - a >= 3],
    ['H+2.5', G.HCP, 'Ф1 (+2.5)', 'Фора господарів +2.5', (h, a) => a - h <= 2],
    ['A-1.5', G.HCP, 'Ф2 (−1.5)', 'Фора гостей −1.5 (виграють з різницею 2+)', (h, a) => a - h >= 2],
    ['A+1.5', G.HCP, 'Ф2 (+1.5)', 'Фора гостей +1.5 (не програють з різницею 2+)', (h, a) => h - a <= 1],
    ['A-2.5', G.HCP, 'Ф2 (−2.5)', 'Фора гостей −2.5 (виграють з різницею 3+)', (h, a) => a - h >= 3],
    ['A+2.5', G.HCP, 'Ф2 (+2.5)', 'Фора гостей +2.5', (h, a) => h - a <= 2],
  ].map(([key, group, short, long, hit]) => ({ key, group, short, long, hit }));

  const MARKET_BY_KEY = new Map(SCORE_MARKETS.map(m => [m.key, m]));

  // Ринки, які не рекомендуються (рахуються лише для ймовірностей).
  const NOT_RECOMMENDED = new Set(['X']);

  // Ймовірність ринку з урахуванням повернень: P(виграш) / P(не повернення).
  function scoreMarketProb(g, mk) {
    let win = 0, push = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const r = mk.hit(h, a);
        if (r === true) win += g[h][a];
        else if (r === null) push += g[h][a];
      }
    }
    return push > 0 ? win / (1 - push) : win;
  }

  // ТБ голів 1-го тайму: Пуассон з часткою 44% очікуваних голів матчу.
  function halfMarkets(lh, la) {
    const p1 = poissonPmf((lh + la) * FIRST_HALF_SHARE, 12);
    return [
      { key: 'HTO05', group: G.HT, short: 'ТБ 0.5 1-й т.', long: 'Гол у 1-му таймі (ТБ 0.5)', p: tailOver(p1, 0.5) },
      { key: 'HTO15', group: G.HT, short: 'ТБ 1.5 1-й т.', long: '2+ голи в 1-му таймі (ТБ 1.5)', p: tailOver(p1, 1.5) },
    ];
  }

  // Частку 1-го тайму виміряно на 98 зіграних матчах (жовтень 2026): кутові — 44%.
  const CORNERS_1H_SHARE = 0.44;

  // Кутові й картки за сезонною статистикою команд (stats: { app, cornersFor, cornersAgainst, yellow, red }).
  function cornersCards(hs, as) {
    if (!hs || !as || !hs.app || !as.app) return null;
    const shrink = (v, n, prior, k = 3) => (v * n + prior * k) / (n + k);
    const hFor = shrink(hs.cornersFor / hs.app, hs.app, 5), hAg = shrink(hs.cornersAgainst / hs.app, hs.app, 5);
    const aFor = shrink(as.cornersFor / as.app, as.app, 5), aAg = shrink(as.cornersAgainst / as.app, as.app, 5);
    const ch = ((hFor + aAg) / 2) * 1.06;   // господарі зазвичай подають трохи більше кутових
    const ca = ((aFor + hAg) / 2) * 0.94;
    const cornersTotal = negBinPmf(ch + ca, CORNERS_DISP, 30);
    const corners1 = negBinPmf((ch + ca) * CORNERS_1H_SHARE, CORNERS_DISP, 20);
    const yh = shrink(hs.yellow / hs.app, hs.app, 2.0) * TUNE.cards, ya = shrink(as.yellow / as.app, as.app, 2.0) * TUNE.cards;
    const cardsTotal = negBinPmf(yh + ya, CARDS_DISP, 20);
    // Червоні картки рідкісні (≈ 0.2 за матч): сильне згладжування до середнього 0.1 на команду.
    const rh = shrink((hs.red || 0) / hs.app, hs.app, 0.1, 10), ra = shrink((as.red || 0) / as.app, as.app, 0.1, 10);
    const pRed = 1 - Math.exp(-(rh + ra));

    const out = [];
    const both = (pmf, key, group, label, lines, suffix = '') => {
      for (const line of lines) {
        const o = tailOver(pmf, line);
        out.push({ key: `${key}O${line}`, group, short: `${label} ТБ ${line}${suffix}`, long: `${group}: більше ${line}`, p: o });
        out.push({ key: `${key}U${line}`, group, short: `${label} ТМ ${line}${suffix}`, long: `${group}: менше ${line}`, p: 1 - o });
      }
    };
    both(corners1, 'C1', G.CORN1, 'Кут.', [3.5, 4.5, 5.5], ' 1-й т.');
    both(cornersTotal, 'C', G.CORN, 'Кут.', [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]);
    both(cardsTotal, 'Y', G.CARD, 'ЖК', [2.5, 3.5, 4.5, 5.5]);
    out.push({ key: 'RO0.5', group: G.RED, short: 'Червона — так', long: 'У матчі буде червона картка', p: pRed });
    out.push({ key: 'RU0.5', group: G.RED, short: 'Червона — ні', long: 'У матчі не буде червоної картки', p: 1 - pRed });
    return { markets: out, corners: { home: ch, away: ca }, cards: { home: yh, away: ya }, red: rh + ra };
  }

  // Які ринки мають коефіцієнт букмекера. VBET (js/vbet.js) дає готовий набір у book.
  function bookOdds(odds) {
    if (!odds) return {};
    if (odds.book) return odds.book;
    const out = { '1': odds.home, 'X': odds.draw, '2': odds.away };
    if (odds.line) {
      const k = String(odds.line).replace('.', '');
      if (odds.over) out[`O${k}`] = odds.over;
      if (odds.under) out[`U${k}`] = odds.under;
    }
    return out;
  }

  function confidence(p, minPlayed, hi = 0.70, mid = 0.60) {
    let level = p >= hi ? 3 : p >= mid ? 2 : 1;
    if (minPlayed < 4) level = Math.max(1, level - 1);
    return { level, label: ['', 'Низька', 'Середня', 'Висока'][level] };
  }
  // Для основних ставок (кф 2.01–4, ймовірність до 50%): висока — від 45%, середня — 38–45%.
  const tipConfidence = (p, minPlayed) => confidence(p, minPlayed, 0.45, 0.38);

  // ctx: { home, away } — сезонна статистика команд (xG, кутові, картки) або null.
  function predict(m, ev, ctx) {
    const H = m.teams.get(ev.home.id), A = m.teams.get(ev.away.id);
    if (!H || !A) return null;
    const hs = ctx && ctx.home, as = ctx && ctx.away;

    // Рейтинги, поєднані з xG (якщо він є для обох команд).
    const avgG = (m.avgH + m.avgA) / 2;
    const useXg = hs && as && hs.xgf != null && as.xgf != null && hs.app >= 3 && as.app >= 3;
    const blend = (r, x) => (useXg ? Math.pow(r, 1 - XG_WEIGHT) * Math.pow(clamp(x, 0.3, 3), XG_WEIGHT) : r);
    const hAtt = blend(H.att, useXg && hs.xgf / avgG), hDef = blend(H.def, useXg && hs.xga / avgG);
    const aAtt = blend(A.att, useXg && as.xgf / avgG), aDef = blend(A.def, useXg && as.xga / avgG);

    const mlh = clamp(m.avgH * hAtt * aDef * formFactor(H) * TUNE.home, 0.15, 4.5);
    const mla = clamp(m.avgA * aAtt * hDef * formFactor(A) * TUNE.away, 0.15, 4.5);
    const modelCore = core(grid(mlh, mla), ev.odds && ev.odds.line);

    const market = marketProbs(ev.odds);
    let lh = mlh, la = mla;
    if (market) {
      const mix = (x, y) => MARKET_WEIGHT * x + (1 - MARKET_WEIGHT) * y;
      const target = {
        p1: mix(market.p1, modelCore.p1), px: mix(market.px, modelCore.px), p2: mix(market.p2, modelCore.p2),
        over: market.over != null ? mix(market.over, modelCore.over) : null,
      };
      ({ lh, la } = fitLambdas(target, market.line, mlh, mla));
    }

    const g = grid(lh, la);

    const book = bookOdds(ev.odds);
    const scoreMarkets = SCORE_MARKETS.map(mk => ({ ...mk, p: scoreMarketProb(g, mk) }));
    const cc = cornersCards(hs, as);
    // Кутові й картки модель рахує лише за статистикою. Якщо букмекер дає обидві сторони лінії (VBET),
    // ймовірність — як і для голів: 70% ринок (без маржі) + 30% модель.
    const all = scoreMarkets.concat(halfMarkets(lh, la), cc ? cc.markets : [])
      .map(x => {
        let p = x.p;
        const m = /^(C1|C|Y|R)([OU])([\d.]+)$/.exec(x.key);
        const bo = m && book[`${m[1]}O${m[3]}`], bu = m && book[`${m[1]}U${m[3]}`];
        if (bo && bu) {
          const over = (1 / bo) / (1 / bo + 1 / bu);
          p = MARKET_WEIGHT * (m[2] === 'O' ? over : 1 - over) + (1 - MARKET_WEIGHT) * p;
        }
        const o = book[x.key] || null;
        return { ...x, p, odds: o, edge: o ? p * o - 1 : null };
      });
    const markets = all.slice().sort((x, y) => y.p - x.p);
    const prob = Object.fromEntries(all.map(x => [x.key, x.p]));

    // Мало даних — лише коли немає ні минулого сезону, ні (для єврокубків) рейтингу в чемпіонаті.
    const solid = m.previous || (m.league.cup && H.domestic && A.domestic);
    const minPlayed = solid ? 99 : Math.min(H.stats.p, A.stats.p);
    // Основна ставка — найімовірніший з усіх ринків з кф від 2.01: кф букмекера, якщо він є,
    // інакше справедливий (ймовірність до ~50%).
    const recommendable = markets.filter(x => !NOT_RECOMMENDED.has(x.key));
    const tipOdds = x => x.odds || 1 / x.p;
    const candidates = recommendable.filter(x => tipOdds(x) >= MIN_TIP_ODDS);
    const best = candidates[0];
    const tip = { ...best, conf: tipConfidence(best.p, minPlayed) };
    const alternatives = candidates.filter(x => x.key !== best.key && x.group !== best.group && x.p >= 0.38).slice(0, 3);
    // Цінна ставка — ринок з кф букмекера від 1.51, де наша ймовірність вища за закладену в кф.
    const valueBets = recommendable
      .filter(x => x.edge != null && x.odds >= MIN_VALUE_ODDS && x.edge >= VALUE_EDGE && x.p >= 0.30)
      .sort((x, y) => y.edge - x.edge);

    // Джерело кф: vbet — VBET, dk — DraftKings (ESPN).
    const src = ev.odds ? ev.odds.src || 'dk' : null;
    return {
      lh, la, model: { lh: mlh, la: mla, ...modelCore }, market, useXg,
      prob, markets, tip: tip.odds ? { ...tip, src } : tip, alternatives,
      value: valueBets[0] ? { ...valueBets[0], src } : null,
      corners: cc && cc.corners, cards: cc && cc.cards,
      lowData: minPlayed < 4, home: H, away: A,
      reasons: reasons(m, ev, H, A, mlh, mla, market, modelCore, minPlayed, useXg, hs, as, cc),
    };
  }

  const f2 = x => x.toFixed(2);
  const f1 = x => x.toFixed(1);
  const perGame = (g, p) => (p ? f2(g / p) : '—');
  const pc = x => Math.round(x * 100) + '%';

  function reasons(m, ev, H, A, mlh, mla, market, mc, minPlayed, useXg, hs, as, cc) {
    const h = H.stats, a = A.stats;
    const venue = (s, label) => (s.p ? `; ${label} ${perGame(s.gf, s.p)} забито і ${perGame(s.ga, s.p)} пропущено за гру` : '');
    const out = [
      `Статистична модель очікує ${f1(mlh)} : ${f1(mla)} голів.`,
      `${ev.home.name}: індекс атаки ${f2(H.att)}, оборони ${f2(H.def)}${venue(h.home, 'вдома')}.`,
      `${ev.away.name}: індекс атаки ${f2(A.att)}, оборони ${f2(A.def)}${venue(a.away, 'на виїзді')}.`,
    ];
    if (useXg) {
      out.push(`xG за гру: ${ev.home.name} ${f2(hs.xgf)} створює / ${f2(hs.xga)} дозволяє, ${ev.away.name} ${f2(as.xgf)} / ${f2(as.xga)}. xG враховано в рейтингах на ${Math.round(XG_WEIGHT * 100)}%.`);
    }
    if (h.form.length >= 3 && a.form.length >= 3) out.push(`Форма (від старіших до свіжіших): ${h.form} проти ${a.form}.`);
    if (m.league.cup) {
      const src = t => (t.domestic ? `чемпіонат (сила ${f2(t.domestic.q)})` : 'чемпіонат поза списком, взято нижчий базовий рівень');
      out.push(`Єврокубок: стартова оцінка ${ev.home.name} — ${src(H)}, ${ev.away.name} — ${src(A)}.`);
    }
    if (market) {
      out.push(`Модель: П1 ${pc(mc.p1)} · Х ${pc(mc.px)} · П2 ${pc(mc.p2)}. Букмекер${ev.odds.provider ? ` (${ev.odds.provider})` : ''}: ${pc(market.p1)} · ${pc(market.px)} · ${pc(market.p2)}. Підсумок: 30% модель + 70% ринок.`);
    } else {
      out.push('Коефіцієнтів букмекера немає — прогноз лише за статистикою.');
    }
    if (cc) {
      out.push(`Очікувано кутових ${f1(cc.corners.home + cc.corners.away)} (${f1(cc.corners.home)} : ${f1(cc.corners.away)}), жовтих карток ${f1(cc.cards.home + cc.cards.away)}, ймовірність червоної картки ${pc(1 - Math.exp(-cc.red))}.`);
    }
    if (m.previous && Math.min(h.p, a.p) < 10) out.push('На початку сезону рейтинги спираються і на минулий сезон (з меншою вагою).');
    if (minPlayed < 4) out.push('Зіграно мало матчів, тож прогноз менш надійний.');
    return out;
  }

  // Перевага і розмір ставки за чверть-Келлі (не більше 5% банку).
  function value(p, odds) {
    if (!(odds > 1)) return null;
    const edge = p * odds - 1;
    const kelly = edge > 0 ? Math.min(0.05, (edge / (odds - 1)) / 4) : 0;
    return { edge, kelly };
  }

  // Розрахунок ставки за фінальним рахунком: true / false / null (повернення).
  // Голи 1-го тайму — за рахунком перерви (ht), кутові й жовті матчу — за статистикою (box),
  // кутові 1-го тайму — за коментарем матчу (c1), червоні — за статистикою (red).
  // undefined — розрахувати неможливо (немає потрібних даних).
  function settle(key, h, a, extra) {
    const mk = MARKET_BY_KEY.get(key);
    if (mk) return mk.hit(h, a);
    const ht = extra && extra.ht, box = extra && extra.box;
    if (ht && /^HTO/.test(key)) {
      const g1 = ht.home + ht.away;
      if (key === 'HTO05') return g1 >= 1;
      if (key === 'HTO15') return g1 >= 2;
    }
    const m = /^(C1|Y1|C|Y|R)([OU])([\d.]+)$/.exec(key);
    if (!m) return undefined;
    const value = {
      C: box && box.homeCorners + box.awayCorners,
      Y: box && box.homeYellow + box.awayYellow,
      C1: extra && extra.c1, Y1: extra && extra.y1, R: extra && extra.red,
    }[m[1]];
    if (value == null) return undefined;
    return m[2] === 'O' ? value > +m[3] : value < +m[3];
  }

  return { build, predict, value, settle, isResult, GROUPS: G, TUNE };
})();
