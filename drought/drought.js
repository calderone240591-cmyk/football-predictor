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
    const profit = all.reduce((s, b) => s + b.profit, 0);
    const wins = all.filter(b => b.s === 'win').length, losses = all.filter(b => b.s === 'loss').length;
    const pending = upcomingRecs(d).length;
    const head = `
      <div class="controls"><div class="chips">${PERIODS.map(([k, l]) => `<button class="chip ${state.period === k ? 'on' : ''}" data-period="${k}">${l}</button>`).join('')}</div></div>`;
    if (!recs.length) {
      $view.innerHTML = head + `<div class="empty">Статистика ведеться з нуля — з 20.10 20:30.<br>Зіграних рекомендацій ще немає, в очікуванні: ${pending}.<br>Результати з'являться після перших матчів.</div>`;
      return;
    }

    const byStreak = [[2, 2, '2 матчі'], [3, 3, '3 матчі'], [4, 4, '4 матчі'], [5, 99, '5+ матчів']]
      .map(([lo, hi, label]) => ({ label, list: all.filter(b => b.r.n >= lo && b.r.n <= hi) })).filter(x => x.list.length);
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

    $view.innerHTML = head + `
      <section class="card bank">
        <div class="bank-balance"><span>Баланс</span><b class="${profit >= 0 ? 'ok' : 'bad'}">${money(BANK + profit)}</b><small>стартовий банк ${money(BANK)} · 50 грн на кожну ставку</small></div>
        <div class="kpis kpis2">
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${uah(profit)}</b><span>прибуток</span></div>
          <div><b>${(profit / (all.length * STAKE) * 100).toFixed(1)}%</b><span>ROI<br>поставлено ${money(all.length * STAKE)}</span></div>
          <div><b>${wins} / ${losses}</b><span>виграно / програно<br>рекомендацій ${recs.length}</span></div>
        </div>
        ${balanceChart(all)}
        <p class="hint">На кожну рекомендацію — дві ставки по 50 грн: ІТБ 1 і ІТБ 1.5. Кф — справедливий за ймовірністю моделі; у букмекера він на 5–8% нижчий, тож реальний результат був би гіршим. Облік — з 20.10 20:30: лише нові рекомендації.</p>
      </section>
      <section class="card"><h3>За ставками</h3>
        <table class="markets dr-agg">${aggHead('Ставка')}<tbody>${aggRow('ІТБ 1', all.filter(b => b.key === 'it1'))}${aggRow('ІТБ 1.5', all.filter(b => b.key === 'it15'))}${aggRow('Разом', all)}</tbody></table>
        <p class="hint">В/П/Пр — виграно / повернення / програно. Команда забила хоча б один гол у ${pct(recs.filter(r => r.g > 0).length / recs.length)} матчів (${recs.filter(r => r.g > 0).length} з ${recs.length}).</p>
      </section>
      <section class="card"><h3>За довжиною серії</h3>
        <table class="markets dr-agg">${aggHead('Без голів')}<tbody>${byStreak.map(x => aggRow(x.label, x.list)).join('')}</tbody></table>
      </section>
      <section class="card"><h3>За турнірами</h3>
        <table class="markets dr-agg">${aggHead('Турнір')}<tbody>${[...leagues].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => aggRow(k, list)).join('')}</tbody></table>
      </section>
      <section class="card"><h3>Рекомендація = результат</h3>
        <table class="markets dr-res">
          <thead><tr><th>Матч</th><th>Рахунок</th><th>ІТБ 1</th><th>ІТБ 1.5</th><th>Грн</th></tr></thead>
          <tbody>${recs.slice().reverse().map(r => {
            const pl = profitOf(r.st1, r.it1.p) + profitOf(r.st15, r.it15.p);
            return `<tr>
              <td><b>${esc(r.team.short || r.team.name)}</b> ${r.side === 'home' ? 'vs' : '@'} ${esc(r.opp.short || r.opp.name)}<small>${dateOf(r.ev.ts)} · ${esc(leagueOf(r.slug).short)} · без голів ${r.n}</small></td>
              <td><b>${r.ev.home.score}:${r.ev.away.score}</b><small>забила ${r.g}</small></td>
              <td>${ICON[r.st1]}<small>${pct(r.it1.p)}</small></td>
              <td>${ICON[r.st15]}<small>${pct(r.it15.p)}</small></td>
              <td class="${pl > 0 ? 'ok' : pl < 0 ? 'bad' : ''}">${uah(pl)}</td>
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
    const b = e.target.closest('button');
    if (!b || !state.data) return;
    if (b.dataset.period) { state.period = b.dataset.period; route(true); }
    else if (b.dataset.allview) { state.allView = b.dataset.allview; route(true); }
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
