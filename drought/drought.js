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
  const BANK = 5000;
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
  const money = v => `${Math.round(v).toLocaleString('uk-UA')} грн`;
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
      let errors = 0;
      const seasons = (await api.pool(COMPS, 4, async c => {
        let s = null;
        try { s = { comp: c, ...(await api.season(c.slug, false, !c.cup)) }; } catch { if (!c.cup) errors++; }
        done++;
        const $p = document.getElementById('progress');
        if ($p) $p.textContent = `Завантаження турнірів: ${done} з ${COMPS.length}…`;
        return s;
      })).filter(Boolean);
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

  const leagueChip = slug => {
    const l = leagueOf(slug);
    return `<span class="m-league"><img src="${FP.leagueLogo(l)}" alt="">${esc(l.short)}</span>`;
  };

  const ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '↺', pending: '' };

  // ---------- Рекомендації ----------
  function betRow(label, team, p, st, extra) {
    return `
      <div class="dr-bet st-${st}">
        <div><span>${label} · ${esc(team.short || team.name)}</span>${extra ? `<small>${extra}</small>` : ''}</div>
        <b>${pct(p)}</b><i>кф ${(1 / p).toFixed(2)}</i><em>${ICON[st] || ''}</em>
      </div>`;
  }

  function recCard(r) {
    const ev = r.ev;
    const started = ev.state !== 'pre';
    const status = model.isResult(ev) ? 'Завершено' : ev.state === 'in' ? `LIVE ${esc(ev.clock || '')}` : timeOf(ev.ts);
    const name = t => `<span class="${t.id === r.team.id ? 'dr-hl' : ''}">${esc(t.name)}</span>`;
    return `
      <section class="card drec">
        <div class="m-meta"><span class="${ev.state === 'in' ? 'live' : ''}">${status}</span>${leagueChip(r.slug)}</div>
        <div class="dr-match">${name(ev.home)} <b>${started ? `${ev.home.score ?? 0} : ${ev.away.score ?? 0}` : '—'}</b> ${name(ev.away)}</div>
        <div class="dr-streak"><b>${esc(r.team.name)}</b> не забиває <b>${matches(r.n)}</b> поспіль${r.lastGoal ? ` · останній гол ${dateOf(r.lastGoal)}` : ''}</div>
        <div class="dr-bets">
          ${betRow('ІТБ 1', r.team, r.it1.p, r.st1, `рівно 1 гол — повернення (${pct(r.it1.push)})`)}
          ${betRow('ІТБ 1.5', r.team, r.it15.p, r.st15, '')}
        </div>
        <p class="hint">Очікувані голи команди: <b>${r.lambda.toFixed(2)}</b> · заб'є хоча б один: ${pct(r.scoreP)}</p>
      </section>`;
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

  function renderRecs(d) {
    const now = Date.now() / 1000;
    const upcoming = upcomingRecs(d);
    const recent = d.recs.filter(r => r.done && r.ev.ts >= LAUNCH && r.ev.ts > now - 3 * 86400).sort((a, b) => b.ev.ts - a.ev.ts);
    const analyzed = d.events.filter(x => !model.isResult(x.ev) && !VOID.test(x.ev.status) && x.ev.ts < now + HORIZON).length;
    const byDay = new Map();
    for (const r of upcoming) {
      const k = FP.dateOfTs(r.ev.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }
    const dayTitle = ts => {
      const o = Math.round((dayStart(ts) - dayStart(now)) / 86400);
      return o <= 2 ? dayLabel(o) : `${WD[new Date(ts * 1000).getDay()]}, ${dateOf(ts)}`;
    };
    $view.innerHTML = `
      <p class="summary">Проаналізовано ${matches(analyzed)} у ${d.mode === 'all' ? `${COMPS.length} турнірах` : `${CHAMPS.length} чемпіонатах`} на 10 днів · рекомендацій: <b>${upcoming.length}</b>${d.errors ? ` · не завантажено ліг: ${d.errors}` : ''}</p>
      ${upcoming.length ? [...byDay].map(([, list]) => `<h2 class="section-title">${esc(dayTitle(list[0].ev.ts))}</h2>${list.map(recCard).join('')}`).join('')
        : `<div class="empty">Найближчими днями немає матчів команд, що не забивають ${MIN_STREAK} тури і більше.</div>`}
      ${recent.length ? `<h2 class="section-title">Зіграні за 3 дні</h2>${recent.map(recCard).join('')}` : ''}
      <p class="hint pad">Рекомендація — лише для команди, яка не забивала ${d.mode === 'all' ? 'в усіх турнірах разом' : 'в чемпіонаті'} ${MIN_STREAK} матчі поспіль і більше. Ставки — на її індивідуальний тотал: ІТБ 1 (2+ голи — виграш, рівно 1 — повернення) та ІТБ 1.5 (2+ голи). Ймовірність — з моделі за результатами сезону; кф — справедливий (1 ÷ ймовірність), у букмекера на 5–8% нижчий.</p>`;
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

  function balanceChart(settled) {
    if (settled.length < 2) return '';
    const pts = [BANK];
    settled.forEach(b => pts.push(pts[pts.length - 1] + b.profit));
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    const W = 300, H = 110;
    const x = i => (i / (pts.length - 1)) * W, y = v => H - ((v - min) / span) * H;
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Графік балансу">
          <line x1="0" x2="${W}" y1="${y(BANK).toFixed(1)}" y2="${y(BANK).toFixed(1)}" class="chart-base"/>
          <polyline points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" class="chart-line ${pts[pts.length - 1] >= BANK ? 'up' : 'down'}"/>
        </svg>
        <div class="chart-axis"><span>${money(max)}</span><span>${money(min)}</span></div>
      </div>`;
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

  // ---------- Мартингейл ----------
  // Після програшу ставка росте так, щоб виграш покрив усі програші серії і дав ціль T; після виграшу —
  // знову перша ставка (прибуток виводиться, робочий депозит той самий). План має витримати N програшів
  // поспіль у межах депозиту. Кф — справедливий з моделі мінус 7% (так приблизно дає букмекер).
  // Ставки йдуть по одній: наступна — лише після розрахунку попередньої (матч ≈ 2 год).
  const MG_MARGIN = 0.93;
  const MG_MIN = 1;          // мінімальна ставка, грн (ставки округлюються вгору до гривні)
  const MG_GAP = 2 * 3600;
  const mgLoad = () => { try { return { bank: 500, steps: 10, ...JSON.parse(localStorage.getItem('dr_mg') || '{}') }; } catch { return { bank: 500, steps: 10 }; } };
  state.mg = mgLoad();

  // Драбина при кф k і цілі T: ставка кроку покриває програне в серії + T.
  function mgLadder(T, k, n) {
    let lost = 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = Math.max(MG_MIN, Math.ceil((lost + T) / (k - 1)));
      out.push({ s, total: lost + s, net: s * (k - 1) - lost });
      lost += s;
    }
    return out;
  }
  const mgSum = l => l.reduce((t, x) => t + x.s, 0);
  // Найбільша ціль, за якої n ставок уміщаються в депозит; null — не вміщаються навіть мінімальні.
  function mgTarget(k, n, bank) {
    if (mgSum(mgLadder(0, k, n)) > bank) return null;
    let lo = 0, hi = bank;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (mgSum(mgLadder(mid, k, n)) <= bank) lo = mid; else hi = mid; }
    return Math.floor(lo * 100) / 100;
  }
  function mgMaxSteps(k, bank) {
    let n = 0;
    while (n < 40 && mgSum(mgLadder(0, k, n + 1)) <= bank) n++;
    return n;
  }
  // Ймовірність хоча б раз програти n поспіль за m ставок при ймовірності програшу q.
  function runRisk(q, n, m) {
    let dist = new Array(n).fill(0), hit = 0;
    dist[0] = 1;
    for (let j = 0; j < m; j++) {
      const next = new Array(n).fill(0);
      dist.forEach((v, r) => { if (!v) return; next[0] += v * (1 - q); if (r + 1 >= n) hit += v * q; else next[r + 1] += v * q; });
      dist = next;
    }
    return hit;
  }

  // Прогін плану по зіграних рекомендаціях у хронологічному порядку.
  function mgSimulate(bets, k0, n, T) {
    let lost = 0, step = 0, profit = 0, busyUntil = 0;
    const res = { placed: 0, cycles: 0, busts: 0, maxStep: 0, overlap: 0, lowOdds: 0, maxStake: 0, pts: [0], log: [] };
    for (const b of bets) {
      const k = b.odds * MG_MARGIN;
      if (b.r.ev.ts < busyUntil) { res.overlap++; continue; }
      if (k < k0) { res.lowOdds++; continue; }
      const stake = Math.max(MG_MIN, Math.ceil((lost + T) / (k - 1)));
      busyUntil = b.r.ev.ts + MG_GAP;
      res.placed++;
      res.maxStake = Math.max(res.maxStake, stake);
      let note;
      if (b.s === 'void') note = 'повернення';
      else if (b.s === 'win') { const pr = stake * (k - 1) - lost; profit += pr; res.cycles++; note = `+${pr.toFixed(0)} грн за цикл`; lost = 0; step = 0; }
      else {
        lost += stake; step++;
        res.maxStep = Math.max(res.maxStep, step);
        note = `програш ${step} поспіль`;
        if (step >= n) { profit -= lost; res.busts++; note += ' — депозит втрачено'; lost = 0; step = 0; }
      }
      res.pts.push(profit - lost);
      res.log.push({ b, k, stake, note });
    }
    res.profit = profit;
    res.open = lost;
    res.step = step;
    return res;
  }

  function mgChart(pts, bank) {
    if (pts.length < 3) return '';
    const vals = pts.map(v => bank + v);
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const W = 300, H = 110, x = i => (i / (vals.length - 1)) * W, y = v => H - ((v - min) / span) * H;
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Робочий депозит">
          <line x1="0" x2="${W}" y1="${y(bank).toFixed(1)}" y2="${y(bank).toFixed(1)}" class="chart-base"/>
          <polyline points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" class="chart-line ${vals[vals.length - 1] >= bank ? 'up' : 'down'}"/>
        </svg>
        <div class="chart-axis"><span>${money(max)}</span><span>${money(min)}</span></div>
      </div>`;
  }

  // План для однієї ставки (ІТБ 1 або ІТБ 1.5): мінімальний кф, скільки програшів витримує депозит,
  // ціль за цикл, драбина ставок і прогін по зіграних рекомендаціях (з нього — поточний стан серії).
  function mgPlan(list) {
    const { bank, steps } = state.mg;
    const all = list.filter(b => b.s === 'win' || b.s === 'loss');
    if (all.length < 5) return { list, decided: all, n: 0 };
    // План розраховано на мінімальний кф, нижчі кф пропускаємо; влучність і ризик — лише по ставках,
    // що проходять за кф (з вищим кф вони виграють рідше).
    const k0 = mgMinOdds(list);
    const eligible = list.filter(b => b.odds * MG_MARGIN >= k0);
    const decided = eligible.filter(b => b.s === 'win' || b.s === 'loss');
    const hit = decided.length ? decided.filter(b => b.s === 'win').length / decided.length : 0;
    const cover = mgMaxSteps(k0, bank);
    const n = Math.min(steps, cover);
    const T = n ? mgTarget(k0, n, bank) : null;
    return {
      list: eligible, total: list.length, decided, hit, k0, cover, n, T,
      need: mgSum(mgLadder(0, k0, steps)),
      sim: n ? mgSimulate(eligible, k0, n, T) : null,
      lad: n ? mgLadder(T, k0, n) : [],
    };
  }

  function mgCard(label, P) {
    const { bank, steps } = state.mg;
    if (!P.k0) return `<section class="card"><h3>Мартингейл · ${label}</h3><p class="hint top">Замало зіграних ставок для розрахунку (${P.decided.length}).</p></section>`;
    const { list, decided, hit, k0, cover, n, T, need, sim, lad } = P;
    const runs = runsOf(list), longestLoss = Math.max(0, ...runs.filter(r => r.s === 'loss').map(r => r.bets.length));
    const q = 1 - hit;
    // Висновок за ризиком серії з n програшів за 100 ставок.
    const risk = n && decided.length >= 5 ? runRisk(q, n, 100) : null;
    const verdict = risk == null ? `<div class="notice">Ставок із кф від ${k0.toFixed(2)} поки ${decided.length} — замало, щоб оцінити ризик.</div>`
      : risk > 0.3 ? `<div class="notice error">Ризик дуже високий: з влучністю ${pct(hit)} серія з ${n} програшів поспіль за 100 ставок трапляється з імовірністю ${pct(risk)}. Тоді втрачається ${money(mgSum(lad))} — це ${Math.round(mgSum(lad) / T)} виграних циклів по ${T.toFixed(2)} грн. На дистанції стратегія, найімовірніше, втратить депозит.</div>`
      : risk > 0.1 ? `<div class="notice">Ризик відчутний: ${pct(risk)} за 100 ставок отримати ${n} програшів поспіль і втратити ${money(mgSum(lad))}.</div>`
      : `<div class="notice">Ризик помірний: ${pct(risk)} за 100 ставок на серію з ${n} програшів.</div>`;
    return `
      <section class="card"><h3>Мартингейл · ${label}</h3>
        ${verdict}
        ${cover < steps ? `<div class="notice error">Депозиту ${money(bank)} вистачає лише на <b>${cover}</b> ${plural(cover, 'програш', 'програші', 'програшів')} поспіль: навіть з мінімальних ставок по ${MG_MIN} грн ${steps}-й крок вимагає депозиту <b>${money(need)}</b>. План нижче — на ${n} ${plural(n, 'крок', 'кроки', 'кроків')}.</div>` : ''}
        <div class="kpis">
          <div><b>${T != null ? `${T.toFixed(2)} грн` : '—'}</b><span>прибуток<br>за виграний цикл</span></div>
          <div><b>${k0.toFixed(2)}</b><span>мінімальний кф<br>нижчий — не ставити</span></div>
          <div><b class="${n >= steps ? 'ok' : 'bad'}">${n}</b><span>програшів поспіль<br>витримує депозит</span></div>
        </div>
        <div class="kpis kpis2">
          <div><b>${decided.length ? pct(hit) : '—'}</b><span>влучність при кф ≥ ${k0.toFixed(2)}<br>підходить ${list.length} з ${P.total}</span></div>
          <div><b>${longestLoss}</b><span>найдовша серія<br>програшів досі</span></div>
          <div><b class="${runRisk(q, n || 1, 100) > 0.1 ? 'bad' : ''}">${n && decided.length >= 5 ? pct(runRisk(q, n, 100)) : '—'}</b><span>ризик ${n} програшів<br>поспіль за 100 ставок</span></div>
        </div>
        ${n ? `<table class="markets dr-agg dr-ladder"><thead><tr><th>Крок</th><th>Ставка</th><th>Усього в серії</th><th>Чистий виграш</th></tr></thead><tbody>${lad.map((x, i) => `
          <tr><td>${i + 1}</td><td><b>${x.s} грн</b></td><td>${x.total} грн</td><td class="ok">+${x.net.toFixed(0)} грн</td></tr>`).join('')}
          <tr><td colspan="2">Залишок депозиту після ${n} програшів</td><td colspan="2"><b>${money(bank - mgSum(lad))}</b></td></tr></tbody></table>
        <p class="hint">Як ставити: перша ставка — ${lad[0].s} грн. Після програшу — ставка = (програно в цій серії + ${T.toFixed(2)}) ÷ (кф − 1), округлити вгору; таблиця — найгірший випадок при кф ${k0.toFixed(2)}, з вищим кф ставка менша. Після виграшу — знову ${lad[0].s} грн, прибуток виводити.${label === 'ІТБ 1' ? ' Повернення (рівно 1 гол) — крок не змінюється, ту саму ставку повторити на наступній рекомендації.' : ''} Одна ставка за раз: наступна — після розрахунку попередньої.</p>` : ''}
        ${sim ? `<h3 class="dr-sub">Якби ставили так з ${dateOf(list[0].r.ev.ts)}</h3>
          <div class="kpis">
            <div><b class="${sim.profit - sim.open >= 0 ? 'ok' : 'bad'}">${uah(sim.profit - sim.open)}</b><span>результат${sim.open ? `<br>з них у грі −${sim.open} грн` : ''}</span></div>
            <div><b>${sim.cycles}</b><span>виграних циклів<br>ставок ${sim.placed}</span></div>
            <div><b class="${sim.busts ? 'bad' : 'ok'}">${sim.busts}</b><span>втрат депозиту<br>найдовше ${sim.maxStep} поспіль</span></div>
          </div>
          ${mgChart(sim.pts, bank)}
          <p class="hint">Найбільша ставка ${sim.maxStake} грн. Пропущено: ${sim.overlap} — матч накладався на ще не розраховану ставку, ${P.total - list.length} — кф нижчий за ${k0.toFixed(2)}.${decided.length < 5 ? ' Ставок із таким кф поки замало — висновки ненадійні.' : ''}</p>
          <details class="more"><summary>Усі ставки плану · ${sim.log.length}</summary>
            <table class="markets dr-agg"><thead><tr><th>Матч</th><th>Ставка</th><th>Результат</th></tr></thead><tbody>${sim.log.slice().reverse().map(x => `
              <tr><td>${esc(x.b.r.team.short || x.b.r.team.name)} ${x.b.r.side === 'home' ? 'vs' : '@'} ${esc(x.b.r.opp.short || x.b.r.opp.name)}<small>${dateOf(x.b.r.ev.ts)} ${timeOf(x.b.r.ev.ts)} · забила ${x.b.r.g}</small></td>
                <td><b>${x.stake} грн</b><small>кф ${x.k.toFixed(2)}</small></td>
                <td class="${x.b.s === 'win' ? 'ok' : x.b.s === 'loss' ? 'bad' : ''}">${ICON[x.b.s]}<small>${x.note}</small></td></tr>`).join('')}</tbody></table>
          </details>` : ''}
      </section>`;
  }

  // Мінімальний кф плану — найменший, за якого депозит витримує задану кількість програшів поспіль
  // і виграний цикл дає хоча б 1 грн. Ставки з нижчим кф пропускаються. Якщо з усіх кф в історії
  // жоден не підходить — 10-й перцентиль (план тоді покриває менше програшів, і це показано).
  function mgMinOdds(list) {
    const { bank, steps } = state.mg;
    const odds = list.map(b => b.odds * MG_MARGIN).sort((a, b) => a - b);
    if (!odds.length) return null;
    for (let k = 1.2; k <= odds[odds.length - 1]; k = Math.round((k + 0.05) * 100) / 100) {
      const T = mgTarget(k, steps, bank);
      if (T != null && T >= 1) return k;
    }
    return Math.floor(odds[Math.floor(odds.length * 0.1)] * 100) / 100;
  }

  // Ланцюжки: у кожному наступний матч починається не раніше ніж через 2 год після попереднього —
  // результат попередньої ставки вже відомий. Перший ланцюжок — найдовший (жадібно за часом початку),
  // з решти — другий і т. д.
  function mgChains(recs) {
    let left = recs.slice().sort((a, b) => a.ev.ts - b.ev.ts || b.it15.p - a.it15.p);
    const chains = [];
    while (left.length) {
      const chain = [], rest = [];
      let free = -Infinity;
      for (const r of left) {
        if (r.ev.ts >= free) { chain.push(r); free = r.ev.ts + MG_GAP; } else rest.push(r);
      }
      chains.push(chain);
      left = rest;
    }
    return chains;
  }

  // Ставки ланцюжка за планом, якщо всі попередні в ньому програють (найгірший випадок).
  // start — стан серії, з якого ланцюжок продовжується: { lost, step }.
  function mgChainStakes(chain, P, key, start) {
    let lost = start.lost, step = start.step;
    return chain.map(r => {
      const o = MG_MARGIN / r[key].p;
      if (!P.n) return { o, skip: 'немає плану' };
      if (o < P.k0) return { o, skip: 'пропуск' };
      if (step >= P.n) return { o, skip: 'депозит вичерпано' };
      const s = Math.max(MG_MIN, Math.ceil((lost + P.T) / (o - 1)));
      step++;
      lost += s;
      return { o, s, step };
    });
  }

  // Розклад на найближчі дні, розбитий на ланцюжки. Ланцюжок не обривається з кінцем дня: якщо серія
  // програшів не закінчилась, вона продовжується матчами наступного дня, доки не буде виграшу; після
  // виграшу нова серія починається з першої ставки на наступних матчах ланцюжка. Ланцюжок 1 продовжує
  // поточну серію з уже зіграних рекомендацій (прогін плану нижче).
  function mgSchedule(d, plans) {
    const upcoming = upcomingRecs(d).filter(r => r.ev.state !== 'post');
    if (!upcoming.length) return `<section class="card"><h3>Розклад</h3><p class="hint top">Найближчими днями рекомендацій немає.</p></section>`;
    const chains = mgChains(upcoming);
    const now = Date.now() / 1000;
    const stateOf = P => (P.sim ? { lost: P.sim.open, step: P.sim.step } : { lost: 0, step: 0 });
    const cell = x => (x.skip
      ? `<td class="mg-skip">—<small>кф ${x.o.toFixed(2)} · ${x.skip}</small></td>`
      : `<td><b>${x.s} грн</b><small>крок ${x.step} · кф ${x.o.toFixed(2)}</small></td>`);
    const table = (c, start15, start1) => {
      const a = mgChainStakes(c, plans.it15, 'it15', start15), b = mgChainStakes(c, plans.it1, 'it1', start1);
      let day = null;
      return `<table class="markets dr-agg mg-sched"><thead><tr><th>Час</th><th>Команда</th><th>ІТБ 1.5</th><th>ІТБ 1</th></tr></thead><tbody>${c.map((r, j) => {
        const ds = dayStart(r.ev.ts), head = ds !== day ? `<tr class="mg-day"><td colspan="4">${esc(dayLabel(Math.round((ds - dayStart(now)) / 86400)))}</td></tr>` : '';
        day = ds;
        return `${head}<tr><td><b class="${r.ev.state === 'in' ? 'live' : ''}">${r.ev.state === 'in' ? 'LIVE' : timeOf(r.ev.ts)}</b><small>результат ≈ ${timeOf(r.ev.ts + MG_GAP)}</small></td>
          <td><b>${esc(r.team.short || r.team.name)}</b> ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.short || r.opp.name)}<small>${esc(leagueOf(r.slug).short)} · без голів ${r.n}</small></td>
          ${cell(a[j])}${cell(b[j])}</tr>`;
      }).join('')}</tbody></table>`;
    };
    const cur = (label, P) => {
      const s = stateOf(P);
      return P.n ? `${label}: ${s.step ? `крок ${s.step + 1}, у серії програно ${s.lost} грн` : 'нова серія з першої ставки'}` : `${label}: немає плану`;
    };
    const first = P => (P.lad && P.lad[0] ? `${P.lad[0].s} грн` : '—');
    return `
      <section class="card"><h3>Розклад ставок</h3>
        <p class="hint top">${matches(upcoming.length)} → ${chains.length} ${plural(chains.length, 'ланцюжок', 'ланцюжки', 'ланцюжків')}. У ланцюжку кожен наступний матч починається, коли попередній уже закінчився (≥ 2 год): ставку робиш, побачивши результат.</p>
        <div class="mg-chain main"><h4>Ланцюжок 1 · головний · ${matches(chains[0].length)}</h4>
          <p class="mg-now">Зараз: ${cur('ІТБ 1.5', plans.it15)} · ${cur('ІТБ 1', plans.it1)}</p>
          ${table(chains[0], stateOf(plans.it15), stateOf(plans.it1))}
        </div>
        <p class="hint">«Пропуск» — кф нижчий за мінімальний (ІТБ 1.5 — ${plans.it15.k0 ? plans.it15.k0.toFixed(2) : '—'}, ІТБ 1 — ${plans.it1.k0 ? plans.it1.k0.toFixed(2) : '—'}): на цей матч не ставити, крок не змінюється. Сума в рядку — якщо всі попередні ставки ланцюжка програли. Виграш — серія закінчена: наступна ставка знову перша (ІТБ 1.5 — ${first(plans.it15)}, ІТБ 1 — ${first(plans.it1)}), суму рахуй з кроку 1. Програш — переходь на наступний рядок. Якщо серія не закінчилась за день, вона продовжується матчами наступного дня, доки не буде виграшу.${plans.it1.n ? ' ІТБ 1, рівно 1 гол — повернення: крок не змінюється.' : ''}</p>
        ${chains.length > 1 ? `<details class="more"><summary>Ще ${chains.length - 1} ${plural(chains.length - 1, 'ланцюжок', 'ланцюжки', 'ланцюжків')} — для окремих депозитів</summary>
          <p class="hint">Матчі, що накладаються на ланцюжок 1. Кожен ланцюжок — окрема серія зі своїм депозитом ${money(state.mg.bank)}; з одним депозитом грай лише ланцюжок 1.</p>
          ${chains.slice(1).map((c, i) => `<div class="mg-chain"><h4>Ланцюжок ${i + 2} · ${matches(c.length)}</h4>${table(c, { lost: 0, step: 0 }, { lost: 0, step: 0 })}</div>`).join('')}
        </details>` : ''}
        <p class="hint">Кф — справедливий мінус 7%; перед ставкою звір з реальним кф букмекера.</p>
      </section>`;
  }

  // Вкладка «Мартингейл»: стратегія для рекомендацій «Сухих серій» (режим «Чемпіонат»), окремо для ІТБ 1 і ІТБ 1.5.
  function renderMg(d) {
    const { bank, steps } = state.mg;
    const recs = d.recs.filter(r => r.done && r.ev.ts >= LAUNCH);
    const list = key => recs.map(r => ({ r, s: key === 'it1' ? r.st1 : r.st15, p: r[key].p, odds: 1 / r[key].p }))
      .sort((a, b) => a.r.ev.ts - b.r.ev.ts || b.p - a.p);
    const plans = { it15: mgPlan(list('it15')), it1: mgPlan(list('it1')) };
    $view.innerHTML = `
      <section class="card">
        <div class="mg-inputs">
          <label>Депозит, грн <input id="mg-bank" type="number" inputmode="numeric" min="50" step="50" value="${bank}"></label>
          <label>Програшів поспіль <input id="mg-steps" type="number" inputmode="numeric" min="2" max="20" value="${steps}"></label>
        </div>
        <p class="hint">Окремий план для ІТБ 1.5 і ІТБ 1 на рекомендації «Сухих серій». Мартингейл не робить ставки вигіднішими: він часто дає дрібний плюс, але рідкісна довга серія програшів забирає депозит. Тому план розраховано так, щоб депозит витримав ${steps} програшів поспіль, а ризик такої серії показано окремо.</p>
      </section>
      ${mgSchedule(d, plans)}
      ${mgCard('ІТБ 1.5', plans.it15)}
      ${mgCard('ІТБ 1', plans.it1)}
      <p class="hint pad">Кф у розрахунку — справедливий з моделі мінус 7% (приблизно як у букмекера). Перед ставкою дивіться реальний кф: якщо він нижчий за мінімальний — пропустіть рекомендацію. Ризик — за влучністю з 20.10; на невеликій статистиці вона неточна. 18+.</p>`;
  }

  // Рядок таблиці: ставок, виграно / повернення / програно, % влучності (без повернень), очікувалось, прибуток, ROI.
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

    // Окремий рахунок для кожної ставки: свій депозит 5000 грн, 50 грн на ставку.
    const bankCard = (label, list) => {
      const pr = list.reduce((s, b) => s + b.profit, 0);
      const w = list.filter(b => b.s === 'win').length, v = list.filter(b => b.s === 'void').length, l = list.filter(b => b.s === 'loss').length;
      return `
        <section class="card bank">
          <div class="bank-balance"><span>Рахунок ${label}</span><b class="${pr >= 0 ? 'ok' : 'bad'}">${money(BANK + pr)}</b><small>депозит ${money(BANK)} · ставка ${STAKE} грн</small></div>
          <div class="kpis kpis2">
            <div><b class="${pr >= 0 ? 'ok' : 'bad'}">${uah(pr)}</b><span>прибуток</span></div>
            <div><b>${(pr / (list.length * STAKE) * 100).toFixed(1)}%</b><span>ROI<br>поставлено ${money(list.length * STAKE)}</span></div>
            <div><b>${w} / ${l}</b><span>виграно / програно${v ? `<br>повернень ${v}` : ''}</span></div>
          </div>
          ${balanceChart(list)}
        </section>`;
    };
    const it1 = all.filter(b => b.key === 'it1'), it15 = all.filter(b => b.key === 'it15');
    const byStreakTable = list => [[2, 2, '2 матчі'], [3, 3, '3 матчі'], [4, 4, '4 матчі'], [5, 99, '5+ матчів']]
      .map(([lo, hi, label]) => [label, list.filter(b => b.r.n >= lo && b.r.n <= hi)]).filter(x => x[1].length)
      .map(([label, l]) => aggRow(label, l)).join('');

    $view.innerHTML = head + `
      ${bankCard('ІТБ 1', it1)}
      ${bankCard('ІТБ 1.5', it15)}
      <p class="hint pad">Два окремі рахунки: на кожну рекомендацію — 50 грн на ІТБ 1 з рахунку ІТБ 1 і 50 грн на ІТБ 1.5 з рахунку ІТБ 1.5. Кф — справедливий за ймовірністю моделі; у букмекера він на 5–8% нижчий, тож реальний результат був би гіршим. Облік — з 20.10 20:30: лише нові рекомендації. Рекомендацій зіграно: ${recs.length}.</p>
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
    if (h.startsWith('/mg')) return withData('Мартингейл', 'mg', renderMg);
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
  });
  $view.addEventListener('change', e => {
    if (e.target.id !== 'mg-bank' && e.target.id !== 'mg-steps') return;
    const v = Number(e.target.value);
    if (e.target.id === 'mg-bank') state.mg.bank = Math.max(50, v || 500);
    else state.mg.steps = Math.min(20, Math.max(2, Math.round(v) || 10));
    try { localStorage.setItem('dr_mg', JSON.stringify(state.mg)); } catch {}
    route(true);
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
