// «Сухі серії»: команди, що не забивають 2 матчі поспіль і більше. Два режими:
//   • «Чемпіонат» — серія лише за матчами чемпіонату, рекомендації на матчі чемпіонату;
//   • «Усі турніри» — повна серія: чемпіонат, єврокубки, національні кубки, континентальні турніри
//     (будь-який матч без гола подовжує серію), рекомендації на матч у будь-якому турнірі.
//
// Рекомендація — індивідуальний тотал такої команди в її наступному матчі (у будь-якому турнірі):
//   • ІТБ 1 (азійський): 2+ голи — виграш, рівно 1 — повернення ставки, 0 — програш;
//   • ІТБ 1.5: 2+ голи — виграш.
// Ймовірність — з моделі основного додатка (рейтинги атаки й оборони з результатів сезону,
// js/model.js) станом на день матчу, без коефіцієнтів букмекера: ESPN не зберігає їх після матчу.
// Тому рекомендація і статистика рахуються однаково на будь-якому пристрої.
(() => {
  const { api, model, LEAGUES } = FP;
  const MIN_STREAK = 2;
  const STAKE = 50;
  // Облік із нуля: статистика й зіграні рекомендації — лише для матчів, що почались після запуску.
  const LAUNCH = Date.parse('2026-10-20T20:30:00+03:00') / 1000;
  const REFRESH = 5 * 60 * 1000;
  const HORIZON = 10 * 86400;
  const VOID = /POSTPONED|CANCELED|ABANDONED/;

  // Турніри: 25 чемпіонатів основного додатка + єврокубки з config.js + кубки й континентальні турніри.
  // ID команд в ESPN спільні для всіх турнірів, тож матчі однієї команди з різних турнірів зводяться разом.
  const CHAMPS = LEAGUES.filter(l => !l.cup);
  const CUPS = [
    ...LEAGUES.filter(l => l.cup),
    ['uefa.super_cup', 'Суперкубок УЄФА', 'СК УЄФА', 'УЄФА'],
    ['eng.fa', 'Кубок Англії', 'Кубок Англії', 'Англія'],
    ['eng.league_cup', 'Кубок ліги', 'Кубок ліги', 'Англія'],
    ['eng.charity', 'Суперкубок Англії', 'СК Англії', 'Англія'],
    ['esp.copa_del_rey', 'Кубок Короля', 'Кубок Іспанії', 'Іспанія'],
    ['esp.super_cup', 'Суперкубок Іспанії', 'СК Іспанії', 'Іспанія'],
    ['ita.coppa_italia', 'Кубок Італії', 'Кубок Італії', 'Італія'],
    ['ita.super_cup', 'Суперкубок Італії', 'СК Італії', 'Італія'],
    ['ger.dfb_pokal', 'Кубок Німеччини', 'Кубок Німеччини', 'Німеччина'],
    ['ger.super_cup', 'Суперкубок Німеччини', 'СК Німеччини', 'Німеччина'],
    ['fra.coupe_de_france', 'Кубок Франції', 'Кубок Франції', 'Франція'],
    ['fra.super_cup', 'Суперкубок Франції', 'СК Франції', 'Франція'],
    ['ned.cup', 'Кубок Нідерландів', 'Кубок Нідерл.', 'Нідерланди'],
    ['por.taca.portugal', 'Кубок Португалії', 'Кубок Порт.', 'Португалія'],
    ['sco.tennents', 'Кубок Шотландії', 'Кубок Шотл.', 'Шотландія'],
    ['sco.cis', 'Кубок ліги Шотландії', 'Кубок ліги Шотл.', 'Шотландія'],
    ['bra.copa_do_brazil', 'Кубок Бразилії', 'Кубок Бразилії', 'Бразилія'],
    ['arg.copa', 'Кубок Аргентини', 'Кубок Арг.', 'Аргентина'],
    ['usa.open', 'Відкритий кубок США', 'Кубок США', 'США'],
    ['conmebol.libertadores', 'Кубок Лібертадорес', 'Лібертадорес', 'КОНМЕБОЛ'],
    ['conmebol.sudamericana', 'Південноамериканський кубок', 'Судамерикана', 'КОНМЕБОЛ'],
    ['concacaf.champions', 'Кубок чемпіонів КОНКАКАФ', 'ЛЧ КОНКАКАФ', 'КОНКАКАФ'],
    ['concacaf.leagues.cup', 'Кубок ліг', 'Кубок ліг', 'КОНКАКАФ'],
    ['afc.champions', 'Ліга чемпіонів АФК', 'ЛЧ АФК', 'АФК'],
  ].map(c => (Array.isArray(c) ? { slug: c[0], name: c[1], short: c[2], country: c[3], logo: null, cup: true } : c));
  const COMPS = [...CHAMPS, ...CUPS];
  const COMP = new Map(COMPS.map(c => [c.slug, c]));

  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const state = { data: null, loadedAt: 0, loading: null, period: 'all' };
  let renderId = 0;

  // ---------- утиліти ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = p => Math.round(p * 100) + '%';
  const pad = FP.pad;
  const timeOf = ts => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dateOf = ts => { const d = new Date(ts * 1000); return `${d.getDate()}.${pad(d.getMonth() + 1)}`; };
  const WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const dayLabel = o => {
    if (o === 0) return 'Сьогодні';
    if (o === 1) return 'Завтра';
    const d = new Date(); d.setDate(d.getDate() + o);
    return `${WD[d.getDay()]}, ${d.getDate()}.${pad(d.getMonth() + 1)}`;
  };
  const dayStart = ts => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const uah = v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('uk-UA')} грн`;
  const leagueOf = slug => COMP.get(slug);
  const leagueLabel = slug => { const l = leagueOf(slug); return l ? `${l.country} · ${l.name}` : ''; };
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const matches = n => `${n} ${plural(n, 'матч', 'матчі', 'матчів')}`;

  // ---------- аналіз ----------
  // Голи команди — Пуассон з очікуваними голами λ з моделі.
  function bets(lambda) {
    const p0 = Math.exp(-lambda), p1 = lambda * p0, p2 = 1 - p0 - p1;
    return {
      lambda, scoreP: 1 - p0,
      it1: { p: p2 / (1 - p1), win: p2, push: p1 },   // ймовірність без урахування повернень
      it15: { p: p2 },
    };
  }

  const settle = (key, g) => (g == null ? 'pending' : g >= 2 ? 'win' : key === 'it1' && g === 1 ? 'void' : 'loss');
  const profitOf = (s, p) => (s === 'win' ? (1 / p - 1) * STAKE : s === 'loss' ? -STAKE : 0);

  // Моделі «станом на початок дня t» (лише результати до цього дня). Для минулих днів вони вже
  // не змінюються, тож зберігаються між оновленнями; поточний день перераховується щоразу.
  const modelCache = new Map();
  const masked = (events, t) => events.map(e => (e.ts < t || !model.isResult(e) ? e : { ...e, state: 'pre', completed: false }));

  function analyze(seasons, mode) {
    const now = Date.now() / 1000;
    const today = dayStart(now);

    // Усі матчі кожної команди з усіх турнірів (і кінець минулого сезону чемпіонату) — для серій.
    const seen = new Set();
    const games = new Map();   // id команди → [{ ts, g }] у хронологічному порядку
    const all = [];
    for (const s of seasons.filter(x => mode === 'all' || !x.comp.cup)) {
      for (const [list, current] of [[s.previous, false], [s.events, true]]) for (const e of list) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (current) all.push({ slug: s.comp.slug, ev: e });
        if (!model.isResult(e)) continue;
        for (const [id, g] of [[e.home.id, e.home.score], [e.away.id, e.away.score]]) {
          if (!games.has(id)) games.set(id, []);
          games.get(id).push({ ts: e.ts, g });
        }
      }
    }
    for (const list of games.values()) list.sort((a, b) => a.ts - b.ts);
    const streak = (id, ts) => {
      const list = games.get(id) || [];
      let i = list.length - 1;
      while (i >= 0 && list[i].ts >= ts) i--;
      let n = 0;
      while (i >= 0 && list[i].g === 0) { n++; i--; }
      return { n, lastGoal: i >= 0 ? list[i].ts : null };
    };

    // Рекомендуємо лише командам наших 25 чемпіонатів: про інших (нижчі ліги в кубках, клуби з
    // чемпіонатів поза списком) у даних не всі матчі, і серія була б неточною.
    const bySlug = new Map(seasons.map(s => [s.comp.slug, s]));
    const homeLeague = new Map();
    for (const c of CHAMPS) for (const e of (bySlug.get(c.slug) || { events: [] }).events) { homeLeague.set(e.home.id, c.slug); homeLeague.set(e.away.id, c.slug); }

    const leagueModelAt = (slug, t) => {
      const k = `${slug}:${t}`;
      if (modelCache.has(k)) return modelCache.get(k);
      const s = bySlug.get(slug);
      let m = null;
      try {
        const evs = masked(s.events, t), prev = s.previous.filter(e => e.ts < t);
        if (evs.some(model.isResult) || prev.length) m = model.build(COMP.get(slug), evs, null, prev, t);
      } catch {}
      modelCache.set(k, m);
      return m;
    };
    // Для кубків — рейтинги команд у їхніх чемпіонатах з поправкою на силу чемпіонату (як у js/app.js).
    const cupModelAt = (slug, t) => {
      const k = `${slug}:${t}`;
      if (modelCache.has(k)) return modelCache.get(k);
      const domestic = new Map();
      for (const c of CHAMPS) {
        if (!bySlug.has(c.slug)) continue;
        const m = leagueModelAt(c.slug, t);
        if (m) for (const tm of m.teams.values()) domestic.set(tm.id, { att: tm.att, def: tm.def, q: c.q, slug: c.slug });
      }
      let m = null;
      try { m = model.build(COMP.get(slug), masked(bySlug.get(slug).events, t), domestic, null, t); } catch {}
      modelCache.set(k, m);
      return m;
    };

    const recs = [];
    for (const { slug, ev } of all) {
      if (VOID.test(ev.status)) continue;
      // Лише те, що потрібно: зіграні після запуску (статистика) і найближчі 10 днів (рекомендації).
      if (ev.ts < LAUNCH || ev.ts > now + HORIZON) continue;
      for (const side of ['home', 'away']) {
        const team = ev[side];
        if (!homeLeague.has(team.id)) continue;
        const st = streak(team.id, ev.ts);
        if (st.n < MIN_STREAK) continue;
        const t = Math.min(dayStart(ev.ts), today);
        const m = COMP.get(slug).cup ? cupModelAt(slug, t) : leagueModelAt(slug, t);
        const pred = m && model.predict(m, { ...ev, odds: null }, null);
        if (!pred) continue;
        const b = bets(side === 'home' ? pred.lh : pred.la);
        const done = model.isResult(ev);
        const g = done ? team.score : null;
        recs.push({
          id: `${ev.id}:${side}`, slug, ev, side, team, opp: ev[side === 'home' ? 'away' : 'home'],
          n: st.n, lastGoal: st.lastGoal, ...b, g, done,
          st1: settle('it1', g), st15: settle('it15', g),
        });
      }
    }

    // Поточні серії команд наших чемпіонатів і їхній наступний матч у будь-якому турнірі.
    const teams = new Map();
    for (const { ev } of all) for (const t of [ev.home, ev.away]) if (homeLeague.has(t.id)) teams.set(t.id, t);
    const upcomingAll = all.filter(x => !model.isResult(x.ev) && !VOID.test(x.ev.status) && x.ev.ts > now - 3 * 3600).sort((a, b) => a.ev.ts - b.ev.ts);
    const current = [];
    for (const [id, team] of teams) {
      const st = streak(id, Infinity);
      if (st.n < MIN_STREAK) continue;
      const nx = upcomingAll.find(x => x.ev.home.id === id || x.ev.away.id === id);
      current.push({ slug: homeLeague.get(id), team, n: st.n, lastGoal: st.lastGoal, next: nx && nx.ev, nextSlug: nx && nx.slug });
    }
    return { mode, recs, current, events: all };
  }

  function load(force) {
    if (state.loading) return state.loading;
    if (!force && state.data && Date.now() - state.loadedAt < REFRESH) return Promise.resolve(state.data);
    let done = 0;
    state.loading = (async () => {
      await FP.store.ready;
      const vbet = FP.vbet.load(force);   // кф VBET на індивідуальні тотали; без них — справедливий кф моделі
      let errors = 0;
      const seasons = (await api.pool(COMPS, 4, async c => {
        let s = null;
        try { s = { comp: c, ...(await api.season(c.slug, false, !c.cup)) }; } catch { if (!c.cup) errors++; }
        done++;
        const $p = document.getElementById('progress');
        if ($p) $p.textContent = `Завантаження турнірів: ${done} з ${COMPS.length}…`;
        return s;
      })).filter(Boolean);
      await vbet;
      const today = dayStart(Date.now() / 1000);
      for (const k of [...modelCache.keys()]) if (k.endsWith(`:${today}`)) modelCache.delete(k);
      const out = { league: { ...analyze(seasons, 'league'), errors }, all: { ...analyze(seasons, 'all'), errors } };
      state.data = out;
      state.loadedAt = Date.now();
      return out;
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // ---------- оболонка ----------
  function setHeader(title, tab) {
    $title.textContent = title;
    document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  }

  async function withData(title, tab, render, mode = 'league') {
    const rid = ++renderId;
    setHeader(title, tab);
    if (!state.data) $view.innerHTML = '<div class="loading" id="progress">Завантаження турнірів…</div>';
    else render(state.data[mode]);
    const d = await load(false);
    if (rid !== renderId) return;
    render(d[mode]);
  }

  const ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '↺', pending: '' };

  // ---------- Рекомендації ----------
  // Кф ставки: VBET (якщо матч є в його лінії) з позначкою, інакше — справедливий кф моделі (1 ÷ ймовірність).
  const vbetOf = r => (r.done ? null : FP.vbet.teamTotals(r.slug, r.ev, r.side));
  const oddsHtml = (r, key) => {
    const v = vbetOf(r), k = v && v[key];
    return k ? `кф <b class="dr-k">${k.toFixed(2)}</b> <span class="bk vbet">VBET</span>`
      : `кф ${(1 / r[key].p).toFixed(2)} <span class="bk dk">модель</span>`;
  };

  // ---------- Серії програшів ----------
  // Серія — програші ставки поспіль, окремо для ІТБ 1 і ІТБ 1.5. Виграш серію закриває; наступні матчі йдуть
  // у нову серію. Повернення ІТБ 1 (рівно 1 гол) серію не закриває і не подовжує.
  // Матчі розкладаються за часом: матч дістається серії, чий попередній матч уже закінчився і є ≥ 20 хв поставити
  // (наступний — щонайменше через 2 год 15 хв після початку попереднього; матч ≈ 1 год 55 хв). З кількох вільних
  // серій — тій, де програшів найбільше; якщо вільної немає — починається нова. Серії будуються від початку обліку,
  // тож однакові на всіх пристроях. Особлива ставка — після 2, 3 чи 4+ програшів (пріоритет 3, 2, 1).
  const SER_END = 115 * 60;
  const SER_GAP = 135 * 60;
  const SPECIAL_RUN = 2;
  const SPECIAL_BETS = [['it1', 'st1', 'ІТБ 1'], ['it15', 'st15', 'ІТБ 1.5']];
  const SP_LEVELS = {
    2: { stars: '★', name: 'Пріоритет 3', runs: '2 програшів' },
    3: { stars: '★★', name: 'Пріоритет 2', runs: '3 програшів' },
    4: { stars: '★★★', name: 'Пріоритет 1', runs: '4+ програшів' },
  };
  const spLevel = run => (run >= 4 ? 4 : run >= SPECIAL_RUN ? run : 0);
  // Команда в матчі, що йде, вже забила 2 — ставка зайшла достроково.
  const earlyWin = r => !r.done && r.ev.state === 'in' && (r.ev[r.side].score ?? 0) >= 2;

  // Серії однієї ставки: [{ no, items: [{ r, st, n, cond }], closed, run, next }]. st — результат (null — ще не
  // зіграно), n — номер ставки в серії; cond — матч стоїть після ще не зіграного: буде в серії, лише якщо той програє.
  function seriesOf(d, key, stKey) {
    const pool = [...d.recs.filter(r => r.done && r.ev.ts >= LAUNCH), ...upcomingRecs(d).filter(r => !VOID.test(r.ev.status || ''))]
      .sort((a, b) => a.ev.ts - b.ev.ts || b[key].p - a[key].p);
    const all = [], open = [];
    const hist = { 2: { wins: 0, n: 0 }, 3: { wins: 0, n: 0 }, 4: { wins: 0, n: 0 } };
    for (const r of pool) {
      const free = open.filter(s => s.free <= r.ev.ts).sort((a, b) => b.run - a.run || a.free - b.free);
      let s = free[0];
      if (!s) { s = { no: all.length + 1, items: [], run: 0, free: 0, closed: null, pending: false }; all.push(s); open.push(s); }
      const st = r.done ? r[stKey] : earlyWin(r) ? 'win' : null;
      s.items.push({ r, st, n: s.run + 1, run: s.run, cond: s.pending });
      s.free = r.ev.ts + SER_GAP;
      if (!s.pending && spLevel(s.run) && (st === 'win' || st === 'loss')) { hist[spLevel(s.run)].n++; if (st === 'win') hist[spLevel(s.run)].wins++; }
      if (st === 'win' && !s.pending) { s.closed = r.ev.ts; open.splice(open.indexOf(s), 1); }
      else if (st === 'loss' || st == null) { s.run++; if (st == null) s.pending = true; }
    }
    for (const s of all) {
      s.next = s.items.find(x => x.st == null && !x.cond) || null;
      s.lost = s.items.filter(x => !x.cond && x.st !== null && x.st !== 'win');   // програші й повернення до наступної ставки
      s.lvl = s.next ? spLevel(s.next.run) : 0;
    }
    return { all, hist };
  }

  // Найближчий матч кожної «сухої» команди: після нього серія або перерветься, або подовжиться.
  function upcomingRecs(d) {
    const now = Date.now() / 1000;
    const next = new Map();
    for (const r of d.recs) {
      if (r.done || r.ev.ts > now + HORIZON) continue;
      const have = next.get(r.team.id);
      if (!have || r.ev.ts < have.ev.ts) next.set(r.team.id, r);
    }
    return [...next.values()].sort((a, b) => a.ev.ts - b.ev.ts || b.n - a.n);
  }

  state.betKey = 'it15';
  function renderRecs(d) {
    const now = Date.now() / 1000;
    const upcoming = upcomingRecs(d);
    const analyzed = d.events.filter(x => !model.isResult(x.ev) && !VOID.test(x.ev.status) && x.ev.ts < now + HORIZON).length;
    const [key, stKey, label] = SPECIAL_BETS.find(b => b[0] === state.betKey);
    const { all, hist } = seriesOf(d, key, stKey);
    const when = ts => {
      const o = Math.round((dayStart(ts) - dayStart(now)) / 86400);
      return `${o === 0 ? 'сьогодні' : o === 1 ? 'завтра' : o === -1 ? 'учора' : dateOf(ts)} ${timeOf(ts)}`;
    };
    const team = r => esc(r.team.short || r.team.name);
    const vs = r => `${team(r)} ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.short || r.opp.name)}`;
    const badge = lvl => `<span class="sp-badge sp${lvl}">${SP_LEVELS[lvl].stars} ${SP_LEVELS[lvl].name}</span>`;
    const ICONS = { win: '✓', loss: '✗', void: '↺' };

    // Відкриті серії з наступною ставкою: більше програшів — вище, далі — за часом матчу.
    const active = all.filter(s => !s.closed && s.next).sort((a, b) => b.next.run - a.next.run || a.next.r.ev.ts - b.next.r.ev.ts);
    const card = s => {
      const x = s.next, r = x.r, ev = r.ev;
      const later = s.items.filter(y => y.cond);
      const losses = s.lost.filter(y => y.st === 'loss').length;
      return `
        <section class="card sc ${s.lvl ? `special sp${s.lvl}` : ''}">
          <div class="sc-head"><b>${s.lost.length ? `Серія з ${when(s.items[0].r.ev.ts)}` : 'Нова серія'}</b>${s.lvl ? badge(s.lvl) : ''}<small>${losses ? `${losses} ${plural(losses, 'програш', 'програші', 'програшів')} поспіль` : 'програшів ще немає'}</small></div>
          ${s.lost.length ? `<div class="sc-hist">${s.lost.map(y => `<span class="${y.st}"><i>${ICONS[y.st]}</i>${team(y.r)} <small>${dateOf(y.r.ev.ts)}</small></span>`).join('')}</div>` : ''}
          <div class="sc-next">
            <div class="sc-no">Ставка №${x.n}</div>
            <div class="sc-match"><b class="${ev.state === 'in' ? 'live' : ''}">${ev.state === 'in' ? `LIVE ${ev.home.score ?? 0}:${ev.away.score ?? 0}` : when(ev.ts)}</b>
              <span>${vs(r)}</span><small>${esc((leagueOf(r.slug) || {}).short || '')} · без голів ${r.n}</small></div>
            <div class="sc-k">${oddsHtml(r, key)}</div>
          </div>
          ${later.length ? `<p class="sc-later">Якщо програє, далі в цій серії: ${later.slice(0, 3).map(y => `${when(y.r.ev.ts)} ${team(y.r)}`).join(' · ')}${later.length > 3 ? ` · ще ${later.length - 3}` : ''}</p>` : ''}
        </section>`;
    };

    // Закриті виграшем за останні 2 дні.
    const closed = all.filter(s => s.closed && s.closed > now - 2 * 86400).sort((a, b) => b.closed - a.closed);
    const closedRow = s => `<div class="sc-closed"><b>з ${dateOf(s.items[0].r.ev.ts)}</b>
      <span class="sc-icons">${s.items.filter(y => !y.cond).map(y => `<i class="${y.st}">${ICONS[y.st] || '·'}</i>`).join('')}</span>
      <small>виграш на ставці №${s.items[s.items.length - 1].n} · ${team(s.items[s.items.length - 1].r)} ${when(s.closed)}</small></div>`;

    // Усі незіграні рекомендації по часу: на кожну ставиш; номер ставки залежить від результату попередньої в серії.
    const dayTitle = ts => {
      const o = Math.round((dayStart(ts) - dayStart(now)) / 86400);
      return o >= 0 && o <= 2 ? dayLabel(o) : `${WD[new Date(ts * 1000).getDay()]}, ${dateOf(ts)}`;
    };
    const pending = all.flatMap(s => s.items.map((y, i) => ({ s, y, prev: s.items[i - 1] })).filter(z => z.y.st == null))
      .sort((a, b) => a.y.r.ev.ts - b.y.r.ev.ts);
    let day = null;
    const listHtml = pending.map(({ s, y, prev }) => {
      const r = y.r, ev = r.ev, ds = dayStart(ev.ts);
      const head = ds !== day ? `<div class="q-day">${esc(dayTitle(ev.ts))}</div>` : '';
      day = ds;
      const lvl = y.cond ? 0 : spLevel(y.run);
      const note = !y.cond ? (y.run ? `ставка №${y.n} серії з ${dateOf(s.items[0].r.ev.ts)}` : 'ставка №1 — нова серія')
        : `№${y.n}, якщо ✗ ${team(prev.r)}; якщо ✓ — нова серія`;
      return `${head}<div class="q-row ${!y.cond ? 'next' : ''} ${lvl ? `sp${lvl}` : ''}">
        <b>${ev.state === 'in' ? '<span class="live">LIVE</span>' : timeOf(ev.ts)}</b>
        <span>${vs(r)}<small>${note}${lvl ? ' ' + SP_LEVELS[lvl].stars : ''}</small></span>
        <span class="q-odds">${oddsHtml(r, key)}</span></div>`;
    }).join('');

    const histTxt = [2, 3, 4].map(l => `після ${SP_LEVELS[l].runs} — ${hist[l].n ? `${hist[l].wins} з ${hist[l].n}` : 'не було'}`).join(', ');
    $view.innerHTML = `
      <p class="summary">Проаналізовано ${matches(analyzed)} у ${d.mode === 'all' ? `${COMPS.length} турнірах` : `${CHAMPS.length} чемпіонатах`} на 10 днів · рекомендацій: <b>${upcoming.length}</b>${d.errors ? ` · не завантажено ліг: ${d.errors}` : ''}</p>
      <div class="controls"><div class="segmented">${SPECIAL_BETS.slice().reverse().map(([k, , l]) => `<button class="${k === key ? 'on' : ''}" data-bet="${k}">${l}</button>`).join('')}</div></div>
      <p class="hint pad ser-intro">Серія — програші ${label} поспіль. Виграш закриває серію, наступний матч починає нову. У серії матчі йдуть по одному: наступний — після кінця попереднього, тож ставиш, знаючи результат.${key === 'it1' ? ' Повернення (рівно 1 гол) серію не закриває.' : ''}</p>
      ${active.length ? active.map(card).join('') : `<div class="empty">Найближчими днями немає матчів команд, що не забивають ${MIN_STREAK} тури і більше.</div>`}
      ${pending.length ? `<section class="card"><h3>Усі ставки по часу · ${pending.length}</h3>
        <div class="q-list">${listHtml}</div>
        <p class="hint">Ставити на кожну. Підсвічені — наступні ставки серій (вище картками); для інших номер залежить від результату попередньої ставки серії: програє — серія триває, виграє — матч почне нову серію.</p>
      </section>` : ''}
      ${closed.length ? `<section class="card"><h3>Закриті виграшем за 2 дні · ${closed.length}</h3>${closed.map(closedRow).join('')}</section>` : ''}
      <details class="dr-more"><summary>Пріоритети, кф та історія</summary>
        <div class="card">
          <p class="hint top">Особлива ставка — після програшів поспіль: ${[4, 3, 2].map(l => `${badge(l)} після ${SP_LEVELS[l].runs}`).join(' · ')}. Такі серії стоять угорі.</p>
          <p class="hint">Раніше ${label} у серіях вигравала: ${histTxt}.</p>
          <p class="hint">Кф: <span class="bk vbet">VBET</span> — з лінії vbet.ua (оновлюється кожні 5 хв); <span class="bk dk">модель</span> — матчу немає в лінії VBET, показано справедливий кф моделі (у букмекера на 5–8% нижчий).</p>
        </div>
      </details>
      <p class="hint pad">Рекомендація — лише для команди, яка не забивала ${d.mode === 'all' ? 'в усіх турнірах разом' : 'в чемпіонаті'} ${MIN_STREAK} матчі поспіль і більше. Ставки — на її індивідуальний тотал: ІТБ 1 (2+ голи — виграш, рівно 1 — повернення) та ІТБ 1.5 (2+ голи). Ймовірність — з моделі за результатами сезону.</p>`;
  }

  // ---------- Серії ----------
  function renderTeams(d) {
    const rows = d.current.slice().sort((a, b) => b.n - a.n || (a.next ? a.next.ts : 9e9) - (b.next ? b.next.ts : 9e9));
    $view.innerHTML = `
      <p class="summary">Команд, що не забивають ${MIN_STREAK}+ матчі поспіль: <b>${rows.length}</b></p>
      ${rows.length ? `<section class="card"><table class="markets dr-table">
        <thead><tr><th>Команда</th><th>Без голів</th><th>Наступний матч</th></tr></thead>
        <tbody>${rows.map(r => {
          const nx = r.next;
          const opp = nx ? (nx.home.id === r.team.id ? nx.away : nx.home) : null;
          return `<tr>
            <td><b>${esc(r.team.name)}</b><small>${esc(leagueLabel(r.slug))}</small></td>
            <td><b class="dr-n">${r.n}</b><small>${r.lastGoal ? `гол ${dateOf(r.lastGoal)}` : 'без голів'}</small></td>
            <td>${nx ? `${esc(nx.home.id === r.team.id ? 'vs' : '@')} ${esc(opp.short || opp.name)}<small>${dateOf(nx.ts)} ${timeOf(nx.ts)}${r.nextSlug && r.nextSlug !== r.slug ? ` · ${esc(leagueOf(r.nextSlug).short)}` : ''}</small>` : '<small>немає в розкладі</small>'}</td>
          </tr>`;
        }).join('')}</tbody></table></section>` : `<div class="empty">Зараз немає команд із серією без голів від ${MIN_STREAK} матчів.</div>`}
      <p class="hint pad">«vs» — удома, «@» — у гостях. ${d.mode === 'all' ? 'Повна серія — за всіма матчами команди: чемпіонат, єврокубки, національні й континентальні кубки.' : 'Серія рахується лише за матчами чемпіонату (з урахуванням кінця минулого сезону).'}</p>`;
  }

  // ---------- Статистика ----------
  const PERIODS = [['all', 'Увесь час'], ['7', '7 днів'], ['30', '30 днів']];
  function inPeriod(ts) {
    if (ts < LAUNCH) return false;
    return state.period === 'all' || ts * 1000 >= Date.now() - Number(state.period) * 864e5;
  }

  // ---------- Серії виграшів і програшів ----------
  // Ставки в порядку початку матчів. Повернення (ІТБ 1, рівно 1 гол) серію не перериває і не подовжує.
  function runsOf(list) {
    const runs = [];
    for (const b of list) {
      if (b.s !== 'win' && b.s !== 'loss') continue;
      const last = runs[runs.length - 1];
      if (last && last.s === b.s) { last.bets.push(b); last.profit += b.profit; }
      else runs.push({ s: b.s, bets: [b], profit: b.profit });
    }
    return runs;
  }
  const runSpan = r => {
    const a = r.bets[0].r.ev.ts, z = r.bets[r.bets.length - 1].r.ev.ts;
    return dayStart(a) === dayStart(z) ? dateOf(a) : `${dateOf(a)}–${dateOf(z)}`;
  };
  const RES = { win: 'виграш', loss: 'програш', void: 'повернення' };
  const betTitle = b => `${dateOf(b.r.ev.ts)} ${timeOf(b.r.ev.ts)} · ${b.r.team.short || b.r.team.name} ${b.r.side === 'home' ? 'vs' : '@'} ${b.r.opp.short || b.r.opp.name} · забила ${b.r.g} · ${RES[b.s]}`;

  // Динаміка: після кожної ставки — довжина поточної серії (вгору — виграші поспіль, вниз — програші).
  function streakChart(list) {
    if (list.length < 2) return '';
    let cur = 0;
    const pts = list.map(b => {
      if (b.s === 'win') cur = cur > 0 ? cur + 1 : 1;
      else if (b.s === 'loss') cur = cur < 0 ? cur - 1 : -1;
      return { b, v: b.s === 'void' ? 0 : cur };
    });
    const up = Math.max(1, ...pts.map(p => p.v)), down = Math.max(1, ...pts.map(p => -p.v));
    const W = 300, H = 110, base = H * up / (up + down), unit = H / (up + down);
    const bw = W / pts.length, gap = bw > 4 ? bw * 0.2 : 0;
    const bars = pts.map((p, i) => {
      const h = p.v ? Math.abs(p.v) * unit : 2;
      const y = p.v > 0 ? base - h : p.v < 0 ? base : base - 1;
      return `<rect x="${(i * bw + gap / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw - gap).toFixed(2)}" height="${h.toFixed(2)}" class="${p.b.s}" data-tip="${esc(betTitle(p.b))}${p.v ? ` · серія ${Math.abs(p.v)}` : ''}"><title>${esc(betTitle(p.b))}${p.v ? ` · серія ${Math.abs(p.v)}` : ''}</title></rect>`;
    }).join('');
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="dr-bars" aria-label="Динаміка серій">
          ${bars}<line x1="0" x2="${W}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" class="chart-base"/>
        </svg>
        <div class="chart-axis"><span>✓ ${up}</span><span>✗ ${down}</span></div>
      </div>
      <div class="dr-xaxis"><span>${dateOf(list[0].r.ev.ts)}</span><span>${dateOf(list[list.length - 1].r.ev.ts)}</span></div>`;
  }

  // Стрічка всіх ставок по днях: ✓ виграш, ✗ програш, ↺ повернення.
  function streakStrip(list) {
    const days = new Map();
    for (const b of list) { const k = dateOf(b.r.ev.ts); if (!days.has(k)) days.set(k, []); days.get(k).push(b); }
    return `<div class="dr-strip">${[...days].map(([d, l]) => `<div><small>${d}</small><span>${l.map(b =>
      `<i class="${b.s}" title="${esc(betTitle(b))}" data-tip="${esc(betTitle(b))}">${{ win: '✓', loss: '✗', void: '↺' }[b.s]}</i>`).join('')}</span></div>`).join('')}</div>`;
  }

  function streaksCard(label, list) {
    const runs = runsOf(list);
    if (!runs.length) return '';
    const wins = runs.filter(r => r.s === 'win'), losses = runs.filter(r => r.s === 'loss');
    const longest = rs => rs.reduce((m, r) => (!m || r.bets.length >= m.bets.length ? r : m), null);
    const avg = rs => (rs.length ? (rs.reduce((s, r) => s + r.bets.length, 0) / rs.length).toFixed(1) : '—');
    const bw = longest(wins), bl = longest(losses), cur = runs[runs.length - 1];
    const tile = (r, cls, empty) => (r ? `<b class="${cls}">${r.bets.length}</b><span>${runSpan(r)}<br>${uah(r.profit)}</span>` : `<b>—</b><span>${empty}</span>`);
    const maxLen = Math.max(...runs.map(r => r.bets.length));
    const dist = [];
    for (let k = 1; k <= maxLen; k++) {
      const w = wins.filter(r => r.bets.length === k).length, l = losses.filter(r => r.bets.length === k).length;
      if (w || l) dist.push(`<tr><td>${k} поспіль</td><td class="${w ? 'ok' : ''}">${w || '—'}</td><td class="${l ? 'bad' : ''}">${l || '—'}</td></tr>`);
    }
    const teams = r => r.bets.map(b => esc(b.r.team.short || b.r.team.name)).join(', ');
    return `
      <section class="card"><h3>Серії поспіль · ${label}</h3>
        <div class="kpis">
          <div>${tile(bw, 'ok', 'виграшів ще немає')}<span>найдовша серія<br>виграшів</span></div>
          <div>${tile(bl, 'bad', 'програшів ще немає')}<span>найдовша серія<br>програшів</span></div>
          <div><b class="${cur.s === 'win' ? 'ok' : 'bad'}">${cur.s === 'win' ? '✓' : '✗'} ${cur.bets.length}</b><span>зараз<br>${cur.s === 'win' ? 'виграші' : 'програші'} поспіль з ${dateOf(cur.bets[0].r.ev.ts)}</span></div>
        </div>
        <div class="kpis kpis2">
          <div><b>${wins.length}</b><span>серій виграшів<br>середня ${avg(wins)}</span></div>
          <div><b>${losses.length}</b><span>серій програшів<br>середня ${avg(losses)}</span></div>
          <div><b>${runs.length}</b><span>змін серій<br>ставок ${list.length}</span></div>
        </div>
        ${streakChart(list)}
        ${streakStrip(list)}
        <p class="dr-tipline">Натисніть на стовпчик чи клітинку — тут з'явиться матч.</p>
        <table class="markets dr-agg dr-dist"><thead><tr><th>Довжина</th><th>Серій виграшів</th><th>Серій програшів</th></tr></thead><tbody>${dist.join('')}</tbody></table>
        <details class="more"><summary>Усі серії по черзі · ${runs.length}</summary>
          <table class="markets dr-agg"><thead><tr><th>Серія</th><th>Коли · команди</th><th>Грн</th></tr></thead><tbody>${runs.slice().reverse().map(r => `
            <tr><td><b class="${r.s === 'win' ? 'ok' : 'bad'}">${r.s === 'win' ? '✓' : '✗'} ${r.bets.length}</b></td>
              <td>${runSpan(r)}<small>${teams(r)}</small></td>
              <td class="${r.profit >= 0 ? 'ok' : 'bad'}">${uah(r.profit)}</td></tr>`).join('')}</tbody></table>
        </details>
        <p class="hint">Ставки — за часом початку матчів. Графік: стовпчик над лінією — скільки виграшів поспіль після цієї ставки, під лінією — програшів поспіль.${label === 'ІТБ 1' ? ' Повернення (рівно 1 гол) серію не перериває і не подовжує.' : ''}</p>
      </section>`;
  }

  function aggRow(label, list) {
    const w = list.filter(b => b.s === 'win').length, v = list.filter(b => b.s === 'void').length, l = list.filter(b => b.s === 'loss').length;
    const pr = list.reduce((s, b) => s + b.profit, 0);
    const exp = list.length ? list.reduce((s, b) => s + b.p, 0) / list.length : 0;
    return `<tr><td>${esc(label)}</td><td>${w}/${v}/${l}</td><td><b>${w + l ? pct(w / (w + l)) : '—'}</b><small>очік. ${pct(exp)}</small></td>
      <td class="${pr >= 0 ? 'ok' : 'bad'}">${uah(pr)}<small>ROI ${list.length ? Math.round(pr / (list.length * STAKE) * 100) : 0}%</small></td></tr>`;
  }
  const aggHead = first => `<thead><tr><th>${first}</th><th>В/П/Пр</th><th>Влучність</th><th>Прибуток</th></tr></thead>`;

  function renderStats(d) {
    const recs = d.recs.filter(r => r.done && inPeriod(r.ev.ts)).sort((a, b) => a.ev.ts - b.ev.ts);
    const betsOf = r => [
      { r, key: 'it1', label: 'ІТБ 1', p: r.it1.p, s: r.st1, profit: profitOf(r.st1, r.it1.p) },
      { r, key: 'it15', label: 'ІТБ 1.5', p: r.it15.p, s: r.st15, profit: profitOf(r.st15, r.it15.p) },
    ];
    const all = recs.flatMap(betsOf);
    const pending = upcomingRecs(d).length;
    const head = `
      <div class="controls"><div class="chips">${PERIODS.map(([k, l]) => `<button class="chip ${state.period === k ? 'on' : ''}" data-period="${k}">${l}</button>`).join('')}</div></div>`;
    if (!recs.length) {
      $view.innerHTML = head + `<div class="empty">Статистика ведеться з нуля — з 20.10 20:30.<br>Зіграних рекомендацій ще немає, в очікуванні: ${pending}.<br>Результати з'являться після перших матчів.</div>`;
      return;
    }

    const leagues = new Map();
    for (const b of all) { const k = leagueLabel(b.r.slug); if (!leagues.has(k)) leagues.set(k, []); leagues.get(k).push(b); }

    // Команди, що не забили і після рекомендації.
    const failed = recs.filter(r => r.g === 0);
    const byTeam = new Map();
    for (const r of recs) {
      const k = r.team.id;
      if (!byTeam.has(k)) byTeam.set(k, { team: r.team, slug: r.slug, recs: 0, zero: 0 });
      const t = byTeam.get(k);
      t.recs++; if (r.g === 0) t.zero++;
    }
    const currentN = new Map(d.current.map(c => [c.team.id, c.n]));
    const teamRows = [...byTeam.values()].filter(t => t.zero).sort((a, b) => b.zero - a.zero || (currentN.get(b.team.id) || 0) - (currentN.get(a.team.id) || 0));

    const it1 = all.filter(b => b.key === 'it1'), it15 = all.filter(b => b.key === 'it15');
    const byStreakTable = list => [[2, 2, '2 матчі'], [3, 3, '3 матчі'], [4, 4, '4 матчі'], [5, 99, '5+ матчів']]
      .map(([lo, hi, label]) => [label, list.filter(b => b.r.n >= lo && b.r.n <= hi)]).filter(x => x[1].length)
      .map(([label, l]) => aggRow(label, l)).join('');

    $view.innerHTML = head + `
      <p class="hint pad">Облік — з 20.10 20:30: лише нові рекомендації. Рекомендацій зіграно: ${recs.length}. Прибуток у таблицях — умовні ${STAKE} грн на кожну ставку за справедливим кф моделі (у букмекера на 5–8% нижчий).</p>
      <section class="card"><h3>За ставками</h3>
        <table class="markets dr-agg">${aggHead('Ставка')}<tbody>${aggRow('ІТБ 1', it1)}${aggRow('ІТБ 1.5', it15)}</tbody></table>
        <p class="hint">В/П/Пр — виграно / повернення / програно. Команда забила хоча б один гол у ${pct(recs.filter(r => r.g > 0).length / recs.length)} матчів (${recs.filter(r => r.g > 0).length} з ${recs.length}).</p>
      </section>
      ${streaksCard('ІТБ 1', it1)}
      ${streaksCard('ІТБ 1.5', it15)}
      <section class="card"><h3>За довжиною серії · ІТБ 1</h3>
        <table class="markets dr-agg">${aggHead('Без голів')}<tbody>${byStreakTable(it1)}</tbody></table>
      </section>
      <section class="card"><h3>За довжиною серії · ІТБ 1.5</h3>
        <table class="markets dr-agg">${aggHead('Без голів')}<tbody>${byStreakTable(it15)}</tbody></table>
      </section>
      ${[['ІТБ 1', 'it1'], ['ІТБ 1.5', 'it15']].map(([label, key]) => `<section class="card"><h3>За турнірами · ${label}</h3>
        <table class="markets dr-agg">${aggHead('Турнір')}<tbody>${[...leagues].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => aggRow(k, list.filter(b => b.key === key))).join('')}</tbody></table>
      </section>`).join('')}
      <section class="card"><h3>Рекомендація = результат</h3>
        <table class="markets dr-res">
          <thead><tr><th>Матч</th><th>Рахунок</th><th>ІТБ 1</th><th>ІТБ 1.5</th></tr></thead>
          <tbody>${recs.slice().reverse().map(r => {
            const cell = (st, p) => {
              const pl = profitOf(st, p);
              return `<td class="${pl > 0 ? 'ok' : pl < 0 ? 'bad' : ''}">${ICON[st]} ${st === 'void' ? '0 грн' : uah(pl)}<small>${pct(p)} · кф ${(1 / p).toFixed(2)}</small></td>`;
            };
            return `<tr>
              <td><b>${esc(r.team.short || r.team.name)}</b> ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.short || r.opp.name)}<small>${dateOf(r.ev.ts)} · ${esc(leagueOf(r.slug).short)} · без голів ${r.n}</small></td>
              <td><b>${r.ev.home.score}:${r.ev.away.score}</b><small>забила ${r.g}</small></td>
              ${cell(r.st1, r.it1.p)}
              ${cell(r.st15, r.it15.p)}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </section>
      <section class="card dr-fail"><h3>Не забили і після рекомендації · ${failed.length}</h3>
        ${teamRows.length ? `<table class="markets">
          <thead><tr><th>Команда</th><th>Рекомендацій</th><th>Не забили</th><th>Серія зараз</th></tr></thead>
          <tbody>${teamRows.map(t => `<tr>
            <td><b>${esc(t.team.name)}</b><small>${esc(leagueLabel(t.slug))}</small></td>
            <td>${t.recs}</td><td class="bad">${t.zero}</td>
            <td>${currentN.has(t.team.id) ? `<b class="dr-n">${currentN.get(t.team.id)}</b>` : '<small>уже забила</small>'}</td>
          </tr>`).join('')}</tbody></table>` : ''}
        <div class="dr-list">${failed.slice().reverse().map(r => `
          <div class="hrow"><div class="hrow-main">
            <small>${dateOf(r.ev.ts)} · ${esc(leagueLabel(r.slug))}</small>
            <span><b>${esc(r.team.name)}</b> ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.name)} <b>${r.ev.home.score}:${r.ev.away.score}</b></span>
            <em>до матчу без голів ${matches(r.n)} → стало ${matches(r.n + 1)}</em>
          </div></div>`).join('')}</div>
      </section>`;
  }

  // ---------- навігація ----------
  // Вкладка «Усі турніри»: ті самі розділи, але серія — за всіма матчами команди.
  const ALL_VIEWS = [['recs', 'Рекомендації', renderRecs], ['teams', 'Серії', renderTeams], ['stats', 'Статистика', renderStats]];
  state.allView = 'recs';
  function renderAll(d) {
    const [, , render] = ALL_VIEWS.find(v => v[0] === state.allView);
    render(d);
    $view.insertAdjacentHTML('afterbegin', `
      <div class="controls"><div class="segmented">${ALL_VIEWS.map(([k, l]) => `<button class="${state.allView === k ? 'on' : ''}" data-allview="${k}">${l}</button>`).join('')}</div></div>
      <p class="summary dr-mode">Повна серія: чемпіонат + єврокубки + кубки — будь-який матч без гола подовжує серію.</p>`);
  }

  function route(keepScroll) {
    const h = location.hash.slice(1) || '/';
    if (keepScroll !== true) window.scrollTo(0, 0);
    if (h.startsWith('/teams')) return withData('Серії без голів', 'teams', renderTeams);
    if (h.startsWith('/stats')) return withData('Статистика', 'stats', renderStats);
    if (h.startsWith('/all')) return withData('Усі турніри', 'all', renderAll, 'all');
    return withData('Рекомендації', 'recs', renderRecs);
  }

  $view.addEventListener('click', e => {
    const tip = e.target.closest('[data-tip]');
    if (tip) {
      const $line = tip.closest('.card').querySelector('.dr-tipline');
      if ($line) $line.textContent = tip.dataset.tip;
      return;
    }
    const b = e.target.closest('button');
    if (!b || !state.data) return;
    if (b.dataset.period) { state.period = b.dataset.period; route(true); }
    else if (b.dataset.allview) { state.allView = b.dataset.allview; route(true); }
    else if (b.dataset.bet) { state.betKey = b.dataset.bet; route(true); }
  });
  document.getElementById('refresh').addEventListener('click', async () => {
    $title.textContent = 'Оновлення…';
    await load(true);
    route();
  });
  window.addEventListener('hashchange', route);
  // Автооновлення: рахунки й серії, поки додаток відкритий.
  setInterval(() => { if (!document.hidden) load(true).then(() => route(true)); }, REFRESH);
  route();
})();
