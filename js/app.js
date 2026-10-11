(() => {
  const { api, model, LEAGUES, LEAGUE_BY_SLUG } = FP;
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $back = document.getElementById('back');

  const state = {
    dayOffset: 0,
    league: 'all',
    day: [],                  // [{ slug, ev }] — матчі обраного дня
    dayErrors: 0,
    events: new Map(),         // "slug/id" → { slug, ev } — для екрана матчу
    models: new Map(),         // slug → { m, sig } | { error }
    loading: new Map(),        // slug → Promise
    standings: new Map(),      // slug → рядки таблиці
    lineups: new Map(),        // id матчу → склади
    teamStats: new Map(),      // id команди → сезонна статистика (xG, кутові, картки)
    facts: new Map(),          // id матчу → рахунок 1-го тайму, кутові, картки (для розрахунку ставок)
    updatedAt: 0,
    valueSel: loadValueSel(),  // id матчів, обраних для таблиці двійників (зберігається на телефоні)
  };

  function loadValueSel() {
    try { return new Set(JSON.parse(localStorage.getItem('fp_value_sel') || '[]')); } catch { return new Set(); }
  }
  function saveValueSel() {
    try { localStorage.setItem('fp_value_sel', JSON.stringify([...state.valueSel])); } catch {}
  }
  let renderId = 0;

  const MIN = 60 * 1000;
  const LINEUP_WINDOW = 75 * MIN;  // склади шукаємо за 75 хв до старту і під час матчу
  const TICK = 60 * 1000;          // перевірка оновлень; самі дані оновлюються за строком кешу (2 хв)

  // ---------- утиліти ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = p => Math.round(p * 100) + '%';
  const fair = p => (p > 0 ? (1 / p).toFixed(2) : '—');
  const pad = FP.pad;
  const evKey = (slug, id) => `${slug}/${id}`;

  function dayLabel(offset) {
    if (offset === 0) return 'Сьогодні';
    if (offset === 1) return 'Завтра';
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const wd = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][d.getDay()];
    return `${wd}, ${d.getDate()}.${pad(d.getMonth() + 1)}`;
  }

  const timeOf = ts => {
    const d = new Date(ts * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const dateOf = ts => {
    const d = new Date(ts * 1000);
    return `${['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][d.getDay()]}, ${d.getDate()}.${pad(d.getMonth() + 1)}`;
  };

  const isLive = ev =>ev.state === 'in';
  const isUpcoming = ev => ev.state === 'pre' && !/POSTPONED|CANCELED|ABANDONED/.test(ev.status);
  const isFinished = ev => model.isResult(ev);

  function statusText(ev) {
    if (/POSTPONED/.test(ev.status)) return 'Перенесено';
    if (/CANCELED/.test(ev.status)) return 'Скасовано';
    if (/ABANDONED/.test(ev.status)) return 'Перервано';
    if (ev.state === 'pre') return timeOf(ev.ts);
    if (ev.state === 'in') return /HALFTIME/.test(ev.status) ? 'Перерва' : `LIVE ${ev.clock || ''}`;
    return 'Завершено';
  }

  const nearKickoff = ev => (isUpcoming(ev) && ev.ts * 1000 - Date.now() <= LINEUP_WINDOW) || isLive(ev);

  // ---------- дані ----------
  async function loadDay(offset, force) {
    const date = FP.localDate(offset);
    const months = api.monthsAround([date]);
    let errors = 0;
    const parts = await api.pool(LEAGUES, 6, async l => {
      try {
        const res = await Promise.all(months.map(m => api.month(l.slug, m, force)));
        return res.flatMap(r => r.events).map(ev => ({ slug: l.slug, ev }));
      } catch {
        errors++;
        return [];
      }
    });
    const seen = new Set();
    const items = parts.flat().filter(x => {
      const k = evKey(x.slug, x.ev.id);
      if (seen.has(k) || FP.dateOfTs(x.ev.ts) !== date) return false;
      seen.add(k);
      return true;
    });
    items.forEach(x => state.events.set(evKey(x.slug, x.ev.id), x));
    return { items, errors };
  }

  function ensureModel(slug) {
    if (state.loading.has(slug)) return state.loading.get(slug);
    const p = buildModel(slug).finally(() => state.loading.delete(slug));
    state.loading.set(slug, p);
    return p;
  }

  async function buildModel(slug) {
    const league = LEAGUE_BY_SLUG.get(slug);
    try {
      let domestic = null, domSig = '';
      if (league.cup) {
        // Для єврокубків потрібні рейтинги команд у їхніх чемпіонатах.
        const doms = LEAGUES.filter(l => !l.cup);
        const entries = await api.pool(doms, 3, l => ensureModel(l.slug));
        domestic = new Map();
        entries.forEach((e, i) => {
          if (!e || e.error) return;
          domSig += e.sig;
          const season = e.season && e.season.year;
          for (const t of e.m.teams.values()) domestic.set(t.id, { att: t.att, def: t.def, q: doms[i].q, slug: doms[i].slug, season });
        });
      }
      const season = await api.season(slug, false, !league.cup);
      season.events.forEach(ev => state.events.set(evKey(slug, ev.id), { slug, ev }));
      const results = season.events.filter(model.isResult).length;
      const sig = `${slug}:${results}:${season.previous.length}:${domSig.length}`;
      const have = state.models.get(slug);
      if (have && !have.error && have.sig === sig) return have;
      if (!results && !league.cup) {
        const entry = { error: 'У цьому сезоні ще немає зіграних матчів.', sig };
        state.models.set(slug, entry);
        return entry;
      }
      const entry = { m: model.build(league, season.events, domestic, season.previous), sig, season: season.info };
      state.models.set(slug, entry);
      return entry;
    } catch (e) {
      const entry = { error: e.message, sig: '' };
      state.models.set(slug, entry);
      return entry;
    }
  }

  async function loadLineups(items) {
    const near = items.filter(x => nearKickoff(x.ev));
    await api.pool(near, 3, async x => {
      try { state.lineups.set(x.ev.id, await api.lineups(x.slug, x.ev.id)); } catch {}
    });
  }

  // Звідки брати сезонну статистику команди: для єврокубків — з її чемпіонату (там більше матчів).
  function statsSource(slug, teamId) {
    const entry = state.models.get(slug);
    if (!entry || entry.error) return null;
    if (!entry.m.league.cup) return entry.season ? { slug, season: entry.season.year } : null;
    const t = entry.m.teams.get(teamId);
    return t && t.domestic && t.domestic.season ? { slug: t.domestic.slug, season: t.domestic.season } : null;
  }

  async function loadTeamStats(list) {
    const jobs = [];
    for (const { slug, ev } of list) {
      for (const side of [ev.home, ev.away]) {
        if (state.teamStats.has(side.id)) continue;
        const src = statsSource(slug, side.id);
        if (src) jobs.push({ id: side.id, ...src });
      }
    }
    const uniq = [...new Map(jobs.map(j => [j.id, j])).values()];
    await api.pool(uniq, 4, async j => {
      try { state.teamStats.set(j.id, await api.teamSeasonStats(j.slug, j.season, j.id)); } catch {}
    });
  }

  const ctxFor = ev => ({ home: state.teamStats.get(ev.home.id) || null, away: state.teamStats.get(ev.away.id) || null });

  // Повертає: undefined — ще вантажиться; null — немає даних; об'єкт — прогноз.
  function predictionFor(slug, ev) {
    const entry = state.models.get(slug);
    if (!entry) return undefined;
    if (entry.error) return null;
    const pred = model.predict(entry.m, ev, ctxFor(ev));
    if (pred && isUpcoming(ev)) FP.history.record(slug, ev, pred);
    return pred;
  }

  const confClass = c => ['', 'lo', 'mid', 'hi'][c.level];

  function setHeader(title, back) {
    $title.textContent = title;
    $back.hidden = !back;
    document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === currentTab()));
  }

  function currentTab() {
    const h = location.hash;
    if (h.startsWith('#/league')) return 'leagues';
    if (h.startsWith('#/settings') || h.startsWith('#/info')) return 'info';
    if (h.startsWith('#/history')) return 'history';
    return 'home';
  }

  const errorBox = msg => `<div class="notice error">${esc(msg)}</div>`;

  // ---------- Прогнози ----------
  async function viewHome() {
    const rid = ++renderId;
    setHeader('Прогнози');
    $view.innerHTML = `
      <div class="controls">
        <div class="segmented">${[0, 1, 2].map(o =>
          `<button class="${o === state.dayOffset ? 'on' : ''}" data-day="${o}">${dayLabel(o)}</button>`).join('')}
        </div>
        <div class="chips">
          <button class="chip ${state.league === 'all' ? 'on' : ''}" data-league="all">Усі</button>
          ${LEAGUES.map(l => `<button class="chip ${state.league === l.slug ? 'on' : ''}" data-league="${l.slug}">
            <img src="${FP.leagueLogo(l)}" alt="" loading="lazy">${esc(l.short)}</button>`).join('')}
        </div>
      </div>
      <div id="status-line" class="status-line"></div>
      <div id="list"><div class="loading">Завантаження матчів…</div></div>`;
    await loadHome(rid, false, false);
  }

  // silent — фонове автооновлення: без індикатора і без помилок на весь екран.
  async function loadHome(rid, force, silent) {
    await FP.history.ready;   // щоб для матчів, що почались, одразу показати зафіксований прогноз
    const { items, errors } = await loadDay(state.dayOffset, force);
    if (rid !== renderId) return;
    if (!items.length && errors === LEAGUES.length) {
      if (!silent) document.getElementById('list').innerHTML = errorBox('Не вдалося завантажити матчі. Перевірте інтернет і натисніть ⟳.');
      return;
    }
    state.day = items;
    state.dayErrors = errors;
    renderList();

    const slugs = [...new Set(items.map(x => x.slug))]
      .sort((a, b) => LEAGUE_BY_SLUG.get(a).order - LEAGUE_BY_SLUG.get(b).order);
    // Спершу чемпіонати, потім єврокубки (їм потрібні рейтинги чемпіонатів).
    for (const slug of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) {
      await ensureModel(slug);
      if (rid !== renderId) return;
      renderList();
    }
    await loadTeamStats(items.filter(x => !isFinished(x.ev)));
    if (rid !== renderId) return;
    renderList();
    await loadLineups(items);
    if (rid !== renderId) return;
    state.updatedAt = Date.now();
    renderList();
    renderStatus();
    recordUpcoming();
  }

  // Фоновий запис прогнозів на 3 дні вперед (раз на 20 хв), щоб статистика охоплювала всі матчі,
  // а не лише ті, що ви відкривали. Прогноз записується до старту і оновлюється до останнього.
  let recordingAt = 0;
  async function recordUpcoming() {
    if (Date.now() - recordingAt < 20 * MIN) return;
    recordingAt = Date.now();
    try {
      const days = await Promise.all([0, 1, 2].map(o => loadDay(o, false)));
      const items = days.flatMap(d => d.items).filter(x => isUpcoming(x.ev));
      const slugs = [...new Set(items.map(x => x.slug))];
      for (const slug of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) {
        await ensureModel(slug);
      }
      await loadTeamStats(items);
      items.forEach(x => predictionFor(x.slug, x.ev));   // predictionFor сам записує прогноз
    } catch {}
  }

  function renderStatus() {
    const $s = document.getElementById('status-line');
    if (!$s) return;
    const parts = [];
    if (state.updatedAt) parts.push(`Оновлено о ${timeOf(state.updatedAt / 1000)}, автооновлення кожні 2 хв`);
    if (state.dayErrors) parts.push(`не вдалося завантажити турнірів: ${state.dayErrors}`);
    $s.textContent = parts.join(' · ');
  }

  function renderList() {
    const $list = document.getElementById('list');
    if (!$list) return;
    // Матчі, що почались до старту обліку статистики, не показуємо — вони в статистику не йдуть.
    const items = state.day
      .filter(x => x.ev.ts >= FP.STATS_FROM)
      .filter(x => state.league === 'all' || x.slug === state.league)
      .map(x => ({ ...x, pred: predictionFor(x.slug, x.ev) }));

    if (!items.length) {
      $list.innerHTML = `<div class="empty">На цей день матчів ${state.league === 'all' ? 'у вибраних турнірах' : 'в цьому турнірі'} немає.<br>Спробуйте інший день.</div>`;
      return;
    }

    // Один список за часом початку; турнір видно на кожній картці. Цінні ставки дня — вгорі.
    items.sort((a, b) => a.ev.ts - b.ev.ts);
    $list.innerHTML = summary(items) + valueCard(items) + doublesCard(items)
      + `<div class="group">${items.map(x => matchCard(x, true)).join('')}</div>`;
  }

  // Перевірка моделі на вже зіграних сьогодні матчах.
  // Прогноз, який показуємо на картці. Поки матч не почався — поточний (він оновлюється разом
  // із коефіцієнтами й складами). Коли почався — зафіксований до старту, той самий, що в статистиці,
  // щоб рекомендація не «перестрибувала» під час гри.
  function shownPrediction(ev, pred) {
    const started = !isUpcoming(ev) || ev.ts * 1000 <= Date.now();
    const e = started ? FP.history.get(ev.id) : null;
    if (e) {
      return {
        frozen: true,
        tip: { key: e.tip.key, short: e.tip.short, long: e.tip.short, p: e.tip.p, conf: { level: e.tip.level } },
        prob: e.probs ? { '1': e.probs.p1, X: e.probs.px, '2': e.probs.p2 } : pred && pred.prob,
        value: e.value,
      };
    }
    return pred ? { frozen: false, tip: pred.tip, prob: pred.prob, value: pred.value } : pred;
  }

  function summary(items) {
    const done = items.filter(x => isFinished(x.ev)).map(x => shownPrediction(x.ev, x.pred) && { ...x, sp: shownPrediction(x.ev, x.pred) }).filter(Boolean);
    if (!done.length) return '';
    const hits = done.filter(x => model.settle(x.sp.tip.key, x.ev.home.score, x.ev.away.score) === true).length;
    return `<div class="summary">Влучність основних прогнозів у завершених матчах: <b>${hits} з ${done.length}</b></div>`;
  }

  // Усі цінні ставки ігрового дня повністю, за часом: майбутні — з часом початку, ті, що йдуть, — LIVE,
  // завершені — з рахунком і ✓/✗. Для матчів, що почались, — ставка, зафіксована до старту (як у статистиці).
  function valueCard(items) {
    const saved = new Map(FP.history.all().map(e => [e.id, e]));
    const values = items.map(x => {
      if (isUpcoming(x.ev)) return x.pred && x.pred.value ? { ...x, v: x.pred.value } : null;
      const e = saved.get(x.ev.id);
      return e && e.value ? { ...x, v: { ...e.value, edge: e.value.p * e.value.odds - 1 } } : null;
    }).filter(Boolean).sort((a, b) => a.ev.ts - b.ev.ts);
    if (!values.length) return '';
    const canPick = x => isUpcoming(x.ev) && x.ev.ts * 1000 > Date.now();
    const pickable = values.filter(canPick);
    state.valuePickable = pickable.map(x => x.ev.id);
    const status = x => {
      if (isLive(x.ev)) return '<span class="live">LIVE</span>';
      if (isFinished(x.ev)) {
        const r = model.settle(x.v.key, x.ev.home.score, x.ev.away.score);
        return `${x.ev.home.score}:${x.ev.away.score} ${r === true ? '<i class="ok">✓</i>' : r === false ? '<i class="bad">✗</i>' : '↺'}`;
      }
      return esc(timeOf(x.ev.ts));
    };
    return `
      <section class="card acca">
        <div class="acca-head"><b>Цінні ставки дня · ${values.length} ${help('value')}</b><span>ймовірність вища, ніж закладено в коефіцієнт</span></div>
        ${values.map(x => {
          const on = state.valueSel.has(x.ev.id);
          return `<div class="acca-row vrow ${on ? 'sel' : ''}">
            <a href="#/match/${x.slug}/${x.ev.id}">
              <span><small>${status(x)}</small> ${esc(x.ev.home.short || x.ev.home.name)} — ${esc(x.ev.away.short || x.ev.away.name)}</span>
              <b>${esc(x.v.short)} @ ${x.v.odds.toFixed(2)} · +${(x.v.edge * 100).toFixed(0)}%</b>
            </a>
            ${canPick(x) ? `<button class="add ${on ? 'on' : ''}" data-vsel="${esc(x.ev.id)}" aria-label="Обрати для двійників">${on ? '✓' : '+'}</button>` : '<span class="add-stub"></span>'}
          </div>`;
        }).join('')}
        ${pickable.length >= 2 ? `<div class="vsel-bar">
          <span>Обрано для двійників: <b>${pickable.filter(x => state.valueSel.has(x.ev.id)).length}</b> з ${pickable.length}</span>
          <button class="btn ghost small-btn" data-vsel-all="1">Обрати всі</button>
          <button class="btn ghost small-btn" data-vsel-none="1">Очистити</button>
        </div>` : ''}
      </section>`;
  }


  // Двійники з обраних цінних ставок: кожна з кожною — n × (n − 1) / 2 пар. Лише матчі, що ще не почались.
  // Кф пари — добуток кф DraftKings, ймовірність — добуток ймовірностей (матчі незалежні).
  function doublesCard(items) {
    const all = items.filter(x => isUpcoming(x.ev) && x.ev.ts * 1000 > Date.now() && x.pred && x.pred.value);
    if (all.length < 2) return '';
    const vs = all.filter(x => state.valueSel.has(x.ev.id)).map(x => ({ ...x, v: x.pred.value }));
    const n = vs.length;
    if (n < 2) {
      return `<section class="card"><h3>Двійники з цінних ставок</h3>
        <p class="hint top">Оберіть щонайменше 2 цінні ставки кнопкою <b>+</b> у картці вище — тут з'явиться таблиця всіх двійників з обраних і їх кількість (n × (n − 1) / 2). ${n === 1 ? 'Зараз обрано 1.' : ''}</p></section>`;
    }
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = vs[i], b = vs[j];
      const odds = a.v.odds * b.v.odds, p = a.v.p * b.v.p;
      pairs.push({ a, b, odds, p, edge: p * odds - 1 });
    }
    pairs.sort((x, y) => y.edge - x.edge);
    const name = x => `${esc(x.ev.home.short || x.ev.home.name)} — ${esc(x.ev.away.short || x.ev.away.name)}`;
    return scenarioCard(vs, pairs.length) + `
      <section class="card">
        <h3>Двійники з обраних · ${pairs.length}</h3>
        <p class="hint top">Обрано ${n} цінних ставок → ${n} × ${n - 1} / 2 = <b>${pairs.length}</b> пар. Відсортовано за перевагою. Кф — добуток кф DraftKings, ймовірність — шанс, що зіграють обидві.</p>
        <table class="markets doubles">
          <thead><tr><th>#</th><th>Пара</th><th>Кф</th><th>Ймов.</th><th>Перев.</th></tr></thead>
          <tbody>${pairs.map((d, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><a href="#/match/${d.a.slug}/${d.a.ev.id}">${name(d.a)}</a> <b>${esc(d.a.v.short)}</b><br>
                  <a href="#/match/${d.b.slug}/${d.b.ev.id}">${name(d.b)}</a> <b>${esc(d.b.v.short)}</b></td>
              <td><b>${d.odds.toFixed(2)}</b></td>
              <td>${pct(d.p)}</td>
              <td class="ok">+${(d.edge * 100).toFixed(0)}%</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </section>`;
  }

  // Сценарії для двійників з обраних: на кожну пару — 50 грн. Якщо зіграло k з n матчів,
  // заходить k × (k − 1) / 2 пар. Повернення залежить від того, ЯКІ саме матчі зіграли, тому
  // показуємо середнє (усі варіанти однаково ймовірні) і діапазон: гірший випадок — зіграли k матчів
  // з найменшими кф, кращий — з найбільшими. Ймовірність k — за нашими ймовірностями (матчі незалежні).
  const DOUBLE_STAKE = 50;
  function scenarioCard(vs, pairCount) {
    const n = vs.length;
    const odds = vs.map(x => x.v.odds).sort((a, b) => a - b);
    // Сума добутків кф усіх пар зі списку: ((Σo)² − Σo²) / 2.
    const pairSum = list => {
      const s = list.reduce((t, o) => t + o, 0), q = list.reduce((t, o) => t + o * o, 0);
      return (s * s - q) / 2;
    };
    const total = pairSum(odds);
    // Ймовірність, що зіграє рівно k матчів (біноміальний розподіл з різними ймовірностями).
    let dist = [1];
    for (const x of vs) {
      const p = x.v.p, next = new Array(dist.length + 1).fill(0);
      dist.forEach((v, k) => { next[k] += v * (1 - p); next[k + 1] += v * p; });
      dist = next;
    }
    const stake = pairCount * DOUBLE_STAKE;
    const rows = [];
    for (let k = 0; k <= n; k++) {
      const wins = k * (k - 1) / 2;
      const avgRet = n > 1 ? total * (k * (k - 1)) / (n * (n - 1)) * DOUBLE_STAKE : 0;
      const worst = pairSum(odds.slice(0, k)) * DOUBLE_STAKE, best = pairSum(odds.slice(n - k)) * DOUBLE_STAKE;
      rows.push({ k, wins, avg: avgRet - stake, worst: worst - stake, best: best - stake, prob: dist[k] });
    }
    const even = rows.find(r => r.avg >= 0);
    const evenWorst = rows.find(r => r.worst >= 0);
    const expected = rows.reduce((s, r) => s + r.prob * r.avg, 0);
    const pPlus = rows.filter(r => r.avg >= 0).reduce((s, r) => s + r.prob, 0);
    const signed = v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('uk-UA')}`;
    return `
      <section class="card">
        <h3>Скільки має зіграти · ставка ${DOUBLE_STAKE} грн на кожен двійник</h3>
        <div class="kpis">
          <div><b>${money(stake)}</b><span>поставлено<br>${pairCount} × ${DOUBLE_STAKE} грн</span></div>
          <div><b>${even ? `${even.k} з ${n}` : '—'}</b><span>вихід у плюс<br>у середньому${evenWorst ? `, гарантовано з ${evenWorst.k}` : ''}</span></div>
          <div><b class="${expected >= 0 ? 'ok' : 'bad'}">${signed(expected)} грн</b><span>очікуваний результат<br>шанс на плюс ${pct(pPlus)}</span></div>
        </div>
        <table class="markets scen">
          <thead><tr><th>Зіграло</th><th>Двійн.</th><th>Прибуток, грн<br><small>середній · діапазон</small></th><th>ROI</th><th>Шанс</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr class="${r.avg >= 0 ? 'plus' : 'minus'} ${even && r.k === even.k ? 'even' : ''}">
              <td><b>${r.k}</b> з ${n}</td>
              <td>${r.wins} з ${pairCount}</td>
              <td><b class="${r.avg >= 0 ? 'ok' : 'bad'}">${signed(r.avg)}</b><br><small>${r.k >= 2 && r.k < n ? `${signed(r.worst)} … ${signed(r.best)}` : ''}</small></td>
              <td class="${r.avg >= 0 ? 'ok' : 'bad'}">${(r.avg / stake * 100).toFixed(0)}%</td>
              <td>${r.prob >= 0.005 ? pct(r.prob) : '<1%'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="hint">Прибуток залежить від того, які саме матчі зіграють: «діапазон» — від гіршого випадку (зіграли ставки з найменшими кф) до кращого (з найбільшими). «Шанс» — наскільки ймовірно, що зіграє саме стільки матчів, за прогнозом додатка. Кф — DraftKings; у вашого букмекера можуть бути інші.</p>
      </section>`;
  }

  function matchCard({ slug, ev, pred }, showLeague) {
    const showScore = ev.state !== 'pre';
    const sp = shownPrediction(ev, pred);
    let predHtml;
    if (sp === undefined) predHtml = '<div class="pred-loading">аналіз…</div>';
    else if (!sp || !sp.prob) predHtml = '<div class="pred-loading">недостатньо даних</div>';
    else {
      const p = sp.prob;
      const r = isFinished(ev) ? model.settle(sp.tip.key, ev.home.score, ev.away.score) : undefined;
      const verdict = r === true ? '<i class="ok">✓</i>' : r === false ? '<i class="bad">✗</i>' : r === null ? '↺ ' : '';
      predHtml = `
        <div class="bar" aria-label="Ймовірності: П1 ${pct(p['1'])}, нічия ${pct(p.X)}, П2 ${pct(p['2'])}">
          <span class="b1" style="flex:${p['1']}">${pct(p['1'])}</span>
          <span class="bx" style="flex:${p.X}">${pct(p.X)}</span>
          <span class="b2" style="flex:${p['2']}">${pct(p['2'])}</span>
        </div>
        <div class="tip ${confClass(sp.tip.conf)}">${verdict}${esc(sp.tip.short)} · ${pct(sp.tip.p)}</div>`;
    }
    const l = LEAGUE_BY_SLUG.get(slug);
    const badges = isFinished(ev) ? '' : [
      (state.lineups.get(ev.id) || []).length ? '<span class="badge ok-b">склади</span>' : '',
      sp && sp.value ? '<span class="badge val-b">цінність</span>' : '',
    ].join('');
    return `
      <a class="match" href="#/match/${slug}/${ev.id}">
        <div class="m-meta">
          <span class="${isLive(ev) ? 'live' : ''}">${esc(statusText(ev))}${badges}</span>
          ${showLeague ? `<span class="m-league"><img src="${FP.leagueLogo(l)}" alt="">${esc(l.short)}</span>` : ''}
        </div>
        <div class="m-teams">
          <div class="team"><img src="${esc(ev.home.logo)}" alt="" loading="lazy"><span>${esc(ev.home.name)}</span><b>${showScore ? ev.home.score ?? '' : ''}</b></div>
          <div class="team"><img src="${esc(ev.away.logo)}" alt="" loading="lazy"><span>${esc(ev.away.name)}</span><b>${showScore ? ev.away.score ?? '' : ''}</b></div>
        </div>
        <div class="m-pred">${predHtml}</div>
      </a>`;
  }

  // ---------- Матч ----------
  let matchSignature = '';

  async function viewMatch(slug, id, silent = false) {
    const rid = silent ? renderId : ++renderId;
    const league = LEAGUE_BY_SLUG.get(slug);
    if (!silent) setHeader('Аналіз матчу', true);
    if (!league) { $view.innerHTML = errorBox('Турнір не знайдено.'); return; }
    if (!silent) $view.innerHTML = '<div class="loading">Аналіз команд…</div>';

    const entry = await ensureModel(slug);   // заодно оновлює матчі сезону (рахунок, статус)
    if (rid !== renderId) return;
    const x = state.events.get(evKey(slug, id));
    if (!x) { $view.innerHTML = `<div class="empty">Матч не знайдено. <a href="#/">До списку прогнозів</a></div>`; return; }
    if (entry.error) { if (!silent) $view.innerHTML = errorBox(entry.error); return; }

    const ev = x.ev;
    await Promise.all([
      api.lineups(slug, id).then(l => state.lineups.set(id, l)).catch(() => {}),
      loadTeamStats([{ slug, ev }]),
    ]);
    if (rid !== renderId) return;
    const pred = predictionFor(slug, ev);
    if (!pred) { $view.innerHTML = errorBox('Для цих команд ще немає даних.'); return; }

    const lineups = state.lineups.get(id) || [];
    const sig = JSON.stringify([id, ev.state, ev.clock, ev.home.score, ev.away.score, pred.lh, pred.la, lineups.length]);
    if (silent && sig === matchSignature) return;
    matchSignature = sig;
    if (!state.standings.has(slug)) {
      try { state.standings.set(slug, await api.standings(slug)); } catch {}
      if (rid !== renderId) return;
    }
    renderMatch(slug, ev, pred, lineups);
  }

  function renderMatch(slug, ev, pred, lineups) {
    state.currentMatch = { slug, ev, pred };
    const l = LEAGUE_BY_SLUG.get(slug);
    const p = pred.prob;
    const showScore = ev.state !== 'pre';
    // Матч почався (або перенесений/скасований) — рекомендації вже не показуємо.
    const started = !isUpcoming(ev) || ev.ts * 1000 <= Date.now();

    $view.innerHTML = `
      <section class="card hero">
        <div class="hero-meta"><img src="${FP.leagueLogo(l)}" alt="">${esc(l.name)}${ev.round ? ' · ' + esc(ev.round) : ''}</div>
        <div class="hero-teams">
          <div><img src="${esc(ev.home.logo)}" alt=""><b>${esc(ev.home.name)}</b></div>
          <div class="hero-score">${showScore ? `${ev.home.score ?? 0} : ${ev.away.score ?? 0}` : esc(timeOf(ev.ts))}<small>${esc(ev.state === 'pre' && isUpcoming(ev) ? dateOf(ev.ts) : statusText(ev))}</small></div>
          <div><img src="${esc(ev.away.logo)}" alt=""><b>${esc(ev.away.name)}</b></div>
        </div>
        <div class="xg">Очікувані голи${started ? ' (до матчу)' : ''}: <b>${pred.lh.toFixed(2)}</b> : <b>${pred.la.toFixed(2)}</b> ${help('expgoals')}</div>
        <div class="bar big">
          <span class="b1" style="flex:${p['1']}">${pct(p['1'])}</span>
          <span class="bx" style="flex:${p.X}">${pct(p.X)}</span>
          <span class="b2" style="flex:${p['2']}">${pct(p['2'])}</span>
        </div>
        <div class="bar-legend"><span>П1 · кф ${fair(p['1'])}</span><span>Х · ${fair(p.X)}</span><span>П2 · ${fair(p['2'])}</span></div>
      </section>

      ${started ? startedCard(ev, pred) : `
      <section class="card tipcard ${confClass(pred.tip.conf)}">
        <div class="tip-label">Рекомендована ставка ${help('tip')}</div>
        <div class="tip-main">${esc(pred.tip.long)}</div>
        <div class="tip-stats">
          <span>Ймовірність <b>${pct(pred.tip.p)}</b></span>
          <span>Справедливий кф <b>${fair(pred.tip.p)}</b> ${help('fair')}</span>
          ${pred.tip.odds ? `<span>Кф букмекера <b>${pred.tip.odds.toFixed(2)}</b></span>` : ''}
          <span>Впевненість <b>${pred.tip.conf.label}</b> ${help('conf')}</span>
        </div>
        ${pred.alternatives.length ? `<div class="alts">Також варто розглянути: ${pred.alternatives.map(x => `<span>${esc(x.short)} ${pct(x.p)}</span>`).join('')}</div>` : ''}
        ${pred.value ? `<div class="value-pick">Цінна ставка ${help('value')}: <b>${esc(pred.value.long)}</b> за кф ${pred.value.odds.toFixed(2)}, перевага +${(pred.value.edge * 100).toFixed(1)}%</div>` : ''}
        <a class="gloss-link" href="#/info/markets">Що означають ТБ, ІТ, Ф1 та інші позначення →</a>
      </section>`}

      ${started ? '' : `
      <section class="card">
        <h3>Найкращі ставки на матч за ринками</h3>
        <div class="picks">${pred.groups.filter(g => g.pick).map(g => `
          <div class="pick"><span>${esc(g.name)}</span><b>${esc(g.pick.short)}</b><i>${pct(g.pick.p)} · кф ${fair(g.pick.p)}</i></div>`).join('')}
        </div>
        <p class="hint">Найімовірніший варіант у кожній групі ринків з кф від 1.5 до 3 (ймовірність 33–67%). Кф — справедливий, у букмекера на 5–8% нижчий. Кутові й картки — оцінка за сезонною статистикою команд.</p>
      </section>`}

      <section class="card">
        <h3>Опис матчу</h3>
        <ul class="reasons">${pred.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        ${compare(slug, ev, pred.home, pred.away)}
        <p class="hint">Індекси з урахуванням сили суперників: 1.00 — середній рівень турніру. Атака вище за 1 — краще за середнє, оборона нижче за 1 — краще за середнє.${LEAGUE_BY_SLUG.get(slug).cup ? ' Статистика за гру — з матчів у своєму чемпіонаті.' : ''}</p>
      </section>

      ${squads(ev, lineups)}`;
  }

  // Матч почався: передматчеві рекомендації вже неактуальні (вони записані в статистику до старту).
  // Після матчу показуємо, чи зіграла рекомендація.
  function startedCard(ev, pred) {
    const sp = shownPrediction(ev, pred);
    const tip = sp.tip;
    if (isFinished(ev)) {
      const r = model.settle(tip.key, ev.home.score, ev.away.score);
      return `
        <section class="card tipcard ${r ? 'hi' : 'lo'}">
          <div class="tip-label">Рекомендація до матчу</div>
          <div class="tip-main">${esc(tip.long)} ${r === true ? '<i class="ok">✓ зіграла</i>' : r === false ? '<i class="bad">✗ не зіграла</i>' : '↺'}</div>
          <p class="hint">Ймовірність до матчу ${pct(tip.p)}. ${sp.frozen ? 'Результат враховано у вкладці «Статистика».' : 'Цей матч почався до старту обліку, тож у статистику не входить.'}</p>
        </section>`;
    }
    return `
      <section class="card notice-card">
        <div class="tip-label">Матч іде</div>
        ${sp.frozen ? `<p>Рекомендація, зафіксована до старту: <b>${esc(tip.short)}</b> (${pct(tip.p)}).</p>` : ''}
        <p>Передматчеві рекомендації вже неактуальні: вони були зафіксовані до початку матчу і враховуються у статистиці.</p>
      </section>`;
  }

  function squads(ev, lineups) {
    const side = team => {
      const ln = lineups.find(x => x.team === team.id);
      if (!ln) return '';
      return `<div class="squad"><h4><img src="${esc(team.logo)}" alt="">${esc(team.short || team.name)}</h4>
        <div class="xi-head">${ln.formation ? esc(ln.formation) : 'Стартовий склад'}</div>
        <ol class="xi">${ln.xi.map(p => `<li><span>${esc(p.number ?? '')}</span>${esc(p.name)}</li>`).join('')}</ol></div>`;
    };
    if (lineups.length) {
      return `<section class="card"><h3>Стартові склади</h3>
        <p class="hint top">Склади вже враховані в коефіцієнтах букмекера, тож через ринкову частину вони впливають і на прогноз.</p>
        <div class="squads">${side(ev.home)}${side(ev.away)}</div></section>`;
    }
    if (isFinished(ev)) return '';
    const note = nearKickoff(ev)
      ? 'Склади ще не опубліковано. Додаток перевіряє їх кожні 5 хвилин.'
      : 'Склади з\'являться приблизно за годину до початку. Відкрийте матч ближче до старту.';
    return `<section class="card"><h3>Стартові склади</h3><p class="hint top">${note}</p></section>`;
  }

  function formChips(letters) {
    return `<span class="form">${[...(letters || '')].map(c => `<i class="f${c}">${{ W: 'В', D: 'Н', L: 'П' }[c]}</i>`).join('')}</span>`;
  }

  function compare(slug, ev, H, A) {
    const rows = state.standings.get(slug) || [];
    const row = id => rows.find(r => r.team.id === id);
    const rh = row(ev.home.id), ra = row(ev.away.id);
    const h = H.stats, a = A.stats;
    const lines = [
      rh && ra ? ['Місце', rh.rank, ra.rank] : null,
      rh && ra ? ['Очки (ігор)', `${rh.pts} (${rh.p})`, `${ra.pts} (${ra.p})`] : null,
      ['Голи за / проти', `${h.gf}:${h.ga}`, `${a.gf}:${a.ga}`],
      ['Форма', formChips(h.form) || '—', formChips(a.form) || '—', true],
      ['Індекс атаки', H.att.toFixed(2), A.att.toFixed(2)],
      ['Індекс оборони', H.def.toFixed(2), A.def.toFixed(2)],
    ];
    const hs = state.teamStats.get(ev.home.id), as = state.teamStats.get(ev.away.id);
    const pg = (s, k) => (s && s.app ? (s[k] / s.app).toFixed(1) : '—');
    if (hs || as) {
      if (hs && as && hs.xgf != null && as.xgf != null) {
        lines.push(['xG створює за гру', hs.xgf.toFixed(2), as.xgf.toFixed(2)]);
        lines.push(['xG дозволяє за гру', hs.xga.toFixed(2), as.xga.toFixed(2)]);
      }
      lines.push(['Удари в площину', pg(hs, 'shotsOnTarget'), pg(as, 'shotsOnTarget')]);
      lines.push(['Кутові подає', pg(hs, 'cornersFor'), pg(as, 'cornersFor')]);
      lines.push(['Кутові дозволяє', pg(hs, 'cornersAgainst'), pg(as, 'cornersAgainst')]);
      lines.push(['Жовті картки', pg(hs, 'yellow'), pg(as, 'yellow')]);
      lines.push(['Фоли', pg(hs, 'fouls'), pg(as, 'fouls')]);
      if (hs && as && hs.possession && as.possession) lines.push(['Володіння', `${Math.round(hs.possession)}%`, `${Math.round(as.possession)}%`]);
    }
    return `
      <table class="compare">
        <thead><tr><th>${esc(ev.home.short || ev.home.name)}</th><th></th><th>${esc(ev.away.short || ev.away.name)}</th></tr></thead>
        <tbody>${lines.filter(Boolean).map(([label, x, y, raw]) =>
          `<tr><td>${raw ? x : esc(x)}</td><th>${esc(label)}</th><td>${raw ? y : esc(y)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ---------- Турніри ----------
  function viewLeagues() {
    ++renderId;
    setHeader('Турніри');
    const item = l => `
      <a class="league-item" href="#/league/${l.slug}">
        <img src="${FP.leagueLogo(l)}" alt="" loading="lazy">
        <span><b>${esc(l.name)}</b><small>${esc(l.country)}</small></span>
        <i>›</i>
      </a>`;
    $view.innerHTML = `
      <h2 class="section-title">Єврокубки</h2>
      <div class="league-list">${LEAGUES.filter(l => l.cup).map(item).join('')}</div>
      <h2 class="section-title">Чемпіонати</h2>
      <div class="league-list">${LEAGUES.filter(l => !l.cup).map(item).join('')}</div>`;
  }

  async function viewLeague(slug) {
    const rid = ++renderId;
    const l = LEAGUE_BY_SLUG.get(slug);
    if (!l) return viewLeagues();
    setHeader(l.name, true);
    $view.innerHTML = '<div class="loading">Завантаження таблиці…</div>';

    const [entry, rows] = await Promise.all([
      ensureModel(slug),
      api.standings(slug).catch(() => []),
    ]);
    if (rid !== renderId) return;
    state.standings.set(slug, rows);
    if (entry.error && !rows.length) { $view.innerHTML = errorBox(entry.error); return; }

    const m = entry.m;
    const cls = (v, goodHigh) => (goodHigh ? v >= 1.15 : v <= 0.85) ? 'good' : (goodHigh ? v <= 0.85 : v >= 1.15) ? 'poor' : '';
    const groups = new Map();
    rows.forEach(r => { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); });

    $view.innerHTML = `
      ${m ? `<section class="card">
        <div class="league-stats">
          <div><b>${m.avgH.toFixed(2)}</b><span>голи господарів за матч</span></div>
          <div><b>${m.avgA.toFixed(2)}</b><span>голи гостей за матч</span></div>
          <div><b>${m.results}</b><span>зіграно матчів</span></div>
        </div>
      </section>` : ''}
      ${[...groups].map(([name, list]) => `
      <section class="card flush">
        ${groups.size > 1 ? `<div class="table-title">${esc(name)}</div>` : ''}
        <div class="table-wrap">
          <table class="standings">
            <thead><tr><th>#</th><th class="tl">Команда</th><th>І</th><th>РМ</th><th>О</th><th>Атк</th><th>Обр</th><th class="tl">Форма</th></tr></thead>
            <tbody>${list.map(r => {
              const t = m && m.teams.get(r.team.id);
              return `<tr>
                <td>${r.rank ?? ''}</td>
                <td class="tl team-cell"><img src="${esc(r.team.logo)}" alt="" loading="lazy">${esc(r.team.name)}</td>
                <td>${r.p ?? ''}</td><td>${r.gd > 0 ? '+' : ''}${r.gd ?? ''}</td><td><b>${r.pts ?? ''}</b></td>
                <td class="${t ? cls(t.att, true) : ''}">${t ? t.att.toFixed(2) : '—'}</td>
                <td class="${t ? cls(t.def, false) : ''}">${t ? t.def.toFixed(2) : '—'}</td>
                <td class="tl">${t ? formChips(t.stats.form) : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </section>`).join('')}
      <p class="hint pad">Атк/Обр — індекси сили з урахуванням суперників (1.00 — середній рівень турніру). Форма — від старіших матчів до свіжіших.</p>`;
  }

  // ---------- Статус ставок ----------
  const VOID_STATUS = /POSTPONED|CANCELED|ABANDONED/;

  // Статус ставки за даними сезону: pending / live / win / loss / void / unknown / nodata.
  function legStatus(l) {
    const x = state.events.get(evKey(l.slug, l.id));
    const ev = x && x.ev;
    if (!ev) return { s: l.ts * 1000 + 4 * 3600e3 < Date.now() ? 'unknown' : 'pending' };
    if (VOID_STATUS.test(ev.status)) return { s: 'void' };
    if (isFinished(ev)) {
      const score = `${ev.home.score}:${ev.away.score}`;
      const r = model.settle(l.key, ev.home.score, ev.away.score, state.facts.get(l.id));
      if (r === undefined) return { s: 'nodata', score };   // тайми/кутові/картки без фактів матчу
      return { s: r === true ? 'win' : r === false ? 'loss' : 'void', score };
    }
    if (isLive(ev)) return { s: 'live', score: `${ev.home.score ?? 0}:${ev.away.score ?? 0}` };
    return { s: 'pending' };
  }

  const STATUS_ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '↺', unknown: '?', nodata: '…' };

  // Країна й турнір: «Данія · Суперліга», «УЄФА · Ліга чемпіонів».
  const leagueLabel = slug => {
    const l = LEAGUE_BY_SLUG.get(slug);
    return l ? `${l.country} · ${l.name}` : '';
  };

  // ---------- Статистика прогнозів ----------
  // Основна рекомендація, цінна ставка і найкращі варіанти за ринками кожного матчу
  // (останній прогноз перед стартом).
  state.histTab = 'bank';
  state.histPeriod = 30;

  async function viewHistory() {
    const rid = ++renderId;
    setHeader('Статистика');
    $view.innerHTML = '<div class="loading">Перевірка результатів…</div>';
    await FP.history.ready;
    if (rid !== renderId) return;

    const singles = FP.history.all();
    if (!singles.length) {
      $view.innerHTML = `<div class="empty">Статистика поки порожня.<br>Додаток запам'ятовує свої прогнози перед матчами, а після матчів показує тут, скільки з них зіграло.</div>`;
      return;
    }

    // Результати матчів беремо з даних сезонів відповідних турнірів.
    const slugs = [...new Set(singles.map(e => e.slug))].filter(s => LEAGUE_BY_SLUG.has(s));
    await api.pool(slugs, 4, async slug => {
      try {
        const s = await api.season(slug);
        s.events.forEach(ev => state.events.set(evKey(slug, ev.id), { slug, ev }));
      } catch {}
    });
    if (rid !== renderId) return;

    // Для ставок на тайми, кутові й картки потрібні факти матчу (рахунок 1-го тайму, статистика).
    const FACT_GROUPS = new Set(['Тайми', 'Кутові', 'Жовті картки']);
    const needFacts = singles.filter(e => (e.picks || []).some(p => FACT_GROUPS.has(p.group))).filter(e => {
      const x = state.events.get(evKey(e.slug, e.id));
      return x && isFinished(x.ev) && !state.facts.has(e.id);
    }).sort((a, b) => b.ts - a.ts).slice(0, 200);
    state.hist = { singles };
    renderHistory();

    // Факти матчів довантажуються у фоні (на телефоні це може тривати), потім екран оновлюється.
    if (needFacts.length) {
      await api.pool(needFacts, 4, async e => {
        try { state.facts.set(e.id, await api.matchFacts(e.slug, e.id)); } catch {}
      });
      if (rid === renderId) renderHistory();
    }
  }


  const DONE = s => s === 'win' || s === 'loss';
  const units = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  // Лише матчі від початку обліку (FP.STATS_FROM) і в межах вибраного періоду.
  const inPeriod = ts => ts >= FP.STATS_FROM && (!state.histPeriod || ts * 1000 >= Date.now() - state.histPeriod * 864e5);

  function singlesData() {
    return state.hist.singles.filter(e => inPeriod(e.ts)).map(e => {
      const tip = legStatus({ slug: e.slug, id: e.id, ts: e.ts, key: e.tip.key });
      const val = e.value ? legStatus({ slug: e.slug, id: e.id, ts: e.ts, key: e.value.key }) : null;
      return { ...e, tipSt: tip, valSt: val };
    }).sort((a, b) => b.ts - a.ts);
  }

  // Рядок «зіграло X з N (Y%) · очікувалось Z%» з полоскою.
  function rateRow(label, wins, n, expected) {
    const w = n ? (wins / n) * 100 : 0;
    return `
      <div class="rate">
        <div class="rate-head"><span>${esc(label)}</span><b>${n ? `${wins} з ${n} · ${pctOf(wins, n)}` : '—'}</b></div>
        <div class="rate-bar"><i style="width:${w.toFixed(1)}%"></i>${expected != null && n ? `<em style="left:${(expected * 100).toFixed(1)}%" title="очікувалось"></em>` : ''}</div>
        ${expected != null && n ? `<small>очікувалось ${Math.round(expected * 100)}%</small>` : ''}
      </div>`;
  }

  function renderHistory() {
    const tab = state.histTab;
    const periods = [[7, '7 днів'], [30, '30 днів'], [0, 'Увесь час']];
    const head = `
      <div class="controls">
        <div class="segmented small">
          <button class="${tab === 'bank' ? 'on' : ''}" data-htab="bank">Рахунок</button>
          <button class="${tab === 'singles' ? 'on' : ''}" data-htab="singles">Основні</button>
          <button class="${tab === 'value' ? 'on' : ''}" data-htab="value">Цінні</button>
          <button class="${tab === 'picks' ? 'on' : ''}" data-htab="picks">За ринками</button>
        </div>
        <div class="chips">${periods.map(([d, l]) => `<button class="chip ${state.histPeriod === d ? 'on' : ''}" data-hper="${d}">${l}</button>`).join('')}</div>
      </div>`;
    const foot = `
      <div class="btn-row pad">
        <button class="btn" data-pdf="1">Звіт PDF</button>
        <button class="btn ghost" data-export="${tab}">Таблиця CSV</button>
        <button class="btn ghost" data-hclear="1">Очистити статистику</button>
      </div>
      <p class="hint pad">CSV відкривається в Excel, Google Таблицях чи Numbers. Об'єктивні висновки можна робити після кількох сотень ставок: на десятках результат сильно залежить від везіння.</p>`;
    const body = ({ bank: bankHtml, singles: singlesHtml, value: valueHtml, picks: picksHtml }[tab] || bankHtml)();
    $view.innerHTML = head + body + foot;
  }

  // Записи з розрахованими варіантами: { ...entry, items: [{ ...pick, st }] }.
  function withStatuses(field) {
    return state.hist.singles.filter(e => inPeriod(e.ts) && (e[field] || []).length).map(e => ({
      ...e,
      items: e[field].map(p => ({ ...p, st: legStatus({ slug: e.slug, id: e.id, ts: e.ts, key: p.key }) })),
    })).sort((a, b) => b.ts - a.ts);
  }

  // Список матчів по днях з чіпами варіантів і ✓/✗.
  function dayList(rows, chipLabel) {
    const byDay = new Map();
    for (const r of rows.filter(r => r.items.some(x => x.st.s !== 'pending'))) {
      const d = dateOf(r.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    return [...byDay].map(([d, list]) => {
      const done = list.flatMap(r => r.items).filter(x => DONE(x.st.s));
      const w = done.filter(x => x.st.s === 'win').length;
      return `
        <div class="day-head"><b>${esc(d)}</b><span>${done.length ? `${w} з ${done.length}` : ''}</span></div>
        ${list.map(r => `
          <a class="hrow" href="#/match/${r.slug}/${r.id}">
            <div class="hrow-main">
              <small>${esc(leagueLabel(r.slug))}</small>
              <span>${esc(r.home)} — ${esc(r.away)} ${r.items[0].st.score ? `<b>${esc(r.items[0].st.score)}</b>` : ''}</span>
              <div class="pchips">${r.items.map(x => `<span class="pchip ${x.st.s}">${esc(chipLabel(x))} ${STATUS_ICON[x.st.s] || ''}</span>`).join('')}</div>
            </div>
          </a>`).join('')}`;
    }).join('');
  }

  // ---------- Віртуальний рахунок ----------
  // Симуляція: на кожну основну ставку і цінну ставку — 50 грн.
  // Коефіцієнт — букмекерський (DraftKings), якщо був, інакше справедливий (1 / ймовірність).
  // На «найкращі ставки за ринками» не ставимо.
  const STAKE = 50;
  const BANK_CATS = { tip: 'Основні', value: 'Цінні' };
  const bankStart = () => { try { return Number(localStorage.getItem('fp_bank_start')) || 5000; } catch { return 5000; } };
  const uah = v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('uk-UA')} грн`;
  const money = v => `${Math.round(v).toLocaleString('uk-UA')} грн`;

  function bankBets() {
    const bets = [];
    for (const r of singlesData()) {
      const base = { ts: r.ts, slug: r.slug, id: r.id, title: `${r.home} — ${r.away}`, score: r.tipSt.score };
      bets.push({ ...base, cat: 'tip', pick: r.tip.short, odds: r.tip.odds || 1 / r.tip.p, book: !!r.tip.odds, s: r.tipSt.s });
      if (r.value) bets.push({ ...base, cat: 'value', pick: r.value.short, odds: r.value.odds, book: true, s: r.valSt.s });
    }
    return bets.map(b => ({ ...b, profit: b.s === 'win' ? STAKE * (b.odds - 1) : b.s === 'loss' ? -STAKE : 0 }));
  }

  // Графік балансу після кожної розрахованої ставки.
  function balanceChart(start, settled) {
    if (settled.length < 2) return '';
    const pts = [start];
    settled.forEach(b => pts.push(pts[pts.length - 1] + b.profit));
    const min = Math.min(...pts, start), max = Math.max(...pts, start), span = max - min || 1;
    const W = 300, H = 110;
    const x = i => (i / (pts.length - 1)) * W, y = v => H - ((v - min) / span) * H;
    const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const up = pts[pts.length - 1] >= start;
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Графік балансу">
          <line x1="0" x2="${W}" y1="${y(start).toFixed(1)}" y2="${y(start).toFixed(1)}" class="chart-base"/>
          <polyline points="${line}" class="chart-line ${up ? 'up' : 'down'}"/>
        </svg>
        <div class="chart-axis"><span>${money(max)}</span><span>${money(min)}</span></div>
      </div>`;
  }

  function bankHtml() {
    const start = bankStart();
    const bets = bankBets();
    const settled = bets.filter(b => DONE(b.s) || b.s === 'void').sort((a, b) => a.ts - b.ts);
    const pending = bets.filter(b => b.s === 'pending' || b.s === 'live');
    const profit = settled.reduce((s, b) => s + b.profit, 0);
    const staked = settled.length * STAKE;
    const wins = settled.filter(b => b.s === 'win').length, losses = settled.filter(b => b.s === 'loss').length;

    const byCat = Object.entries(BANK_CATS).map(([cat, label]) => {
      const list = settled.filter(b => b.cat === cat);
      const pr = list.reduce((s, b) => s + b.profit, 0);
      const w = list.filter(b => b.s === 'win').length;
      return `<tr><td>${label}</td><td>${list.length ? `${w} з ${list.length}` : '—'}</td><td>${money(list.length * STAKE)}</td>
        <td class="${pr >= 0 ? 'ok' : 'bad'}">${list.length ? uah(pr) : '—'}</td><td>${list.length ? (pr / (list.length * STAKE) * 100).toFixed(0) + '%' : '—'}</td></tr>`;
    }).join('');

    const recent = settled.slice().reverse().slice(0, 50).map(b => `
      <a class="hrow" href="#/match/${b.slug}/${b.id}">
        <div class="hrow-main">
          <small>${esc(dateOf(b.ts))} · ${BANK_CATS[b.cat]}</small>
          <span>${esc(b.title)} ${b.score ? `<b>${esc(b.score)}</b>` : ''}</span>
          <em>${esc(b.pick)} @ ${b.odds.toFixed(2)} ${b.book ? 'DK' : 'спр.'} · ставка 50 грн</em>
        </div>
        <div class="hrow-st bank-res ${b.profit > 0 ? 'ok' : b.profit < 0 ? 'bad' : ''}">${b.s === 'void' ? '↺ 0' : uah(b.profit)}</div>
      </a>`).join('');

    return `
      <section class="card bank">
        <div class="bank-balance">
          <span>Баланс</span>
          <b class="${profit >= 0 ? 'ok' : 'bad'}">${money(start + profit)}</b>
          <small>стартовий банк <input id="bank-start" type="number" inputmode="numeric" min="0" step="100" value="${start}"> грн</small>
        </div>
        <div class="kpis kpis2">
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${settled.length ? uah(profit) : '—'}</b><span>прибуток</span></div>
          <div><b>${staked ? (profit / staked * 100).toFixed(1) + '%' : '—'}</b><span>ROI<br>поставлено ${money(staked)}</span></div>
          <div><b>${wins} / ${losses}</b><span>виграно / програно<br>в грі ${pending.length} (${money(pending.length * STAKE)})</span></div>
        </div>
        ${balanceChart(start, settled)}
        <p class="hint">Симуляція: на кожну основну і кожну цінну ставку ставиться 50 грн. Коефіцієнт — DraftKings, якщо був, інакше справедливий (у букмекера реальний кф на 5–8% нижчий, тож реальний результат був би трохи гіршим). На «найкращі ставки за ринками» не ставимо.</p>
      </section>
      <section class="card">
        <h3>За типами ставок</h3>
        <table class="markets"><thead><tr><th></th><th>Зіграло</th><th>Поставлено</th><th>Прибуток</th><th>ROI</th></tr></thead><tbody>${byCat}</tbody></table>
      </section>
      ${(() => {
        const single = settled.filter(b => DONE(b.s));
        if (!single.length) return '';
        const rows = groupBy(single, b => leagueLabel(b.slug)).map(([l, list]) => {
          const pr = list.reduce((s, b) => s + b.profit, 0), w = list.filter(b => b.s === 'win').length;
          return `<tr><td>${esc(l)}</td><td>${w} з ${list.length}</td><td class="${pr >= 0 ? 'ok' : 'bad'}">${uah(pr)}</td><td>${(pr / (list.length * STAKE) * 100).toFixed(0)}%</td></tr>`;
        }).join('');
        return `<section class="card"><h3>За чемпіонатами</h3>
          <table class="markets"><thead><tr><th>Чемпіонат</th><th>Зіграло</th><th>Прибуток</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table></section>`;
      })()}
      ${recent ?`<section class="card"><h3>Ставки</h3>${recent}</section>` : '<div class="empty">Ще немає розрахованих ставок.<br>Вони з\'являться після перших зіграних матчів.</div>'}`;
  }

  $view.addEventListener('change', e => {
    if (e.target.id !== 'bank-start') return;
    try { localStorage.setItem('fp_bank_start', String(Math.max(0, Number(e.target.value) || 0))); } catch {}
    renderHistory();
  });

  // ---------- Цінні ставки ----------
  // Ставки, де наша ймовірність вища, ніж закладено в кф DraftKings (перевага від 3%, ймовірність від 30%).
  // Прибуток рахується за реальним кф букмекера — це найчесніша перевірка, чи модель «б'є» ринок.
  function valueRows() {
    return singlesData().filter(r => r.value).map(r => ({
      ...r, v: { ...r.value, st: r.valSt, edge: r.value.p * r.value.odds - 1 },
    }));
  }

  function valueHtml() {
    const rows = valueRows();
    const done = rows.filter(r => DONE(r.v.st.s));
    const wins = done.filter(r => r.v.st.s === 'win').length;
    const profitOf = list => list.reduce((s, r) => s + (r.v.st.s === 'win' ? r.v.odds - 1 : -1), 0);
    const profit = profitOf(done);
    const avg = (list, f) => (list.length ? list.reduce((s, r) => s + f(r), 0) / list.length : null);
    const avgOdds = avg(done, r => r.v.odds), avgEdge = avg(done, r => r.v.edge), exp = avg(done, r => r.v.p);
    const pending = rows.filter(r => !DONE(r.v.st.s) && r.v.st.s !== 'void').length;

    // Розбивки: за перевагою, за кф, за ринком. Для кожної — зіграло / очікувалось / прибуток.
    const block = (label, list) => {
      const w = list.filter(r => r.v.st.s === 'win').length;
      const pr = profitOf(list);
      return `${rateRow(label, w, list.length, list.length ? avg(list, r => r.v.p) : null)}
        ${list.length ? `<p class="band-sum">середній кф ${avg(list, r => r.v.odds).toFixed(2)} · прибуток <b class="${pr >= 0 ? 'ok' : 'bad'}">${units(pr)}</b> од. · ROI ${(pr / list.length * 100).toFixed(0)}%</p>` : ''}`;
    };
    const byEdge = [[0.03, 0.06, 'Перевага 3–6%'], [0.06, 0.10, 'Перевага 6–10%'], [0.10, 9, 'Перевага від 10%']]
      .map(([lo, hi, l]) => block(l, done.filter(r => r.v.edge >= lo && r.v.edge < hi))).join('');
    const byOdds = [[1, 2, 'Кф до 2.00'], [2, 3, 'Кф 2.00–3.00'], [3, 99, 'Кф від 3.00']]
      .map(([lo, hi, l]) => block(l, done.filter(r => r.v.odds >= lo && r.v.odds < hi))).join('');
    const markets = new Map();
    for (const r of done) {
      if (!markets.has(r.v.short)) markets.set(r.v.short, []);
      markets.get(r.v.short).push(r);
    }
    const byMarket = [...markets].sort((a, b) => b[1].length - a[1].length).map(([m, list]) => {
      const w = list.filter(r => r.v.st.s === 'win').length, pr = profitOf(list);
      return `<tr><td>${esc(m)}</td><td>${w} з ${list.length}</td><td class="${pr >= 0 ? 'ok' : 'bad'}">${units(pr)}</td></tr>`;
    }).join('');

    const byDay = new Map();
    for (const r of rows.filter(r => r.v.st.s !== 'pending')) {
      const d = dateOf(r.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const days = [...byDay].map(([d, list]) => {
      const dd = list.filter(r => DONE(r.v.st.s)), pr = profitOf(dd);
      return `
        <div class="day-head"><b>${esc(d)}</b><span>${dd.length ? `${dd.filter(r => r.v.st.s === 'win').length} з ${dd.length} · ${units(pr)} од.` : ''}</span></div>
        ${list.map(r => `
          <a class="hrow" href="#/match/${r.slug}/${r.id}">
            <div class="hrow-main">
              <small>${esc(leagueLabel(r.slug))}</small>
              <span>${esc(r.home)} — ${esc(r.away)} ${r.v.st.score ? `<b>${esc(r.v.st.score)}</b>` : ''}</span>
              <em>${esc(r.v.short)} @ ${r.v.odds.toFixed(2)} · ймовірність ${pct(r.v.p)} · перевага +${(r.v.edge * 100).toFixed(1)}%</em>
            </div>
            <div class="hrow-st">${r.v.st.s === 'live' ? '<span class="live">LIVE</span>' : STATUS_ICON[r.v.st.s] || ''}</div>
          </a>`).join('')}`;
    }).join('');

    return `
      <section class="card">
        <div class="kpis">
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${done.length ? units(profit) : '—'}</b><span>прибуток, од.<br>за кф DraftKings</span></div>
          <div><b>${done.length ? (profit / done.length * 100).toFixed(0) + '%' : '—'}</b><span>ROI<br>${wins} з ${done.length} зіграло</span></div>
          <div><b>${pending}</b><span>очікують<br>результату</span></div>
        </div>
        <div class="kpis kpis2">
          <div><b>${pctOf(wins, done.length)}</b><span>зіграло<br>очікувалось ${exp != null ? Math.round(exp * 100) + '%' : '—'}</span></div>
          <div><b>${avgOdds != null ? avgOdds.toFixed(2) : '—'}</b><span>середній<br>кф</span></div>
          <div><b>${avgEdge != null ? '+' + (avgEdge * 100).toFixed(1) + '%' : '—'}</b><span>середня<br>перевага</span></div>
        </div>
        <p class="hint">Цінна ставка — ринок, де наша ймовірність вища, ніж закладено в кф DraftKings: перевага від 3% при ймовірності від 30%. Прибуток — при ставці 1 од. на кожну за кф DraftKings. Цінні ставки виграють рідше за основні (кф вищі), тож оцінювати їх можна лише за прибутком на сотнях ставок.</p>
      </section>
      ${done.length ? `
      <section class="card"><h3>За розміром переваги</h3>${byEdge}
        <p class="hint">Якщо модель справді бачить те, чого не бачить ринок, ставки з більшою перевагою мають давати більший ROI.</p></section>
      <section class="card"><h3>За коефіцієнтом</h3>${byOdds}</section>
      <section class="card"><h3>За ринком</h3><table class="markets"><thead><tr><th>Ринок</th><th>Зіграло</th><th>Прибуток, од.</th></tr></thead><tbody>${byMarket}</tbody></table></section>
      <section class="card"><h3>За чемпіонатами</h3>${statTable('Чемпіонат', groupBy(done.map(r => ({ ...r.v, slug: r.slug })), x => leagueLabel(x.slug)), x => x.odds)}</section>` : ''}
      ${(() => {
        const wait = rows.filter(r => r.v.st.s === 'pending' || r.v.st.s === 'live').sort((a, b) => a.ts - b.ts);
        return wait.length ? `<section class="card"><h3>Очікують результату · ${wait.length}</h3>${wait.map(r => `
          <a class="hrow" href="#/match/${r.slug}/${r.id}">
            <div class="hrow-main">
              <small>${esc(dateOf(r.ts))} ${esc(timeOf(r.ts))} · ${esc(leagueLabel(r.slug))}</small>
              <span>${esc(r.home)} — ${esc(r.away)}</span>
              <em>${esc(r.v.short)} @ ${r.v.odds.toFixed(2)} · перевага +${(r.v.edge * 100).toFixed(1)}%</em>
            </div>
            <div class="hrow-st">${r.v.st.s === 'live' ? '<span class="live">LIVE</span>' : ''}</div>
          </a>`).join('')}</section>` : '';
      })()}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : (rows.length ? '' : '<div class="empty">За цей період цінних ставок ще немає.<br>Вони з\'являються, коли кф DraftKings вищий, ніж має бути за прогнозом.</div>')}`;
  }

  // Таблиця «зіграло / очікувалось / прибуток / ROI» для груп ставок. kOf — кф ставки
  // (для лайву й варіантів — справедливий, для цінних — DraftKings). Прибуток — при ставці 1 од.
  function statTable(head, groups, kOf = x => x.k) {
    const rows = groups.map(([label, list]) => {
      const w = list.filter(x => x.st.s === 'win').length;
      const pr = list.reduce((s, x) => s + (x.st.s === 'win' ? kOf(x) - 1 : -1), 0);
      const exp = list.reduce((s, x) => s + x.p, 0) / list.length;
      return `<tr><td>${esc(label)}</td><td>${w} з ${list.length}</td><td><b>${pctOf(w, list.length)}</b> <small>/ ${Math.round(exp * 100)}%</small></td>
        <td class="${pr >= 0 ? 'ok' : 'bad'}">${units(pr)}</td><td>${(pr / list.length * 100).toFixed(0)}%</td></tr>`;
    }).join('');
    return `<table class="markets"><thead><tr><th>${esc(head)}</th><th>Зіграло</th><th>% / очік.</th><th>Од.</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const groupBy = (list, key) => {
    const m = new Map();
    for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return [...m].sort((a, b) => b[1].length - a[1].length);
  };

  function picksHtml() {
    const rows = withStatuses('picks');
    const all = rows.flatMap(r => r.items);
    const done = all.filter(x => DONE(x.st.s));
    const wins = done.filter(x => x.st.s === 'win').length;
    const exp = done.length ? done.reduce((s, x) => s + x.p, 0) / done.length : null;
    const groups = Object.values(model.GROUPS).map(g => {
      const list = done.filter(x => x.group === g);
      return rateRow(g, list.filter(x => x.st.s === 'win').length, list.length,
        list.length ? list.reduce((s, x) => s + x.p, 0) / list.length : null);
    }).join('');
    const nodata = all.filter(x => x.st.s === 'nodata').length;
    const days = dayList(rows, x => x.short);
    return `
      <section class="card">
        <div class="kpis">
          <div><b>${pctOf(wins, done.length)}</b><span>варіантів зіграло<br>${wins} з ${done.length}</span></div>
          <div><b>${exp != null ? Math.round(exp * 100) + '%' : '—'}</b><span>очікувалось<br>за прогнозом</span></div>
          <div><b>${rows.length}</b><span>матчів<br>у статистиці</span></div>
        </div>
        ${nodata ? `<p class="hint">Ще не розраховано ${nodata} варіантів на тайми, кутові чи картки: статистика цих матчів поки недоступна.</p>` : ''}
      </section>
      ${done.length ? `<section class="card">
        <h3>За групами ринків</h3>
        ${groups}
        <p class="hint">Найкращий варіант у кожній групі — найімовірніший з кф від 1.5 до 3 (як у блоці «Найкращі ставки на матч за ринками» на екрані матчу). Риска — скільки мало зіграти за прогнозом.</p>
      </section>
      <section class="card"><h3>За чемпіонатами</h3>${statTable('Чемпіонат', groupBy(rows.flatMap(r => r.items.map(x => ({ ...x, slug: r.slug }))).filter(x => DONE(x.st.s)), x => leagueLabel(x.slug)), x => 1 / x.p)}</section>` : ''}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : '<div class="empty">За цей період ще немає зіграних матчів.</div>'}`;
  }

  function singlesHtml() {
    const rows = singlesData();
    const tips = rows.filter(r => DONE(r.tipSt.s));
    const tipWins = tips.filter(r => r.tipSt.s === 'win').length;
    const tipExp = tips.length ? tips.reduce((s, r) => s + r.tip.p, 0) / tips.length : null;
    const vals = rows.filter(r => r.value && DONE(r.valSt.s));
    const valWins = vals.filter(r => r.valSt.s === 'win').length;
    const valProfit = vals.reduce((s, r) => s + (r.valSt.s === 'win' ? r.value.odds - 1 : -1), 0);
    const pending = rows.filter(r => !DONE(r.tipSt.s) && r.tipSt.s !== 'void').length;

    const byLevel = [3, 2, 1].map(l => {
      const list = tips.filter(r => r.tip.level === l);
      return rateRow(`${['', 'Низька', 'Середня', 'Висока'][l]} впевненість`, list.filter(r => r.tipSt.s === 'win').length, list.length,
        list.length ? list.reduce((s, r) => s + r.tip.p, 0) / list.length : null);
    }).join('');

    const leagues = new Map();
    for (const r of tips) {
      if (!leagues.has(r.slug)) leagues.set(r.slug, { w: 0, n: 0 });
      const x = leagues.get(r.slug);
      x.n++; if (r.tipSt.s === 'win') x.w++;
    }
    const byLeague = [...leagues].sort((a, b) => b[1].n - a[1].n).map(([slug, x]) => `
      <tr><td>${esc(leagueLabel(slug))}</td><td>${x.w} з ${x.n}</td><td><b>${pctOf(x.w, x.n)}</b></td></tr>`).join('');

    // Список за днями.
    const byDay = new Map();
    for (const r of rows.filter(r => r.tipSt.s !== 'pending')) {
      const d = dateOf(r.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const days = [...byDay].map(([d, list]) => {
      const done = list.filter(r => DONE(r.tipSt.s));
      const w = done.filter(r => r.tipSt.s === 'win').length;
      return `
        <div class="day-head"><b>${esc(d)}</b><span>${done.length ? `${w} з ${done.length}` : ''}</span></div>
        ${list.map(r => `
          <a class="hrow" href="#/match/${r.slug}/${r.id}">
            <div class="hrow-main">
              <small>${esc(leagueLabel(r.slug))}</small>
              <span>${esc(r.home)} — ${esc(r.away)} ${r.tipSt.score ? `<b>${esc(r.tipSt.score)}</b>` : ''}</span>
              <em>${esc(r.tip.short)} · ${pct(r.tip.p)}${r.value ? ` &nbsp;|&nbsp; цінна: ${esc(r.value.short)} @ ${r.value.odds.toFixed(2)} ${r.valSt && r.valSt.s !== 'pending' ? STATUS_ICON[r.valSt.s] || '' : ''}` : ''}</em>
            </div>
            <div class="hrow-st">${r.tipSt.s === 'live' ? '<span class="live">LIVE</span>' : STATUS_ICON[r.tipSt.s] || ''}</div>
          </a>`).join('')}`;
    }).join('');

    return `
      <section class="card">
        <div class="kpis">
          <div><b>${pctOf(tipWins, tips.length)}</b><span>основні ставки<br>${tipWins} з ${tips.length}</span></div>
          <div><b class="${valProfit >= 0 ? 'ok' : 'bad'}">${vals.length ? units(valProfit) : '—'}</b><span>цінні ставки, од.<br>${vals.length ? `${valWins} з ${vals.length} · ROI ${(valProfit / vals.length * 100).toFixed(0)}%` : 'ще немає'}</span></div>
          <div><b>${pending}</b><span>очікують<br>результату</span></div>
        </div>
      </section>
      ${tips.length ? `<section class="card">
        <h3>Основні ставки</h3>
        ${rateRow('Усі', tipWins, tips.length, tipExp)}
        ${byLevel}
        <p class="hint">Зелена смуга — скільки зіграло, риска — скільки мало зіграти за прогнозом. Якщо смуга стабільно досягає риски, ймовірності додатка чесні.</p>
      </section>` : ''}
      ${byLeague ? `<section class="card">
        <h3>За турнірами</h3>
        <table class="markets"><tbody>${byLeague}</tbody></table>
      </section>` : ''}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : '<div class="empty">За цей період ще немає зіграних матчів.</div>'}`;
  }

  // ---------- Звіт у PDF ----------
  // Звіт верстається як звичайна HTML-сторінка А4 і перетворюється на PDF бібліотекою html2pdf
  // (вантажиться лише під час експорту). Кирилиця зберігається, бо сторінка рендериться як зображення.
  const HTML2PDF = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  let html2pdfLoading = null;
  function loadHtml2pdf() {
    if (window.html2pdf) return Promise.resolve();
    html2pdfLoading = html2pdfLoading || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HTML2PDF;
      s.onload = resolve;
      s.onerror = () => { html2pdfLoading = null; reject(new Error('Не вдалося завантажити модуль PDF. Перевірте інтернет.')); };
      document.head.appendChild(s);
    });
    return html2pdfLoading;
  }

  function reportHtml() {
    const RES = { win: '✓', loss: '✗', void: '↺' };
    const pc = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
    const u = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    const agg = (list, k) => {
      const done = list.filter(x => DONE(x.st.s));
      const w = done.filter(x => x.st.s === 'win').length;
      const exp = done.length ? done.reduce((s, x) => s + x.p, 0) / done.length : null;
      const profit = k ? done.reduce((s, x) => s + (x.st.s === 'win' ? k(x) - 1 : -1), 0) : null;
      return { n: done.length, w, exp, profit };
    };
    const row = (label, a) => `<tr><td>${esc(label)}</td><td>${a.n}</td><td>${a.w}</td><td><b>${pc(a.w, a.n)}</b></td>
      <td>${a.exp != null ? Math.round(a.exp * 100) + '%' : '—'}</td><td class="${a.profit == null || !a.n ? '' : a.profit >= 0 ? 'pos' : 'neg'}">${a.profit == null || !a.n ? '—' : u(a.profit)}</td></tr>`;
    const table = (head, body) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
    const H = ['', 'Розраховано', 'Зіграло', '%', 'Очікувалось', 'Прибуток, од.'];

    const singles = singlesData();
    const tips = singles.map(r => ({ ...r.tip, st: r.tipSt }));
    const values = singles.filter(r => r.value).map(r => ({ ...r.value, st: r.valSt }));
    const picks = withStatuses('picks').flatMap(r => r.items);
    const fairK = x => 1 / x.p;

    const summary = [
      row('Основні ставки', agg(tips, x => x.odds || 1 / x.p)),
      row('Цінні ставки (кф DraftKings)', agg(values, x => x.odds)),
      row('Найкращі ставки за ринками', agg(picks, fairK)),
    ].join('');

    const byLevel = [3, 2, 1].map(l => row(`${['', 'Низька', 'Середня', 'Висока'][l]} впевненість`,
      agg(tips.filter(t => t.level === l), x => x.odds || 1 / x.p))).join('');
    const byGroup = Object.values(model.GROUPS).map(g => {
      const a = agg(picks.filter(x => x.group === g), fairK);
      return a.n ? row(g, a) : '';
    }).join('');

    const journal = singles.filter(r => DONE(r.tipSt.s)).slice(0, 200).map(r => `
      <tr><td>${esc(FP.dateOfTs(r.ts).split('-').reverse().join('.'))}</td><td>${esc(leagueLabel(r.slug))}</td>
        <td>${esc(r.home)} — ${esc(r.away)}</td><td>${esc(r.tipSt.score || '')}</td>
        <td>${esc(r.tip.short)}</td><td>${pct(r.tip.p)}</td><td class="${r.tipSt.s === 'win' ? 'pos' : 'neg'}">${RES[r.tipSt.s]}</td></tr>`).join('');

    const period = state.histPeriod ? `останні ${state.histPeriod} днів` : 'увесь час';
    return `
      <div class="pdf">
        <style>
          .pdf { width: 740px; padding: 8px 4px; font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #15201a; background: #fff; }
          .pdf h1 { font-size: 22px; margin: 0; } .pdf h2 { font-size: 15px; margin: 18px 0 6px; color: #17834f; }
          .pdf .meta { color: #5e6862; margin: 2px 0 10px; } .pdf .band { height: 4px; background: #17834f; border-radius: 2px; margin: 8px 0 12px; }
          .pdf table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
          .pdf th { text-align: left; font-size: 11px; color: #5e6862; border-bottom: 1.5px solid #c9d1cb; padding: 5px 6px; }
          .pdf td { border-bottom: 1px solid #e3e8e3; padding: 5px 6px; } .pdf tr { page-break-inside: avoid; }
          .pdf .pos { color: #17834f; font-weight: 700; } .pdf .neg { color: #b4483a; font-weight: 700; }
          .pdf .note { color: #5e6862; font-size: 10.5px; margin-top: 14px; }
        </style>
        <h1>Футбол Аналітика — статистика прогнозів</h1>
        <div class="meta">Період: ${esc(period)} · сформовано ${esc(new Date().toLocaleString('uk-UA'))}</div>
        <div class="band"></div>
        ${(() => {
          const bets = bankBets().filter(b => DONE(b.s) || b.s === 'void');
          const pr = bets.reduce((s, b) => s + b.profit, 0);
          const rows = [['Усі ставки', bets], ...Object.entries(BANK_CATS).map(([c, l]) => [l, bets.filter(b => b.cat === c)])]
            .map(([l, list]) => {
              const p = list.reduce((s, b) => s + b.profit, 0);
              return `<tr><td>${esc(l)}</td><td>${list.length}</td><td>${list.filter(b => b.s === 'win').length}</td><td>${money(list.length * STAKE)}</td>
                <td class="${p >= 0 ? 'pos' : 'neg'}">${list.length ? uah(p) : '—'}</td><td>${list.length ? (p / (list.length * STAKE) * 100).toFixed(1) + '%' : '—'}</td></tr>`;
            }).join('');
          return `<h2>Віртуальний рахунок (50 грн на ставку)</h2>
            <p class="meta">Стартовий банк ${money(bankStart())} → баланс <b>${money(bankStart() + pr)}</b></p>
            ${table(['', 'Ставок', 'Виграно', 'Поставлено', 'Прибуток', 'ROI'], rows)}`;
        })()}
        <h2>Підсумок</h2>
        ${table(['Тип рекомендацій', ...H.slice(1)], summary)}
        <h2>Основні ставки за рівнем впевненості</h2>
        ${table(H, byLevel)}
        <h2>Основні та цінні ставки за чемпіонатами</h2>
        ${table(H, groupBy([
          ...singles.map(r => ({ ...r.tip, st: r.tipSt, slug: r.slug, k: r.tip.odds || 1 / r.tip.p })),
          ...singles.filter(r => r.value).map(r => ({ ...r.value, st: r.valSt, slug: r.slug, k: r.value.odds })),
        ], x => leagueLabel(x.slug)).map(([l, xs]) => row(l, agg(xs, x => x.k))).join(''))}
        <h2>Цінні ставки (за кф DraftKings)</h2>
        ${table(H, [[0.03, 0.06, 'Перевага 3–6%'], [0.06, 0.10, 'Перевага 6–10%'], [0.10, 9, 'Перевага від 10%']]
          .map(([lo, hi, l]) => row(l, agg(values.filter(v => v.p * v.odds - 1 >= lo && v.p * v.odds - 1 < hi), x => x.odds))).join('')
          + row('Усі цінні ставки', agg(values, x => x.odds)))}
        ${byGroup ? `<h2>Найкращі ставки за ринками</h2>${table(H, byGroup)}` : ''}
        ${journal ? `<h2>Журнал основних ставок</h2>${table(['Дата', 'Турнір', 'Матч', 'Рахунок', 'Ставка', 'Ймов.', ''], journal)}` : ''}
        <p class="note">«Очікувалось» — середня ймовірність за прогнозом додатка. Прибуток — при ставці 1 од. на кожну рекомендацію: для основних і цінних ставок за кф DraftKings, якщо він був, інакше за справедливим кф; у вашого букмекера кф зазвичай на 5–8% нижчий. Прогнози ймовірнісні та не гарантують виграшу. 18+.</p>
      </div>`;
  }

  async function exportPdf(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Створення PDF…';
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
    holder.innerHTML = reportHtml();
    document.body.appendChild(holder);
    try {
      await loadHtml2pdf();
      await window.html2pdf().set({
        margin: [10, 10, 12, 10],
        filename: `zvit-statystyka-${FP.localDate(0)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr'] },
      }).from(holder.firstElementChild).save();
    } catch (e) {
      alert(e.message || 'Не вдалося створити PDF');
    } finally {
      holder.remove();
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- Експорт у CSV (роздільник «;» і десяткова кома — для українського Excel) ----------
  function exportCsv(tab) {
    const num = x => (x == null ? '' : String(+x.toFixed(3)).replace('.', ','));
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const RES = { win: 'зіграла', loss: 'не зіграла', void: 'повернення', pending: 'очікує', live: 'йде', unknown: 'невідомо' };
    let rows;
    if (tab === 'singles') {
      rows = [['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Рахунок', 'Прогноз', 'Ймовірність', 'Впевненість', 'Результат', 'Цінна ставка', 'Кф цінної', 'Результат цінної']];
      for (const r of singlesData()) {
        rows.push([FP.dateOfTs(r.ts), timeOf(r.ts), leagueLabel(r.slug), r.home, r.away, r.tipSt.score || '', r.tip.short,
          num(r.tip.p), ['', 'низька', 'середня', 'висока'][r.tip.level], RES[r.tipSt.s],
          r.value ? r.value.short : '', r.value ? num(r.value.odds) : '', r.valSt ? RES[r.valSt.s] : '']);
      }
    } else if (tab === 'bank') {
      rows = [['Дата', 'Тип', 'Подія', 'Рахунок', 'Ставка', 'Кф', 'Джерело кф', 'Сума, грн', 'Результат', 'Прибуток, грн']];
      for (const b of bankBets().sort((x, y) => x.ts - y.ts)) {
        rows.push([FP.dateOfTs(b.ts), BANK_CATS[b.cat], b.title, b.score || '', b.pick, num(b.odds), b.book ? 'DraftKings' : 'справедливий',
          STAKE, RES[b.s] || 'немає даних', DONE(b.s) || b.s === 'void' ? num(b.profit) : '']);
      }
    } else if (tab === 'value') {
      rows = [['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Рахунок', 'Цінна ставка', 'Ймовірність', 'Кф DraftKings', 'Перевага', 'Результат', 'Прибуток, од.']];
      for (const r of valueRows()) {
        const s = r.v.st.s;
        rows.push([FP.dateOfTs(r.ts), timeOf(r.ts), leagueLabel(r.slug), r.home, r.away, r.v.st.score || '', r.v.short,
          num(r.v.p), num(r.v.odds), num(r.v.edge), RES[s] || 'немає даних',
          s === 'win' ? num(r.v.odds - 1) : s === 'loss' ? '-1' : '']);
      }
    } else {
      rows = [['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Рахунок', 'Група ринків', 'Ставка', 'Ймовірність', 'Кф (справедливий)', 'Результат']];
      for (const r of withStatuses('picks')) {
        for (const x of r.items) {
          rows.push([FP.dateOfTs(r.ts), timeOf(r.ts), leagueLabel(r.slug), r.home, r.away, x.st.score || '',
            x.group, x.short, num(x.p), num(1 / x.p), RES[x.st.s] || 'немає даних']);
        }
      }
    }
    const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `statystyka-${{ bank: 'rakhunok', singles: 'osnovni', value: 'cinni', picks: 'za-rynkamy' }[tab]}-${FP.localDate(0)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  $view.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !state.hist) return;
    if (b.dataset.htab) { state.histTab = b.dataset.htab; renderHistory(); }
    else if (b.dataset.hper != null) { state.histPeriod = Number(b.dataset.hper); renderHistory(); }
    else if (b.dataset.export) exportCsv(b.dataset.export);
    else if (b.dataset.pdf) exportPdf(b);
    else if (b.dataset.hclear) {
      if (!confirm('Видалити всю статистику прогнозів?')) return;
      FP.history.clear();
      state.hist = null;
      viewHistory();
    }
  });

  // ---------- Довідка ----------
  function viewInfo(focus) {
    ++renderId;
    setHeader('Довідка');
    const G = FP.GLOSSARY;
    $view.innerHTML = `
      <nav class="toc">
        <a href="#/info/terms">Як читати прогноз</a>
        <a href="#/info/markets">Словник ставок</a>
        <a href="#/info/how">Як працює аналіз</a>
        <a href="#/info/data">Дані</a>
      </nav>

      <section class="card" id="t-terms">
        <h3>Як читати прогноз</h3>
        <dl class="terms">${G.terms.map(t => `
          <div id="t-${t.id}" class="term"><dt>${esc(t.title)}</dt><dd>${esc(t.text)}</dd></div>`).join('')}
        </dl>
      </section>

      <section class="card" id="t-markets">
        <h3>Словник ставок</h3>
        ${G.markets.map((g, i) => `
          <details class="mgroup" ${i < 2 ? 'open' : ''}>
            <summary>${esc(g.group)}<span>${g.items.length}</span></summary>
            <dl class="gloss">${g.items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
          </details>`).join('')}
      </section>

      <section class="card" id="t-how">
        <h3>Як працює аналіз</h3>
        <ul class="reasons">
          <li>З результатів усіх матчів сезону рахуються індекси атаки й оборони кожної команди з урахуванням сили суперників. Свіжі матчі важать більше, минулий сезон теж враховується з меншою вагою.</li>
          <li>Поки зіграно мало матчів, індекси згладжуються до середнього, щоб одна випадкова гра не спотворювала прогноз.</li>
          <li>У єврокубках відправна точка — рейтинг команди у своєму чемпіонаті з поправкою на силу чемпіонату.</li>
          <li>Для АПЛ, Ла Ліги, Бундесліги, Серії A, Ліги 1, Чемпіоншипу і Бразилії в рейтинги на 40% входить xG.</li>
          <li>Форма за останні 5 матчів змінює очікувані голи не більше ніж на ±6%.</li>
          <li>З очікуваних голів модель Пуассона з поправкою Діксона–Коулза рахує ймовірність кожного рахунку, а з них — ймовірності всіх ринків.</li>
          <li>Якщо є коефіцієнти букмекера, ймовірності поєднуються: 30% модель + 70% ринок.</li>
          <li>Кутові й картки рахуються окремою моделлю за сезонною статистикою команд, тож це орієнтовна оцінка: вона не знає ні суддю, ні тактику на конкретний матч.</li>
          <li>Тайми рахуються за середньою часткою голів: близько 44% у першому таймі, 56% у другому.</li>
          <li>Модель відкалібровано на 1091 зіграному матчі 25 чемпіонатів (прогноз за даними до гри): виправлено недооцінку голів, уточнено розкид кутових і карток, неефективні ринки прибрано. ${help('calib')}</li>
          <li>Вкладка «Статистика» показує, скільки прогнозів додатка справді зіграло.</li>
        </ul>
      </section>

      <section class="card" id="t-data">
        <h3>Дані</h3>
        <ul class="reasons">
          <li>Розклад, результати, таблиці, склади, коефіцієнти, xG і статистика команд (кутові, картки, удари) беруться з ESPN. Ключ і реєстрація не потрібні.</li>
          <li>Поки додаток відкритий, рахунки й прогнози оновлюються кожні 2 хвилини.</li>
          <li>Склади з'являються приблизно за годину до матчу. Додаток перевіряє їх кожні 5 хвилин.</li>
          <li>Після кожного зіграного матчу рейтинги команд і прогнози перераховуються автоматично.</li>
          <li>Інформації про травми в безкоштовних джерелах немає. Її частково враховують коефіцієнти букмекера, з якими поєднується прогноз.</li>
        </ul>
        <p class="hint">Кеш — збережені на телефоні дані (матчі, таблиці, статистика), щоб додаток відкривався швидко і не завантажував усе щоразу заново. Зазвичай його чіпати не треба. Кнопка потрібна, лише якщо дані виглядають застарілими чи неправильними: тоді все завантажиться наново. Статистика прогнозів не зітреться.</p>
        <div class="btn-row"><button id="clear" class="btn ghost">Завантажити дані наново</button></div>
      </section>

      <section class="card disclaimer">
        <h3>18+ · Відповідальна гра</h3>
        <p>Прогнози — це статистичні ймовірності, а не гарантія. Навіть ставка з перевагою програє часто, і перевага проявляється лише на великій кількості ставок. Ставте лише ті гроші, які готові втратити. Якщо ставки перестали бути розвагою, зверніться по допомогу.</p>
      </section>`;

    document.getElementById('clear').onclick = () => {
      api.clearCache();
      state.models.clear();
      state.standings.clear();
      state.lineups.clear();
      state.teamStats.clear();
      document.getElementById('clear').textContent = 'Готово — дані завантажаться наново';
    };

    // Перехід до конкретного терміна (#/info/edge) — прокручуємо і підсвічуємо його.
    const el = focus && document.getElementById(`t-${focus}`);
    if (el) {
      const d = el.closest('details');
      if (d) d.open = true;
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -64);
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
  }

  // Маленьке посилання «?» на пояснення терміна в довідці.
  const help = id => `<a class="help" href="#/info/${id}" aria-label="Що це означає?">?</a>`;

  // ---------- Навігація ----------
  function route() {
    const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
    window.scrollTo(0, 0);
    switch (parts[0]) {
      case 'match': return viewMatch(parts[1], parts[2]);
      case 'leagues': return viewLeagues();
      case 'league': return viewLeague(parts[1]);
      case 'info': return viewInfo(parts[1]);
      case 'settings': return viewInfo();
      case 'history': return viewHistory();
      default: return viewHome();   // у т. ч. старі посилання #/express і #/live
    }
  }

  $view.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.vsel) {
      // Вибір цінних ставок для таблиці двійників.
      const id = b.dataset.vsel;
      if (state.valueSel.has(id)) state.valueSel.delete(id); else state.valueSel.add(id);
      saveValueSel();
      renderList();
    } else if (b.dataset.vselAll) {
      (state.valuePickable || []).forEach(id => state.valueSel.add(id));
      saveValueSel();
      renderList();
    } else if (b.dataset.vselNone) {
      state.valueSel.clear();
      saveValueSel();
      renderList();
    } else if (b.dataset.day) {
      state.dayOffset = Number(b.dataset.day);
      viewHome();
    } else if (b.dataset.league) {
      state.league = b.dataset.league;
      b.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
      renderList();
    }
  });

  document.getElementById('refresh').addEventListener('click', () => {
    const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
    if (!parts.length) {
      const rid = ++renderId;
      document.getElementById('status-line').textContent = 'Оновлення…';
      loadHome(rid, true, false);
    } else {
      route();
    }
  });
  $back.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));
  window.addEventListener('hashchange', route);

  // ---------- Автооновлення ----------
  let ticking = false;
  async function tick() {
    if (ticking || document.hidden) return;
    ticking = true;
    try {
      const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
      if (!parts.length) await loadHome(renderId, false, true);
      else if (parts[0] === 'match') await viewMatch(parts[1], parts[2], true);
    } finally {
      ticking = false;
    }
  }
  setInterval(tick, TICK);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  route();
})();
