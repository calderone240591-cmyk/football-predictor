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
  // Перша ставка — 25 грн. Після програшу ставка росте так, щоб виграш відіграв усе програне в серії
  // і дав той самий чистий виграш, що й перша ставка: ставка = (програно + 25 × (кф − 1)) ÷ (кф − 1).
  // Після виграшу — знову перша ставка (прибуток виводиться, робочий депозит той самий).
  // Кф — справедливий з моделі мінус 7% (так приблизно дає букмекер); у драбині — медіанний кф ставки.
  // Ставки йдуть по одній: наступна — лише після закінчення попереднього матчу (≈ 2 год від початку).
  const MG_MARGIN = 0.93;
  const MG_GAP = 2 * 3600;
  const MG_DEFAULT = { bank: 500, stake: 25, steps: 10 };
  const mgLoad = () => { try { return { ...MG_DEFAULT, ...JSON.parse(localStorage.getItem('dr_mg') || '{}') }; } catch { return { ...MG_DEFAULT }; } };
  state.mg = mgLoad();

  const mgStake = (lost, T, k) => Math.ceil((lost + T) / (k - 1) - 1e-9);

  // Драбина при кф k: ставка кроку, усього поставлено в серії, чистий виграш, якщо цей крок зіграє.
  function mgLadder(T, k, n) {
    let lost = 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = mgStake(lost, T, k);
      out.push({ s, total: lost + s, net: s * (k - 1) - lost });
      lost += s;
    }
    return out;
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

  // Наступна ставка серії cur = { lost, step, T }. Серія завжди починається з першої ставки (25 грн);
  // її ціль T = перша ставка × (кф − 1) — виграш на будь-якому кроці дає стільки ж. Якщо на ставку вже
  // не вистачає депозиту — серію програно (втрачено все поставлене в ній), нова — з першої ставки.
  function mgNext(cur, stake, k, bank) {
    const start = () => { cur.lost = 0; cur.step = 0; cur.T = stake * (k - 1); };
    if (!cur.step) start();
    let s = mgStake(cur.lost, cur.T, k), bust = false;
    if (cur.lost + s > bank) { bust = true; start(); s = stake; }
    return { s, bust };
  }

  // Прогін плану по зіграних рекомендаціях, по одній ставці за раз (як ланцюжок 1 у розкладі).
  function mgSimulate(bets, stake, bank) {
    const cur = { lost: 0, step: 0, T: 0 };
    let profit = 0, busyUntil = 0;
    const res = { placed: 0, cycles: 0, busts: 0, maxStep: 0, overlap: 0, maxStake: 0, pts: [0], log: [] };
    for (const b of bets) {
      if (b.r.ev.ts < busyUntil) { res.overlap++; continue; }
      busyUntil = b.r.ev.ts + MG_GAP;
      const k = b.odds * MG_MARGIN;
      const lostBefore = cur.lost;
      const { s, bust } = mgNext(cur, stake, k, bank);
      if (bust) { profit -= lostBefore; res.busts++; }
      res.placed++;
      res.maxStake = Math.max(res.maxStake, s);
      let note = bust ? `депозиту не вистачило: −${lostBefore} грн, знову з першої ставки · ` : '';
      if (b.s === 'void') note += 'повернення — крок той самий';
      else if (b.s === 'win') {
        const pr = s * (k - 1) - cur.lost;
        profit += pr; res.cycles++;
        note += `виграш на кроці ${cur.step + 1}: +${Math.round(pr)} грн`;
        cur.lost = 0; cur.step = 0;
      } else {
        cur.lost += s; cur.step++;
        res.maxStep = Math.max(res.maxStep, cur.step);
        note += `програш ${cur.step} поспіль`;
      }
      res.pts.push(profit - cur.lost);
      res.log.push({ b, k, s, note });
    }
    return { ...res, profit, open: cur.lost, step: cur.step, T: cur.T };
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

  // План для однієї ставки (ІТБ 1 або ІТБ 1.5) за всіма зіграними рекомендаціями.
  function mgPlan(list) {
    const { bank, stake, steps } = state.mg;
    const decided = list.filter(b => b.s === 'win' || b.s === 'loss');
    if (decided.length < 5) return null;
    const wins = decided.filter(b => b.s === 'win').length;
    const odds = list.map(b => b.odds * MG_MARGIN).sort((a, b) => a - b);
    const k = Math.round(odds[Math.floor(odds.length / 2)] * 100) / 100;
    const T = stake * (k - 1);
    const lad = mgLadder(T, k, steps);
    const runs = runsOf(list);
    return {
      list, decided, wins, hit: wins / decided.length, k, T, lad,
      cover: lad.filter(x => x.total <= bank).length,
      lossRuns: runs.filter(r => r.s === 'loss'), winRuns: runs.filter(r => r.s === 'win'),
      sim: mgSimulate(list, stake, bank),
    };
  }

  const pct1 = p => (p >= 0.1 ? pct(p) : `${(p * 100).toFixed(1)}%`);

  function mgCard(label, P) {
    const { bank, stake, steps } = state.mg;
    if (!P) return `<section class="card"><h3>Мартингейл · ${label}</h3><p class="hint top">Замало зіграних ставок для розрахунку.</p></section>`;
    const { decided, wins, hit, k, T, lad, cover, lossRuns, winRuns, sim } = P;
    const q = 1 - hit;
    const longest = rs => rs.reduce((m, r) => (!m || r.bets.length >= m.bets.length ? r : m), null);
    const ll = longest(lossRuns), lw = longest(winRuns);
    const seen = n => lossRuns.filter(r => r.bets.length >= n).length;
    const risk = cover ? runRisk(q, cover, 100) : 1;
    const used = cover ? lad[cover - 1].total : 0;
    const verdict = `<div class="notice ${risk > 0.3 ? 'error' : ''}">Депозит ${money(bank)} витримує <b>${cover}</b> ${plural(cover, 'програш', 'програші', 'програшів')} поспіль (поставлено ${money(used)}); ${cover + 1}-ї ставки вже не вистачить.
      У статистиці найдовша серія програшів — <b>${ll ? ll.bets.length : 0}</b>. З влучністю ${pct(hit)} шанс, що за 100 ставок трапиться ${cover} ${plural(cover, 'програш', 'програші', 'програшів')} поспіль, — <b>${pct1(risk)}</b>: тоді втрачається ${money(used)}, а це ${Math.round(used / T)} виграних серій по ${Math.round(T)} грн.</div>`;
    return `
      <section class="card"><h3>Мартингейл · ${label}</h3>
        <div class="kpis">
          <div><b>${pct(hit)}</b><span>влучність<br>${wins} з ${decided.length}</span></div>
          <div><b class="bad">${ll ? ll.bets.length : 0}</b><span>найдовша серія<br>програшів${ll ? ` · ${runSpan(ll)}` : ''}</span></div>
          <div><b class="ok">${lw ? lw.bets.length : 0}</b><span>найдовша серія<br>виграшів${lw ? ` · ${runSpan(lw)}` : ''}</span></div>
        </div>
        <div class="kpis kpis2">
          <div><b>${k.toFixed(2)}</b><span>типовий кф<br>(медіана)</span></div>
          <div><b class="ok">+${Math.round(T)} грн</b><span>виграш<br>за серію</span></div>
          <div><b class="${cover >= steps ? 'ok' : 'bad'}">${cover}</b><span>програшів поспіль<br>витримує депозит</span></div>
        </div>
        ${verdict}
        <table class="markets dr-agg dr-ladder"><thead><tr><th>Крок</th><th>Ставка</th><th>Усього</th><th>Виграш</th><th>Шанс</th></tr></thead><tbody>${lad.map((x, i) => `
          <tr class="${x.total > bank ? 'over' : ''}"><td>${i + 1}</td><td><b>${x.s} грн</b></td><td>${x.total} грн${x.total > bank ? '<small>більше депозиту</small>' : ''}</td><td class="ok">+${Math.round(x.net)} грн</td>
            <td>${pct1(Math.pow(q, i))}<small>${i ? `було ${seen(i)} ${plural(seen(i), 'серія', 'серії', 'серій')} з ${i}+ програшів` : 'перша ставка'}</small></td></tr>`).join('')}</tbody></table>
        <p class="hint">«Шанс» — ймовірність, що серія дійде до цього кроку (усі попередні ставки програли), за влучністю ${pct(hit)}; під ним — скільки разів таке вже було. Таблиця — при кф ${k.toFixed(2)}: з вищим кф ставки менші, з нижчим — більші. Щоб витримати ${steps} програшів поспіль, потрібен депозит <b>${money(lad[lad.length - 1].total)}</b>.${label === 'ІТБ 1' ? ' Рівно 1 гол — повернення: крок не змінюється.' : ''}</p>
        <h3 class="dr-sub">Якби ставили так з ${dateOf(P.list[0].r.ev.ts)}</h3>
        <div class="kpis">
          <div><b class="${sim.profit - sim.open >= 0 ? 'ok' : 'bad'}">${uah(sim.profit - sim.open)}</b><span>результат${sim.open ? `<br>з них у грі −${sim.open} грн` : ''}</span></div>
          <div><b>${sim.cycles}</b><span>виграних серій<br>ставок ${sim.placed}</span></div>
          <div><b class="${sim.busts ? 'bad' : 'ok'}">${sim.busts}</b><span>разів не вистачило<br>депозиту</span></div>
        </div>
        ${mgChart(sim.pts, bank)}
        <p class="hint">По одній ставці за раз, як у ланцюжку 1: ${sim.overlap} ${plural(sim.overlap, 'матч пропущено', 'матчі пропущено', 'матчів пропущено')}, бо починались, коли попередній ще йшов. Найдовше програшів поспіль — ${sim.maxStep}, найбільша ставка — ${sim.maxStake} грн.</p>
        <details class="more"><summary>Усі ставки плану · ${sim.log.length}</summary>
          <table class="markets dr-agg"><thead><tr><th>Матч</th><th>Ставка</th><th>Результат</th></tr></thead><tbody>${sim.log.slice().reverse().map(x => `
            <tr><td>${esc(x.b.r.team.short || x.b.r.team.name)} ${x.b.r.side === 'home' ? 'vs' : '@'} ${esc(x.b.r.opp.short || x.b.r.opp.name)}<small>${dateOf(x.b.r.ev.ts)} ${timeOf(x.b.r.ev.ts)} · забила ${x.b.r.g}</small></td>
              <td><b>${x.s} грн</b><small>кф ${x.k.toFixed(2)}</small></td>
              <td class="${x.b.s === 'win' ? 'ok' : x.b.s === 'loss' ? 'bad' : ''}">${ICON[x.b.s]}<small>${x.note}</small></td></tr>`).join('')}</tbody></table>
        </details>
      </section>`;
  }

  // Ланцюжки: у кожному наступний матч починається не раніше, ніж закінчився попередній (≥ 2 год від
  // початку), тож ставку робиш, уже знаючи результат. Ланцюжок 1 — найдовший, з решти — 2-й і т. д.
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

  // Ставки ланцюжка, якщо всі попередні в ньому програють. start — поточний стан серії { lost, step, T }.
  function mgChainStakes(chain, P, key, start) {
    const cur = { ...start };
    return chain.map(r => {
      const k = MG_MARGIN / r[key].p;
      if (!P) return { k };
      const { s, bust } = mgNext(cur, state.mg.stake, k, state.mg.bank);
      cur.lost += s; cur.step++;
      return { k, s, bust, step: cur.step };
    });
  }

  // Розклад: найближчі рекомендації, розбиті на ланцюжки. Ланцюжок не обривається з кінцем дня — серія
  // програшів продовжується матчами наступних днів, доки не буде виграшу. Ланцюжок 1 продовжує поточну
  // серію з уже зіграних рекомендацій.
  function mgSchedule(d, plans) {
    const upcoming = upcomingRecs(d).filter(r => r.ev.state !== 'post');
    if (!upcoming.length) return `<section class="card"><h3>Розклад ставок</h3><p class="hint top">Найближчими днями рекомендацій немає.</p></section>`;
    const chains = mgChains(upcoming);
    const now = Date.now() / 1000;
    const { stake } = state.mg;
    const stateOf = P => (P ? { lost: P.sim.open, step: P.sim.step, T: P.sim.T } : { lost: 0, step: 0, T: 0 });
    const cell = x => (x.s == null ? `<td>—<small>кф ${x.k.toFixed(2)}</small></td>`
      : `<td class="${x.bust ? 'mg-bust' : ''}"><b>${x.s} грн</b><small>${x.bust ? 'депозит вичерпано, знову з 1-ї · ' : ''}крок ${x.step} · кф ${x.k.toFixed(2)}</small></td>`);
    const table = (c, s15, s1) => {
      const a = mgChainStakes(c, plans.it15, 'it15', s15), b = mgChainStakes(c, plans.it1, 'it1', s1);
      let day = null;
      return `<table class="markets dr-agg mg-sched"><thead><tr><th>Ставка</th><th>Команда</th><th>ІТБ 1.5</th><th>ІТБ 1</th></tr></thead><tbody>${c.map((r, j) => {
        const ds = dayStart(r.ev.ts), head = ds !== day ? `<tr class="mg-day"><td colspan="4">${esc(dayLabel(Math.round((ds - dayStart(now)) / 86400)))}</td></tr>` : '';
        day = ds;
        return `${head}<tr><td><b>${j + 1}. <span class="${r.ev.state === 'in' ? 'live' : ''}">${r.ev.state === 'in' ? 'LIVE' : timeOf(r.ev.ts)}</span></b><small>кінець ≈ ${timeOf(r.ev.ts + MG_GAP)}</small></td>
          <td><b>${esc(r.team.short || r.team.name)}</b> ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.short || r.opp.name)}<small>${esc(leagueOf(r.slug).short)} · без голів ${r.n}</small></td>
          ${cell(a[j])}${cell(b[j])}</tr>`;
      }).join('')}</tbody></table>`;
    };
    const cur = (label, P) => {
      const s = stateOf(P);
      return s.step ? `${label} — ${s.step} ${plural(s.step, 'програш', 'програші', 'програшів')} поспіль (−${s.lost} грн), наступна ставка — крок ${s.step + 1}` : `${label} — нова серія, ставка ${stake} грн`;
    };
    return `
      <section class="card"><h3>Розклад ставок</h3>
        <p class="hint top">${matches(upcoming.length)} розбито на ${chains.length} ${plural(chains.length, 'ланцюжок', 'ланцюжки', 'ланцюжків')}. У ланцюжку кожен наступний матч починається вже після кінця попереднього — ставиш, коли знаєш результат.</p>
        <div class="mg-chain main"><h4>Ланцюжок 1 · ${matches(chains[0].length)}</h4>
          <p class="mg-now">Зараз: ${cur('ІТБ 1.5', plans.it15)}; ${cur('ІТБ 1', plans.it1)}.</p>
          ${table(chains[0], stateOf(plans.it15), stateOf(plans.it1))}
        </div>
        <p class="hint">Як ставити: йди по рядках згори вниз. Суми в рядках — якщо всі попередні ставки програли. <b>Виграш</b> — серія закінчена, наступна ставка знову ${stake} грн, далі суми рахуй з кроку 1 (таблиця кроків нижче). <b>Програш</b> — став суму з наступного рядка. Якщо серія не закінчилась за день, продовжуй матчами наступного дня.</p>
        ${chains.length > 1 ? `<details class="more"><summary>Ще ${chains.length - 1} ${plural(chains.length - 1, 'ланцюжок', 'ланцюжки', 'ланцюжків')} — матчі, що накладаються на ланцюжок 1</summary>
          <p class="hint">Кожен — окрема серія зі своїм депозитом ${money(state.mg.bank)}. З одним депозитом грай лише ланцюжок 1.</p>
          ${chains.slice(1).map((c, i) => `<div class="mg-chain"><h4>Ланцюжок ${i + 2} · ${matches(c.length)}</h4>${table(c, { lost: 0, step: 0, T: 0 }, { lost: 0, step: 0, T: 0 })}</div>`).join('')}
        </details>` : ''}
      </section>`;
  }

  // Вкладка «Мартингейл»: стратегія для рекомендацій «Сухих серій» (режим «Чемпіонат»), окремо для ІТБ 1.5 і ІТБ 1.
  function renderMg(d) {
    const { bank, stake, steps } = state.mg;
    const recs = d.recs.filter(r => r.done && r.ev.ts >= LAUNCH);
    const list = key => recs.map(r => ({ r, s: key === 'it1' ? r.st1 : r.st15, p: r[key].p, odds: 1 / r[key].p }))
      .sort((a, b) => a.r.ev.ts - b.r.ev.ts || b.p - a.p);
    const plans = { it15: mgPlan(list('it15')), it1: mgPlan(list('it1')) };
    $view.innerHTML = `
      <section class="card">
        <div class="mg-inputs">
          <label>Депозит, грн <input id="mg-bank" type="number" inputmode="numeric" min="50" step="50" value="${bank}"></label>
          <label>Перша ставка, грн <input id="mg-stake" type="number" inputmode="numeric" min="1" step="5" value="${stake}"></label>
          <label>Кроків у таблиці <input id="mg-steps" type="number" inputmode="numeric" min="2" max="20" value="${steps}"></label>
        </div>
        <p class="hint">Мартингейл для рекомендацій «Сухих серій», окремо для ІТБ 1.5 і ІТБ 1, за всіма зіграними рекомендаціями з 20.10. Після програшу ставка росте так, щоб виграш відіграв усе програне і дав ${Math.round(stake)} × (кф − 1) грн, як перша ставка; після виграшу — знову ${stake} грн.</p>
      </section>
      ${mgSchedule(d, plans)}
      ${mgCard('ІТБ 1.5', plans.it15)}
      ${mgCard('ІТБ 1', plans.it1)}
      <p class="hint pad">Кф у розрахунку — справедливий з моделі мінус 7% (приблизно як у букмекера). Перед ставкою дивись реальний кф: ставка = (програно в серії + ${stake} × (кф − 1)) ÷ (кф − 1). Мартингейл не робить ставки вигіднішими — він міняє часті дрібні виграші на рідкісну велику втрату. 18+.</p>`;
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
    if (!/^mg-(bank|stake|steps)$/.test(e.target.id)) return;
    const v = Number(e.target.value);
    if (e.target.id === 'mg-bank') state.mg.bank = Math.max(10, v || 500);
    else if (e.target.id === 'mg-stake') state.mg.stake = Math.max(1, Math.round(v) || 25);
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
