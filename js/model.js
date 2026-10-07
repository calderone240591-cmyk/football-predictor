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
  const MIN_TIP_ODDS = 1.30;  // занадто «короткі» ставки не рекомендуємо як основні
  const MAX_TIP_ODDS = 2.20;
  const VALUE_EDGE = 0.03;    // мінімальна перевага над букмекером, щоб назвати ставку цінною

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const isResult = e => e.state === 'post' && e.completed && e.home.score != null && e.away.score != null;

  // ---------- рейтинги ----------
  // prior(teamId) → { att, def } — відправна точка; null — середній рівень (1, 1).
  // previous — результати минулого сезону: беруть участь із меншою вагою (через давність).
  // Нормалізація (середня команда = 1.00) рахується лише по командах поточного сезону.
  function fit(events, previous, prior, priorGames, normalize) {
    const now = Date.now() / 1000;
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
  function build(league, events, domestic, previous) {
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
    const f = fit(events, league.cup ? null : previous, prior, league.cup ? CUP_PRIOR_GAMES : PRIOR_GAMES, !league.cup);
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
  const G = { RES: 'Результат', TOT: 'Тотал голів', BTTS: 'Обидві заб\'ють', HCP: 'Фори', TT: 'Індивідуальні тотали', NUM: 'Кількість голів', COMBO: 'Комбіновані', HALF: 'Тайми', CORN: 'Кутові', CARD: 'Жовті картки' };

  const SCORE_MARKETS = [
    ['1', G.RES, 'П1', 'Перемога господарів', (h, a) => h > a],
    ['X', G.RES, 'Нічия', 'Нічия', (h, a) => h === a],
    ['2', G.RES, 'П2', 'Перемога гостей', (h, a) => h < a],
    ['1X', G.RES, '1X', 'Господарі не програють (1X)', (h, a) => h >= a],
    ['X2', G.RES, 'X2', 'Гості не програють (X2)', (h, a) => h <= a],
    ['12', G.RES, '12', 'Без нічиєї (12)', (h, a) => h !== a],
    ['DNB1', G.RES, 'П1 (н. повер.)', 'П1, нічия — повернення', (h, a) => (h === a ? null : h > a)],
    ['DNB2', G.RES, 'П2 (н. повер.)', 'П2, нічия — повернення', (h, a) => (h === a ? null : a > h)],

    ['O05', G.TOT, 'ТБ 0.5', 'Тотал більше 0.5', (h, a) => h + a >= 1],
    ['O15', G.TOT, 'ТБ 1.5', 'Тотал більше 1.5', (h, a) => h + a >= 2],
    ['U15', G.TOT, 'ТМ 1.5', 'Тотал менше 1.5', (h, a) => h + a <= 1],
    ['O25', G.TOT, 'ТБ 2.5', 'Тотал більше 2.5', (h, a) => h + a >= 3],
    ['U25', G.TOT, 'ТМ 2.5', 'Тотал менше 2.5', (h, a) => h + a <= 2],
    ['O35', G.TOT, 'ТБ 3.5', 'Тотал більше 3.5', (h, a) => h + a >= 4],
    ['U35', G.TOT, 'ТМ 3.5', 'Тотал менше 3.5', (h, a) => h + a <= 3],
    ['O45', G.TOT, 'ТБ 4.5', 'Тотал більше 4.5', (h, a) => h + a >= 5],
    ['U45', G.TOT, 'ТМ 4.5', 'Тотал менше 4.5', (h, a) => h + a <= 4],

    ['BTTS_Y', G.BTTS, 'ОЗ так', 'Обидві заб\'ють — так', (h, a) => h > 0 && a > 0],
    ['BTTS_N', G.BTTS, 'ОЗ ні', 'Обидві заб\'ють — ні', (h, a) => h === 0 || a === 0],
    ['CS_H', G.BTTS, 'Гості не заб\'ють', 'Господарі на нуль (гості не заб\'ють)', (h, a) => a === 0],
    ['CS_A', G.BTTS, 'Господарі не заб\'ють', 'Гості на нуль (господарі не заб\'ють)', (h, a) => h === 0],
    ['WTN_H', G.BTTS, 'П1 всуху', 'Перемога господарів всуху', (h, a) => h > a && a === 0],
    ['WTN_A', G.BTTS, 'П2 всуху', 'Перемога гостей всуху', (h, a) => a > h && h === 0],

    ['H-1.5', G.HCP, 'Ф1 (−1.5)', 'Фора господарів −1.5 (виграють з різницею 2+)', (h, a) => h - a >= 2],
    ['H+1.5', G.HCP, 'Ф1 (+1.5)', 'Фора господарів +1.5 (не програють з різницею 2+)', (h, a) => a - h <= 1],
    ['H-2.5', G.HCP, 'Ф1 (−2.5)', 'Фора господарів −2.5 (виграють з різницею 3+)', (h, a) => h - a >= 3],
    ['H+2.5', G.HCP, 'Ф1 (+2.5)', 'Фора господарів +2.5', (h, a) => a - h <= 2],
    ['A-1.5', G.HCP, 'Ф2 (−1.5)', 'Фора гостей −1.5 (виграють з різницею 2+)', (h, a) => a - h >= 2],
    ['A+1.5', G.HCP, 'Ф2 (+1.5)', 'Фора гостей +1.5 (не програють з різницею 2+)', (h, a) => h - a <= 1],
    ['A-2.5', G.HCP, 'Ф2 (−2.5)', 'Фора гостей −2.5 (виграють з різницею 3+)', (h, a) => a - h >= 3],
    ['A+2.5', G.HCP, 'Ф2 (+2.5)', 'Фора гостей +2.5', (h, a) => h - a <= 2],

    ['HO05', G.TT, 'ІТ1 Б 0.5', 'Господарі заб\'ють', (h) => h >= 1],
    ['HO15', G.TT, 'ІТ1 Б 1.5', 'Господарі заб\'ють 2+', (h) => h >= 2],
    ['HU15', G.TT, 'ІТ1 М 1.5', 'Господарі заб\'ють не більше 1', (h) => h <= 1],
    ['HO25', G.TT, 'ІТ1 Б 2.5', 'Господарі заб\'ють 3+', (h) => h >= 3],
    ['HU25', G.TT, 'ІТ1 М 2.5', 'Господарі заб\'ють не більше 2', (h) => h <= 2],
    ['AO05', G.TT, 'ІТ2 Б 0.5', 'Гості заб\'ють', (h, a) => a >= 1],
    ['AO15', G.TT, 'ІТ2 Б 1.5', 'Гості заб\'ють 2+', (h, a) => a >= 2],
    ['AU15', G.TT, 'ІТ2 М 1.5', 'Гості заб\'ють не більше 1', (h, a) => a <= 1],
    ['AO25', G.TT, 'ІТ2 Б 2.5', 'Гості заб\'ють 3+', (h, a) => a >= 3],
    ['AU25', G.TT, 'ІТ2 М 2.5', 'Гості заб\'ють не більше 2', (h, a) => a <= 2],

    ['N0', G.NUM, '0 голів', 'Рівно 0 голів', (h, a) => h + a === 0],
    ['N1', G.NUM, '1 гол', 'Рівно 1 гол', (h, a) => h + a === 1],
    ['N2', G.NUM, '2 голи', 'Рівно 2 голи', (h, a) => h + a === 2],
    ['N3', G.NUM, '3 голи', 'Рівно 3 голи', (h, a) => h + a === 3],
    ['N4', G.NUM, '4 голи', 'Рівно 4 голи', (h, a) => h + a === 4],
    ['N5', G.NUM, '5+ голів', '5 і більше голів', (h, a) => h + a >= 5],
    ['N23', G.NUM, '2–3 голи', '2 або 3 голи', (h, a) => h + a === 2 || h + a === 3],
    ['ODD', G.NUM, 'Непарний', 'Непарна кількість голів', (h, a) => (h + a) % 2 === 1],
    ['EVEN', G.NUM, 'Парний', 'Парна кількість голів', (h, a) => (h + a) % 2 === 0],

    ['1&O15', G.COMBO, 'П1 + ТБ 1.5', 'Перемога господарів і тотал більше 1.5', (h, a) => h > a && h + a >= 2],
    ['1&O25', G.COMBO, 'П1 + ТБ 2.5', 'Перемога господарів і тотал більше 2.5', (h, a) => h > a && h + a >= 3],
    ['2&O15', G.COMBO, 'П2 + ТБ 1.5', 'Перемога гостей і тотал більше 1.5', (h, a) => a > h && h + a >= 2],
    ['2&O25', G.COMBO, 'П2 + ТБ 2.5', 'Перемога гостей і тотал більше 2.5', (h, a) => a > h && h + a >= 3],
    ['1&BTTS', G.COMBO, 'П1 + ОЗ', 'Перемога господарів і обидві заб\'ють', (h, a) => h > a && a > 0],
    ['2&BTTS', G.COMBO, 'П2 + ОЗ', 'Перемога гостей і обидві заб\'ють', (h, a) => a > h && h > 0],
    ['1X&O15', G.COMBO, '1X + ТБ 1.5', 'Господарі не програють і тотал більше 1.5', (h, a) => h >= a && h + a >= 2],
    ['X2&O15', G.COMBO, 'X2 + ТБ 1.5', 'Гості не програють і тотал більше 1.5', (h, a) => a >= h && h + a >= 2],
    ['1X&U35', G.COMBO, '1X + ТМ 3.5', 'Господарі не програють і тотал менше 3.5', (h, a) => h >= a && h + a <= 3],
    ['X2&U35', G.COMBO, 'X2 + ТМ 3.5', 'Гості не програють і тотал менше 3.5', (h, a) => a >= h && h + a <= 3],
    ['BTTS&O25', G.COMBO, 'ОЗ + ТБ 2.5', 'Обидві заб\'ють і тотал більше 2.5', (h, a) => h > 0 && a > 0 && h + a >= 3],
  ].map(([key, group, short, long, hit]) => ({ key, group, short, long, hit }));

  const MARKET_BY_KEY = new Map(SCORE_MARKETS.map(m => [m.key, m]));

  // Ринки, з яких обирається основна рекомендація (найзрозуміліші й найпоширеніші).
  const TIP_GROUPS = new Set([G.RES, G.TOT, G.BTTS, G.HCP, G.TT]);
  const TIP_EXCLUDE = new Set(['12', 'DNB1', 'DNB2', 'O05', 'HO05', 'AO05']);

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

  // Тайми: голи в таймах — незалежні Пуассони з часткою 44% / 56%.
  function halfMarkets(lh, la) {
    const N = 7;
    const h1 = poissonPmf(lh * FIRST_HALF_SHARE, N), a1 = poissonPmf(la * FIRST_HALF_SHARE, N);
    const h2 = poissonPmf(lh * (1 - FIRST_HALF_SHARE), N), a2 = poissonPmf(la * (1 - FIRST_HALF_SHARE), N);
    const res = (x, y) => (x > y ? '1' : x === y ? 'X' : '2');
    const p = { HT1: 0, HTX: 0, HT2: 0, HTO05: 0, HTO15: 0, H2O05: 0, H2O15: 0, BOTHH: 0, MORE1: 0, MORE2: 0, MOREEQ: 0 };
    const htft = {};
    for (let x1 = 0; x1 <= N; x1++) for (let y1 = 0; y1 <= N; y1++) {
      const p1 = h1[x1] * a1[y1];
      if (p1 < 1e-9) continue;
      for (let x2 = 0; x2 <= N; x2++) for (let y2 = 0; y2 <= N; y2++) {
        const v = p1 * h2[x2] * a2[y2];
        if (v < 1e-10) continue;
        const g1 = x1 + y1, g2 = x2 + y2;
        p['HT' + res(x1, y1)] += v;
        if (g1 >= 1) p.HTO05 += v;
        if (g1 >= 2) p.HTO15 += v;
        if (g2 >= 1) p.H2O05 += v;
        if (g2 >= 2) p.H2O15 += v;
        if (g1 >= 1 && g2 >= 1) p.BOTHH += v;
        if (g1 > g2) p.MORE1 += v; else if (g2 > g1) p.MORE2 += v; else p.MOREEQ += v;
        const k = `${res(x1, y1)}/${res(x1 + x2, y1 + y2)}`;
        htft[k] = (htft[k] || 0) + v;
      }
    }
    const list = [
      ['HT1', 'П1 1-й тайм', 'Господарі виграють 1-й тайм'],
      ['HTX', 'Нічия 1-й тайм', 'Нічия в 1-му таймі'],
      ['HT2', 'П2 1-й тайм', 'Гості виграють 1-й тайм'],
      ['HTO05', 'ТБ 0.5 1-й т.', 'Гол у 1-му таймі'],
      ['HTO15', 'ТБ 1.5 1-й т.', '2+ голи в 1-му таймі'],
      ['H2O05', 'ТБ 0.5 2-й т.', 'Гол у 2-му таймі'],
      ['H2O15', 'ТБ 1.5 2-й т.', '2+ голи в 2-му таймі'],
      ['BOTHH', 'Гол в обох таймах', 'Голи в обох таймах'],
      ['MORE2', 'Результативніший 2-й т.', 'У 2-му таймі голів більше'],
      ['MORE1', 'Результативніший 1-й т.', 'У 1-му таймі голів більше'],
    ].map(([key, short, long]) => ({ key, group: G.HALF, short, long, p: p[key] }));
    list.push({ key: 'HTU15', group: G.HALF, short: 'ТМ 1.5 1-й т.', long: 'Не більше 1 гола в 1-му таймі', p: 1 - p.HTO15 });
    const htftList = Object.entries(htft).map(([k, v]) => ({
      key: 'HTFT' + k, group: G.HALF, short: `Т/М ${k.replace('X', 'Н')}`, long: `Тайм/матч ${k.replace(/X/g, 'Н')}`, p: v,
    }));
    return list.concat(htftList);
  }

  // Кутові й картки за сезонною статистикою команд (stats: { app, cornersFor, cornersAgainst, yellow }).
  function cornersCards(hs, as) {
    if (!hs || !as || !hs.app || !as.app) return null;
    const shrink = (v, n, prior, k = 3) => (v * n + prior * k) / (n + k);
    const hFor = shrink(hs.cornersFor / hs.app, hs.app, 5), hAg = shrink(hs.cornersAgainst / hs.app, hs.app, 5);
    const aFor = shrink(as.cornersFor / as.app, as.app, 5), aAg = shrink(as.cornersAgainst / as.app, as.app, 5);
    const ch = ((hFor + aAg) / 2) * 1.06;   // господарі зазвичай подають трохи більше кутових
    const ca = ((aFor + hAg) / 2) * 0.94;
    const cornersTotal = negBinPmf(ch + ca, 1.35, 30);
    const ph = poissonPmf(ch, 25), pa = poissonPmf(ca, 25);
    let hMore = 0, aMore = 0;
    for (let i = 0; i <= 25; i++) for (let j = 0; j <= 25; j++) {
      if (i > j) hMore += ph[i] * pa[j]; else if (j > i) aMore += ph[i] * pa[j];
    }
    const yh = shrink(hs.yellow / hs.app, hs.app, 2.0), ya = shrink(as.yellow / as.app, as.app, 2.0);
    const cardsTotal = negBinPmf(yh + ya, 1.3, 20);

    const out = [];
    for (const line of [7.5, 8.5, 9.5, 10.5, 11.5]) {
      const o = tailOver(cornersTotal, line);
      out.push({ key: `CO${line}`, group: G.CORN, short: `Кут. ТБ ${line}`, long: `Кутові: тотал більше ${line}`, p: o });
      out.push({ key: `CU${line}`, group: G.CORN, short: `Кут. ТМ ${line}`, long: `Кутові: тотал менше ${line}`, p: 1 - o });
    }
    out.push({ key: 'CH', group: G.CORN, short: 'Більше кут. — госп.', long: 'Господарі подадуть більше кутових', p: hMore });
    out.push({ key: 'CA', group: G.CORN, short: 'Більше кут. — гості', long: 'Гості подадуть більше кутових', p: aMore });
    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      const o = tailOver(cardsTotal, line);
      out.push({ key: `YO${line}`, group: G.CARD, short: `ЖК ТБ ${line}`, long: `Жовті картки: більше ${line}`, p: o });
      out.push({ key: `YU${line}`, group: G.CARD, short: `ЖК ТМ ${line}`, long: `Жовті картки: менше ${line}`, p: 1 - o });
    }
    return { markets: out, corners: { home: ch, away: ca }, cards: { home: yh, away: ya } };
  }

  // Які ринки мають коефіцієнт букмекера.
  function bookOdds(odds) {
    if (!odds) return {};
    const out = { '1': odds.home, 'X': odds.draw, '2': odds.away };
    if (odds.line) {
      const k = String(odds.line).replace('.', '');
      if (odds.over) out[`O${k}`] = odds.over;
      if (odds.under) out[`U${k}`] = odds.under;
    }
    return out;
  }

  function confidence(p, minPlayed) {
    let level = p >= 0.70 ? 3 : p >= 0.60 ? 2 : 1;
    if (minPlayed < 4) level = Math.max(1, level - 1);
    return { level, label: ['', 'Низька', 'Середня', 'Висока'][level] };
  }

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

    const mlh = clamp(m.avgH * hAtt * aDef * formFactor(H), 0.15, 4.5);
    const mla = clamp(m.avgA * aAtt * hDef * formFactor(A), 0.15, 4.5);
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
    const scores = [];
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) scores.push({ h, a, p: g[h][a] });
    scores.sort((x, y) => y.p - x.p);

    const book = bookOdds(ev.odds);
    const scoreMarkets = SCORE_MARKETS.map(mk => ({ ...mk, p: scoreMarketProb(g, mk) }));
    const cc = cornersCards(hs, as);
    const all = scoreMarkets.concat(halfMarkets(lh, la), cc ? cc.markets : [])
      .map(x => {
        const o = book[x.key] || null;
        return { ...x, odds: o, edge: o ? x.p * o - 1 : null };
      });
    const markets = all.slice().sort((x, y) => y.p - x.p);
    const prob = Object.fromEntries(all.map(x => [x.key, x.p]));

    // Мало даних — лише коли немає ні минулого сезону, ні (для єврокубків) рейтингу в чемпіонаті.
    const solid = m.previous || (m.league.cup && H.domestic && A.domestic);
    const minPlayed = solid ? 99 : Math.min(H.stats.p, A.stats.p);
    const inRange = x => x.p >= 1 / MAX_TIP_ODDS && 1 / x.p >= MIN_TIP_ODDS;
    const candidates = markets.filter(x => TIP_GROUPS.has(x.group) && !TIP_EXCLUDE.has(x.key) && inRange(x));
    const best = candidates[0] || markets.find(x => MARKET_BY_KEY.has(x.key) && x.group === G.RES);
    const tip = { ...best, conf: confidence(best.p, minPlayed) };
    const alternatives = candidates.filter(x => x.key !== best.key && x.p >= 0.55).slice(0, 3);
    const valueBets = markets
      .filter(x => x.edge != null && x.edge >= VALUE_EDGE && x.p >= 0.30)
      .sort((x, y) => y.edge - x.edge);

    // Найкращий варіант у кожній групі ринків (ймовірність 55–85%).
    const groups = Object.values(G).map(name => {
      const list = markets.filter(x => x.group === name);
      const pick = list.find(x => x.p >= 0.55 && x.p <= 0.85 && !TIP_EXCLUDE.has(x.key));
      return { name, list, pick };
    }).filter(x => x.list.length);

    return {
      lh, la, model: { lh: mlh, la: mla, ...modelCore }, market, useXg,
      prob, markets, groups, scores: scores.slice(0, 9), tip, alternatives,
      value: valueBets[0] || null,
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
      out.push(`Очікувано кутових ${f1(cc.corners.home + cc.corners.away)} (${f1(cc.corners.home)} : ${f1(cc.corners.away)}), жовтих карток ${f1(cc.cards.home + cc.cards.away)}.`);
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

  // Розрахунок ставки за фінальним рахунком: true / false / null (повернення або ринок не за рахунком).
  function settle(key, h, a) {
    const mk = MARKET_BY_KEY.get(key);
    return mk ? mk.hit(h, a) : undefined;
  }

  return { build, predict, value, settle, isResult, GROUPS: G };
})();
