// Аналітична модель.
//
// 1. Рейтинги команд будуються з результатів усіх матчів сезону: сила атаки й оборони
//    з урахуванням того, проти кого грали (ітеративне припасування), свіжі матчі важать
//    більше за старі, при малій кількості ігор рейтинг тягнеться до середнього.
// 2. У єврокубках відправна точка рейтингу — рейтинг команди у своєму чемпіонаті,
//    перерахований з урахуванням сили чемпіонату.
// 3. Очікувані голи → Пуассон з поправкою Діксона–Коулза → ймовірності всіх рахунків і ринків.
// 4. Якщо є коефіцієнти букмекера, ймовірності моделі поєднуються з ринковими (30/70):
//    ринок враховує склади, травми й новини, яких модель не бачить.
FP.model = (() => {
  const PRIOR_GAMES = 4;      // «віртуальні» матчі, що тягнуть рейтинг до середнього / до домашнього рейтингу
  const CUP_PRIOR_GAMES = 6;
  const HALF_LIFE_DAYS = 120; // вага матчу чотиримісячної давності — половина
  const RHO = -0.08;          // поправка Діксона–Коулза на рахунки 0:0, 1:0, 0:1, 1:1
  const MAX_GOALS = 10;
  const MARKET_WEIGHT = 0.7;  // ринок зазвичай точніший за чисту статистику
  const MIN_TIP_ODDS = 1.30;  // занадто «короткі» ставки не рекомендуємо як основні
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
      w: Math.pow(0.5, (now - e.ts) / 86400 / HALF_LIFE_DAYS),
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

  // Статистика команди для пояснень і таблиці.
  function teamStats(events) {
    const out = new Map();
    const get = id => {
      if (!out.has(id)) out.set(id, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, home: { p: 0, gf: 0, ga: 0 }, away: { p: 0, gf: 0, ga: 0 }, form: '' });
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

  // league — запис з FP.LEAGUES; domestic — Map teamId → { att, def, q } з рейтингів чемпіонатів.
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
      const s = stats.get(id) || { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, home: { p: 0, gf: 0, ga: 0 }, away: { p: 0, gf: 0, ga: 0 }, form: '' };
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

  // ---------- ймовірності ----------
  function poissonPmf(lambda) {
    const out = [Math.exp(-lambda)];
    for (let k = 1; k <= MAX_GOALS; k++) out.push(out[k - 1] * lambda / k);
    return out;
  }

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
  // тоді всі інші ринки (рахунки, «обидві заб'ють»…) залишаються узгодженими.
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

  const MARKETS = {
    '1':      { short: 'П1',     long: 'Перемога господарів',         hit: (h, a) => h > a },
    'X':      { short: 'Нічия',  long: 'Нічия',                        hit: (h, a) => h === a },
    '2':      { short: 'П2',     long: 'Перемога гостей',              hit: (h, a) => h < a },
    '1X':     { short: '1X',     long: 'Господарі не програють (1X)',  hit: (h, a) => h >= a },
    'X2':     { short: 'X2',     long: 'Гості не програють (X2)',      hit: (h, a) => h <= a },
    '12':     { short: '12',     long: 'Без нічиєї (12)',              hit: (h, a) => h !== a },
    'O15':    { short: 'ТБ 1.5', long: 'Тотал більше 1.5',             hit: (h, a) => h + a >= 2 },
    'U15':    { short: 'ТМ 1.5', long: 'Тотал менше 1.5',              hit: (h, a) => h + a <= 1 },
    'O25':    { short: 'ТБ 2.5', long: 'Тотал більше 2.5',             hit: (h, a) => h + a >= 3 },
    'U25':    { short: 'ТМ 2.5', long: 'Тотал менше 2.5',              hit: (h, a) => h + a <= 2 },
    'O35':    { short: 'ТБ 3.5', long: 'Тотал більше 3.5',             hit: (h, a) => h + a >= 4 },
    'U35':    { short: 'ТМ 3.5', long: 'Тотал менше 3.5',              hit: (h, a) => h + a <= 3 },
    'BTTS_Y': { short: 'ОЗ так', long: 'Обидві заб\'ють — так',        hit: (h, a) => h > 0 && a > 0 },
    'BTTS_N': { short: 'ОЗ ні',  long: 'Обидві заб\'ють — ні',         hit: (h, a) => h === 0 || a === 0 },
  };

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

  function predict(m, ev) {
    const H = m.teams.get(ev.home.id), A = m.teams.get(ev.away.id);
    if (!H || !A) return null;

    const mlh = clamp(m.avgH * H.att * A.def * formFactor(H), 0.15, 4.5);
    const mla = clamp(m.avgA * A.att * H.def * formFactor(A), 0.15, 4.5);
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
    const prob = {};
    for (const k in MARKETS) prob[k] = 0;
    const scores = [];
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const v = g[h][a];
        for (const k in MARKETS) if (MARKETS[k].hit(h, a)) prob[k] += v;
        scores.push({ h, a, p: v });
      }
    }
    scores.sort((x, y) => y.p - x.p);

    const book = bookOdds(ev.odds);
    const markets = Object.keys(MARKETS)
      .map(k => {
        const o = book[k] || null;
        return { key: k, ...MARKETS[k], p: prob[k], odds: o, edge: o ? prob[k] * o - 1 : null };
      })
      .sort((x, y) => y.p - x.p);

    // Мало даних — лише коли немає ні минулого сезону, ні (для єврокубків) рейтингу в чемпіонаті.
    const solid = m.previous || (m.league.cup && H.domestic && A.domestic);
    const minPlayed = solid ? 99 : Math.min(H.stats.p, A.stats.p);
    const candidates = markets.filter(x => 1 / x.p >= MIN_TIP_ODDS && x.key !== '12');
    const best = candidates[0] || markets[0];
    const tip = { ...best, conf: confidence(best.p, minPlayed) };
    const alternatives = candidates.slice(1).filter(x => x.p >= 0.55).slice(0, 3);
    const valueBets = markets
      .filter(x => x.edge != null && x.edge >= VALUE_EDGE && x.p >= 0.30)
      .sort((x, y) => y.edge - x.edge);

    return {
      lh, la, model: { lh: mlh, la: mla, ...modelCore }, market,
      prob, markets, scores: scores.slice(0, 6), tip, alternatives,
      value: valueBets[0] || null,
      lowData: minPlayed < 4, home: H, away: A,
      reasons: reasons(m, ev, H, A, mlh, mla, market, modelCore, minPlayed),
    };
  }

  const f2 = x => x.toFixed(2);
  const perGame = (g, p) => (p ? f2(g / p) : '—');
  const pc = x => Math.round(x * 100) + '%';

  function reasons(m, ev, H, A, mlh, mla, market, mc, minPlayed) {
    const h = H.stats, a = A.stats;
    const venue = (s, label) => (s.p ? `; ${label} ${perGame(s.gf, s.p)} забито і ${perGame(s.ga, s.p)} пропущено за гру` : '');
    const out = [
      `Статистична модель очікує ${mlh.toFixed(1)} : ${mla.toFixed(1)} голів.`,
      `${ev.home.name}: індекс атаки ${f2(H.att)}, оборони ${f2(H.def)}${venue(h.home, 'вдома')}.`,
      `${ev.away.name}: індекс атаки ${f2(A.att)}, оборони ${f2(A.def)}${venue(a.away, 'на виїзді')}.`,
    ];
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

  return { build, predict, value, isResult, MARKETS };
})();
