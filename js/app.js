(() => {
  const { api, model, LEAGUES, LEAGUE_BY_SLUG } = FP;
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $back = document.getElementById('back');

  const state = {
    dayOffset: 0,
    league: 'all',
    sort: 'time',
    day: [],                   // [{ slug, ev }] — матчі обраного дня
    dayErrors: 0,
    events: new Map(),         // "slug/id" → { slug, ev } — для екрана матчу
    models: new Map(),         // slug → { m, sig } | { error }
    loading: new Map(),        // slug → Promise
    standings: new Map(),      // slug → рядки таблиці
    lineups: new Map(),        // id матчу → склади
    teamStats: new Map(),      // id команди → сезонна статистика (xG, кутові, картки)
    facts: new Map(),          // id матчу → рахунок 1-го тайму, кутові, картки (для розрахунку ставок)
    updatedAt: 0,
    valueInput: new Map(),     // id матчу → { market, odds } — щоб автооновлення не стирало введене
  };
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
    if (h.startsWith('#/express')) return 'express';
    if (h.startsWith('#/live')) return 'live';
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
        <div class="segmented small">
          <button class="${state.sort === 'time' ? 'on' : ''}" data-sort="time">За турнірами</button>
          <button class="${state.sort === 'conf' ? 'on' : ''}" data-sort="conf">Найкращі ставки</button>
          <button class="${state.sort === 'odds' ? 'on' : ''}" data-sort="odds">Кф 1.64–9.99</button>
        </div>
      </div>
      <div id="status-line" class="status-line"></div>
      <div id="list"><div class="loading">Завантаження матчів…</div></div>`;
    await loadHome(rid, false, false);
  }

  // silent — фонове автооновлення: без індикатора і без помилок на весь екран.
  async function loadHome(rid, force, silent) {
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
    const items = state.day
      .filter(x => state.league === 'all' || x.slug === state.league)
      .map(x => ({ ...x, pred: predictionFor(x.slug, x.ev) }));

    if (!items.length) {
      $list.innerHTML = `<div class="empty">На цей день матчів ${state.league === 'all' ? 'у вибраних турнірах' : 'в цьому турнірі'} немає.<br>Спробуйте інший день.</div>`;
      return;
    }

    let html = summary(items);
    if (state.sort === 'odds') {
      $list.innerHTML = oddsBandsHtml(items);
      return;
    }
    if (state.sort === 'conf') {
      const ranked = items
        .filter(x => x.pred && isUpcoming(x.ev))
        .sort((a, b) => b.pred.tip.conf.level - a.pred.tip.conf.level || b.pred.tip.p - a.pred.tip.p);
      const values = ranked.filter(x => x.pred.value).sort((a, b) => b.pred.value.edge - a.pred.value.edge);
      html += valueCard(values);
      html += accumulator(ranked);
      html += ranked.length
        ? `<div class="group">${ranked.map(x => matchCard(x, true)).join('')}</div>`
        : `<div class="empty">${items.some(x => x.pred === undefined) ? 'Аналіз ще триває…' : 'Немає майбутніх матчів з прогнозом.'}</div>`;
    } else {
      const groups = new Map();
      items
        .sort((a, b) => LEAGUE_BY_SLUG.get(a.slug).order - LEAGUE_BY_SLUG.get(b.slug).order || a.ev.ts - b.ev.ts)
        .forEach(x => {
          if (!groups.has(x.slug)) groups.set(x.slug, []);
          groups.get(x.slug).push(x);
        });
      for (const [slug, list] of groups) {
        const l = LEAGUE_BY_SLUG.get(slug);
        const entry = state.models.get(slug);
        html += `
          <div class="group">
            <a class="group-head" href="#/league/${slug}">
              <img src="${FP.leagueLogo(l)}" alt="">
              <span><b>${esc(l.name)}</b> · ${esc(l.country)}</span>
            </a>
            ${entry && entry.error ? errorBox(entry.error) : ''}
            ${list.map(x => matchCard(x, false)).join('')}
          </div>`;
      }
    }
    $list.innerHTML = html;
  }

  // Розділ «Кф 1.64–9.99»: для кожного матчу — рекомендація в трьох діапазонах коефіцієнтів.
  function oddsBandsHtml(items) {
    const list = items.filter(x => x.pred).sort((a, b) => a.ev.ts - b.ev.ts);
    if (!list.length) {
      return `<div class="empty">${items.some(x => x.pred === undefined) ? 'Аналіз ще триває…' : 'Немає матчів з прогнозом.'}</div>`;
    }
    const row = (b, ev) => {
      if (!b.pick) return `<div class="band-row empty-band"><span class="band-k">${b.lo}–${b.hi}</span><em>немає варіанта</em></div>`;
      const k = b.pick.odds || 1 / b.pick.p;
      const res = isFinished(ev) ? model.settle(b.pick.key, ev.home.score, ev.away.score) : undefined;
      return `
        <div class="band-row">
          <span class="band-k">${b.lo}–${b.hi}</span>
          <b>${esc(b.pick.short)}</b>
          <span class="band-p">${pct(b.pick.p)}</span>
          <span class="band-o">${k.toFixed(2)}<small>${b.pick.odds ? 'DK' : 'спр.'}</small></span>
          ${b.isValue ? '<span class="badge val-b">цінна</span>' : ''}
          ${res === true ? '<i class="ok">✓</i>' : res === false ? '<i class="bad">✗</i>' : res === null ? '↺' : ''}
        </div>`;
    };
    return `
      <p class="hint pad">Для кожного матчу — найімовірніший варіант у трьох діапазонах коефіцієнтів, а якщо кф букмекера (DraftKings) дає перевагу — цінна ставка. Кф «спр.» — справедливий: у букмекера буде на 5–8% нижчий. ${help('prob')}</p>
      ${list.map(({ slug, ev, pred }) => {
        const l = LEAGUE_BY_SLUG.get(slug);
        const showScore = ev.state !== 'pre';
        return `
          <section class="card band-card">
            <a class="band-head" href="#/match/${slug}/${ev.id}">
              <small>${esc(statusText(ev))} · <img src="${FP.leagueLogo(l)}" alt="">${esc(leagueLabel(slug))}</small>
              <span>${esc(ev.home.name)} — ${esc(ev.away.name)}${showScore ? ` <b>${ev.home.score ?? 0}:${ev.away.score ?? 0}</b>` : ''}</span>
            </a>
            ${pred.bands.map(b => row(b, ev)).join('')}
          </section>`;
      }).join('')}`;
  }

  // Перевірка моделі на вже зіграних сьогодні матчах.
  function summary(items) {
    const done = items.filter(x => x.pred && isFinished(x.ev));
    if (!done.length) return '';
    const hits = done.filter(x => x.pred.tip.hit(x.ev.home.score, x.ev.away.score)).length;
    return `<div class="summary">Влучність основних прогнозів у завершених матчах: <b>${hits} з ${done.length}</b></div>`;
  }

  function valueCard(values) {
    if (!values.length) return '';
    return `
      <section class="card acca">
        <div class="acca-head"><b>Цінні ставки ${help('value')}</b><span>ймовірність вища, ніж закладено в коефіцієнт</span></div>
        ${values.slice(0, 5).map(x => `<a class="acca-row" href="#/match/${x.slug}/${x.ev.id}">
          <span>${esc(x.ev.home.short || x.ev.home.name)} — ${esc(x.ev.away.short || x.ev.away.name)}</span>
          <b>${esc(x.pred.value.short)} @ ${x.pred.value.odds.toFixed(2)} · +${(x.pred.value.edge * 100).toFixed(0)}%</b></a>`).join('')}
      </section>`;
  }

  function accumulator(ranked) {
    const picks = ranked.filter(x => x.pred.tip.conf.level >= 2).slice(0, 3);
    if (picks.length < 2) return '';
    const p = picks.reduce((s, x) => s * x.pred.tip.p, 1);
    return `
      <section class="card acca">
        <div class="acca-head"><b>Експрес дня ${help('acca')}</b><span>ймовірність ${pct(p)} · справедливий кф ${fair(p)}</span></div>
        ${picks.map(x => `<div class="acca-row"><span>${esc(x.ev.home.short || x.ev.home.name)} — ${esc(x.ev.away.short || x.ev.away.name)}</span><b>${esc(x.pred.tip.short)}</b></div>`).join('')}
        <p class="hint">Кожна подія в експресі множить ризик. Ставте лише тоді, коли кф букмекера вищий за справедливий.</p>
        <a class="gloss-link" href="#/express">5 експресів з різним ризиком і конструктор →</a>
      </section>`;
  }

  function matchCard({ slug, ev, pred }, showLeague) {
    const showScore = ev.state !== 'pre';
    let predHtml;
    if (pred === undefined) predHtml = '<div class="pred-loading">аналіз…</div>';
    else if (!pred) predHtml = '<div class="pred-loading">недостатньо даних</div>';
    else {
      const p = pred.prob;
      const verdict = isFinished(ev) ? (pred.tip.hit(ev.home.score, ev.away.score) ? '<i class="ok">✓</i>' : '<i class="bad">✗</i>') : '';
      predHtml = `
        <div class="bar" aria-label="Ймовірності: П1 ${pct(p['1'])}, нічия ${pct(p.X)}, П2 ${pct(p['2'])}">
          <span class="b1" style="flex:${p['1']}">${pct(p['1'])}</span>
          <span class="bx" style="flex:${p.X}">${pct(p.X)}</span>
          <span class="b2" style="flex:${p['2']}">${pct(p['2'])}</span>
        </div>
        <div class="tip ${confClass(pred.tip.conf)}">${verdict}${esc(pred.tip.short)} · ${pct(pred.tip.p)}</div>`;
    }
    const l = LEAGUE_BY_SLUG.get(slug);
    const badges = isFinished(ev) ? '' : [
      (state.lineups.get(ev.id) || []).length ? '<span class="badge ok-b">склади</span>' : '',
      pred && pred.value ? '<span class="badge val-b">цінність</span>' : '',
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

  // Кнопка додавання ринку в купон експресу (лише для матчів, що ще не почались).
  const addBtn = (ev, key, label) => (isUpcoming(ev)
    ? `<button class="add ${label ? 'wide' : ''} ${FP.slip.has(ev.id, key) ? 'on' : ''}" data-add="${esc(key)}" ${label ? `data-label="${esc(label)}"` : ''} aria-label="Додати в експрес">${FP.slip.has(ev.id, key) ? '✓' : '+'}${label ? ` ${esc(label)}` : ''}</button>`
    : '');

  function refreshAddButtons() {
    const cm = state.currentMatch;
    if (!cm) return;
    document.querySelectorAll('[data-add]').forEach(b => {
      const on = FP.slip.has(cm.ev.id, b.dataset.add);
      b.classList.toggle('on', on);
      b.textContent = (on ? '✓' : '+') + (b.dataset.label ? ` ${b.dataset.label}` : '');
    });
  }

  function addFromMatch(key) {
    const cm = state.currentMatch;
    if (!cm) return;
    const mk = cm.pred.markets.find(x => x.key === key);
    if (!mk) return;
    const res = FP.slip.toggle({
      slug: cm.slug, id: cm.ev.id, ts: cm.ev.ts,
      home: cm.ev.home.short || cm.ev.home.name, away: cm.ev.away.short || cm.ev.away.name,
      key, short: mk.short, long: mk.long, p: mk.p, odds: mk.odds || null,
    });
    refreshAddButtons();
    toast({
      added: `Додано в експрес: ${mk.short}`,
      replaced: `Замінено в експресі на ${mk.short} — з одного матчу лише одна подія`,
      removed: `Прибрано з експресу: ${mk.short}`,
    }[res]);
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.innerHTML = `${esc(msg)} <a href="#/express">Купон →</a>`;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  function renderMatch(slug, ev, pred, lineups) {
    state.currentMatch = { slug, ev, pred };
    const l = LEAGUE_BY_SLUG.get(slug);
    const p = pred.prob;
    const showScore = ev.state !== 'pre';
    const withOdds = pred.markets.filter(x => x.odds).sort((a, b) => b.edge - a.edge);

    $view.innerHTML = `
      <section class="card hero">
        <div class="hero-meta"><img src="${FP.leagueLogo(l)}" alt="">${esc(l.name)}${ev.round ? ' · ' + esc(ev.round) : ''}</div>
        <div class="hero-teams">
          <div><img src="${esc(ev.home.logo)}" alt=""><b>${esc(ev.home.name)}</b></div>
          <div class="hero-score">${showScore ? `${ev.home.score ?? 0} : ${ev.away.score ?? 0}` : esc(timeOf(ev.ts))}<small>${esc(ev.state === 'pre' && isUpcoming(ev) ? dateOf(ev.ts) : statusText(ev))}</small></div>
          <div><img src="${esc(ev.away.logo)}" alt=""><b>${esc(ev.away.name)}</b></div>
        </div>
        <div class="xg">Очікувані голи: <b>${pred.lh.toFixed(2)}</b> : <b>${pred.la.toFixed(2)}</b> ${help('expgoals')}</div>
        <div class="bar big">
          <span class="b1" style="flex:${p['1']}">${pct(p['1'])}</span>
          <span class="bx" style="flex:${p.X}">${pct(p.X)}</span>
          <span class="b2" style="flex:${p['2']}">${pct(p['2'])}</span>
        </div>
        <div class="bar-legend"><span>П1 · кф ${fair(p['1'])}</span><span>Х · ${fair(p.X)}</span><span>П2 · ${fair(p['2'])}</span></div>
      </section>

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
        ${isUpcoming(ev) ? `<div class="btn-row">${addBtn(ev, pred.tip.key, 'в експрес')}</div>` : ''}
        <a class="gloss-link" href="#/info/markets">Що означають ТБ, ІТ, Ф1 та інші позначення →</a>
      </section>

      ${withOdds.length ? `
      <section class="card">
        <h3>Порівняння з букмекером${ev.odds && ev.odds.provider ? ` (${esc(ev.odds.provider)})` : ''}</h3>
        <table class="markets">
          <thead><tr><th>Ринок</th><th>Ймов.</th><th>Кф</th><th>Перевага ${help('edge')}</th></tr></thead>
          <tbody>${withOdds.map(x => {
            const good = x.edge >= 0.03 && x.p >= 0.30;
            return `
            <tr class="${good ? 'sel' : ''}"><td>${esc(x.short)}</td><td>${pct(x.p)}</td><td>${x.odds.toFixed(2)}</td>
              <td class="${good ? 'ok' : x.edge < 0 ? 'bad' : ''}">${x.edge > 0 ? '+' : ''}${(x.edge * 100).toFixed(1)}%</td></tr>`;
          }).join('')}
          </tbody>
        </table>
        <p class="hint">Перевага = ймовірність × кф − 1 — середній результат ставки на довгій дистанції: +8% означає в середньому +8 грн на кожні 100 грн ставок, −12% — у середньому −12 грн. Ринки з ймовірністю нижче 30% не рекомендуються навіть із перевагою: вони програють дуже часто, а невелика помилка прогнозу легко «з'їдає» перевагу.</p>
      </section>` : ''}

      <section class="card">
        <h3>Чому так</h3>
        <ul class="reasons">${pred.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </section>

      ${squads(ev, lineups)}

      <section class="card">
        <h3>Калькулятор для свого букмекера</h3>
        <p class="hint">Введіть коефіцієнт вашої букмекерської контори, і додаток покаже, чи вигідна ставка.</p>
        <div class="value-form">
          <select id="v-market">${pred.markets.map(x => `<option value="${x.key}" ${x.key === pred.tip.key ? 'selected' : ''}>${esc(x.long)} (${pct(x.p)})</option>`).join('')}</select>
          <input id="v-odds" type="number" inputmode="decimal" step="0.01" min="1.01" placeholder="кф">
        </div>
        <div id="v-out" class="value-out"></div>
      </section>

      <section class="card">
        <h3>Найкращі варіанти по ринках</h3>
        <div class="picks">${pred.groups.filter(g => g.pick).map(g => `
          <div class="pick"><span>${esc(g.name)}</span><b>${esc(g.pick.short)}</b><i>${pct(g.pick.p)} · кф ${fair(g.pick.p)}</i>${addBtn(ev, g.pick.key)}</div>`).join('')}
        </div>
        <p class="hint">Найімовірніший варіант у кожній групі з ймовірністю 55–85%. Кутові й картки — орієнтовна оцінка за сезонною статистикою команд.</p>
      </section>

      <section class="card">
        <h3>Усі ринки</h3>
        ${pred.groups.map((g, i) => `
          <details class="mgroup" ${i === 0 ? 'open' : ''}>
            <summary>${esc(g.name)}<span>${g.list.length}</span></summary>
            <table class="markets">
              <tbody>${g.list.map(x => `
                <tr class="${x.key === pred.tip.key ? 'sel' : ''}"><td>${esc(x.long)}</td>
                  <td><div class="pbar"><i style="width:${(x.p * 100).toFixed(1)}%"></i><span>${pct(x.p)}</span></div></td>
                  <td>${fair(x.p)}</td><td class="add-cell">${addBtn(ev, x.key)}</td></tr>`).join('')}
              </tbody>
            </table>
          </details>`).join('')}
        <p class="hint">Праворуч — справедливий коефіцієнт (без маржі). Ставка вигідна, якщо букмекер дає більше.</p>
      </section>

      <section class="card">
        <h3>Найімовірніші рахунки</h3>
        <div class="scores">${pred.scores.map(s => `<div><b>${s.h}:${s.a}</b><span>${pct(s.p)}</span></div>`).join('')}</div>
      </section>

      <section class="card">
        <h3>Порівняння команд</h3>
        ${compare(slug, ev, pred.home, pred.away)}
        <p class="hint">Індекси з урахуванням сили суперників: 1.00 — середній рівень турніру. Атака вище за 1 — краще за середнє, оборона нижче за 1 — краще за середнє.${LEAGUE_BY_SLUG.get(slug).cup ? ' Статистика за гру — з матчів у своєму чемпіонаті.' : ''}</p>
      </section>`;

    const $m = document.getElementById('v-market'), $o = document.getElementById('v-odds'), $out = document.getElementById('v-out');
    const saved = state.valueInput.get(ev.id);
    if (saved) { $m.value = saved.market; $o.value = saved.odds; }
    const recalc = () => {
      state.valueInput.set(ev.id, { market: $m.value, odds: $o.value });
      const mk = pred.markets.find(x => x.key === $m.value);
      const v = model.value(mk.p, parseFloat(String($o.value).replace(',', '.')));
      if (!v) { $out.innerHTML = `Справедливий кф для цього ринку: <b>${fair(mk.p)}</b>`; return; }
      $out.innerHTML = v.edge > 0
        ? `<span class="ok">Є цінність: перевага +${(v.edge * 100).toFixed(1)}%.</span> Розмір ставки: до <b>${(v.kelly * 100).toFixed(1)}%</b> банку (¼ Келлі).`
        : `<span class="bad">Ставка невигідна: ${(v.edge * 100).toFixed(1)}%.</span> Краще пропустити.`;
    };
    $m.addEventListener('change', recalc);
    $o.addEventListener('input', recalc);
    recalc();
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

  // ---------- Експреси ----------
  // 11 слотів готових експресів: кількість подій n і цільовий кф у межах [lo, hi].
  // Ймовірність окремої події підбирається так, щоб за n подій вийти на цільовий кф.
  // Експрес у слоті не змінюється, доки не завершиться його перша подія; тоді він іде
  // в статистику, а в слоті з'являється новий.
  const ACCA_SLOTS = [
    { slot: 'L1', cat: 'levels',  name: 'Надійний',      risk: 1, n: 3, target: 2,   lo: 1.8, hi: 2.5 },
    { slot: 'L2', cat: 'levels',  name: 'Помірний',      risk: 2, n: 4, target: 3.5, lo: 3,   hi: 4.5 },
    { slot: 'L3', cat: 'levels',  name: 'Збалансований', risk: 3, n: 5, target: 6,   lo: 5,   hi: 8 },
    { slot: 'L4', cat: 'levels',  name: 'Ризикований',   risk: 4, n: 5, target: 10,  lo: 8.5, hi: 13 },
    { slot: 'L5', cat: 'levels',  name: 'Високий ризик', risk: 5, n: 6, target: 22,  lo: 20,  hi: 35 },
    { slot: 'D1', cat: 'doubles', name: 'Дубль · кф ~3.5', n: 2, target: 3.5, lo: 3,  hi: 4.2 },
    { slot: 'D2', cat: 'doubles', name: 'Дубль · кф ~5',   n: 2, target: 5,   lo: 4.2, hi: 6 },
    { slot: 'D3', cat: 'doubles', name: 'Дубль · кф ~7',   n: 2, target: 7,   lo: 6,  hi: 8 },
    { slot: 'T1', cat: 'triples', name: 'Трійник · кф ~10', n: 3, target: 10, lo: 8,  hi: 12 },
    { slot: 'T2', cat: 'triples', name: 'Трійник · кф ~15', n: 3, target: 15, lo: 12, hi: 18 },
    { slot: 'T3', cat: 'triples', name: 'Трійник · кф ~22', n: 3, target: 22, lo: 18, hi: 25 },
  ];
  const ACCA_CATS = { levels: 'Рівні ризику', doubles: 'З 2 подій · кф 3–8', triples: 'З 3 подій · кф 8–25' };
  // Ринки для експресів: лише основні, без таймів, кутових і карток (там модель орієнтовна).
  const ACCA_GROUPS = new Set(['Результат', 'Тотал голів', 'Обидві заб\'ють', 'Фори', 'Індивідуальні тотали', 'Комбіновані']);
  const ACCA_EXCLUDE = new Set(['12', 'DNB1', 'DNB2', 'O05', 'HO05', 'AO05']);

  const legOdds = l => (l.userOdds > 1 ? l.userOdds : l.odds > 1 ? l.odds : null);

  const isAccaMarket = m => ACCA_GROUPS.has(m.group) && !ACCA_EXCLUDE.has(m.key);

  // used.events — події (матч + ринок), уже зайняті в інших експресах: повторювати їх не можна.
  // used.matches — матчі, що вже трапляються: можна, але з невеликим штрафом заради різноманітності.
  const eventKey = (id, key) => `${id}:${key}`;
  const usable = (m, ev, used) => isAccaMarket(m) && m.p >= 0.3 && m.p <= 0.9 && !used.events.has(eventKey(ev.id, m.key));
  const penalty = (pred, ev, used) => (pred.lowData ? 0.5 : 0) + (used.matches.has(ev.id) ? 0.3 : 0);

  const toLeg = ({ slug, ev, m }) => ({
    slug, id: ev.id, ts: ev.ts, home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
    key: m.key, short: m.short, long: m.long, p: m.p, odds: m.odds || null,
  });

  // Рівень ризику за загальною ймовірністю експресу.
  const riskOf = p => (p >= 0.4 ? 1 : p >= 0.25 ? 2 : p >= 0.15 ? 3 : p >= 0.08 ? 4 : 5);

  function markUsed(legs, used) {
    for (const l of legs) { used.events.add(eventKey(l.id, l.key)); used.matches.add(l.id); }
  }

  // Експрес з n подій із різних матчів, загальний кф у межах [lo, hi] і якнайближче до target.
  // Перші n−1 подій — з ймовірністю, близькою до потрібної (з бонусом за перевагу над букмекером),
  // остання — та, що доводить загальний кф до цілі.
  function buildAcca(pool, used, cfg) {
    const { n, target, lo, hi } = cfg;
    const ideal = Math.pow(target, -1 / n);
    const chosen = [];
    let odds = 1;
    for (let i = 0; i < n - 1; i++) {
      let best = null;
      for (const { slug, ev, pred } of pool) {
        if (chosen.some(c => c.ev.id === ev.id)) continue;
        for (const m of pred.markets) {
          if (!usable(m, ev, used)) continue;
          const score = -Math.abs(m.p - ideal) + Math.max(0, m.edge || 0) - penalty(pred, ev, used);
          if (!best || score > best.score) best = { slug, ev, m, score };
        }
      }
      if (!best) return null;
      chosen.push(best);
      odds /= best.m.p;
    }
    let last = null;
    for (const { slug, ev, pred } of pool) {
      if (chosen.some(c => c.ev.id === ev.id)) continue;
      for (const m of pred.markets) {
        if (!usable(m, ev, used)) continue;
        const total = odds / m.p;
        if (total < lo || total > hi) continue;
        const score = -2 * Math.abs(Math.log(total / target)) + Math.max(0, m.edge || 0) - penalty(pred, ev, used);
        if (!last || score > last.score) last = { slug, ev, m, score };
      }
    }
    if (!last) return null;
    chosen.push(last);
    const legs = chosen.sort((a, b) => a.ev.ts - b.ev.ts).map(toLeg);
    const p = legs.reduce((s, l) => s * l.p, 1);
    return {
      id: `${cfg.slot}-${Date.now()}`, slot: cfg.slot, cat: cfg.cat, title: cfg.name,
      risk: cfg.risk || riskOf(p), createdAt: Date.now(), p, fair: 1 / p, legs,
    };
  }

  // ---------- статус подій і експресів ----------
  const VOID_STATUS = /POSTPONED|CANCELED|ABANDONED/;

  // Статус події за даними сезону: pending / live / win / loss / void / unknown.
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

  // Підсумок експресу: програш, якщо програла хоч одна подія; виграш, коли решта зіграли.
  function accaStatus(a) {
    const st = a.legs.map(legStatus);
    const live = a.legs.filter((l, i) => st[i].s !== 'void');
    const p = live.reduce((s, l) => s * l.p, 1);
    let s = 'pending';
    if (st.some(x => x.s === 'loss')) s = 'loss';
    else if (st.every(x => x.s === 'win' || x.s === 'void')) s = st.some(x => x.s === 'win') ? 'win' : 'void';
    return { s, legs: st, p, fair: 1 / p, wins: st.filter(x => x.s === 'win').length, settledLegs: st.filter(x => x.s === 'win' || x.s === 'loss').length };
  }

  const firstLegDone = a => ['win', 'loss', 'void', 'unknown'].includes(legStatus(a.legs[0]).s);

  const STATUS_ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '↺', unknown: '?', nodata: '…' };
  const ACCA_STATUS = {
    pending: ['в грі', ''], win: ['зайшов', 'win'], loss: ['не зайшов', 'loss'], void: ['повернення', ''],
  };

  // Країна й турнір події: «Данія · Суперліга», «УЄФА · Ліга чемпіонів».
  const leagueLabel = slug => {
    const l = LEAGUE_BY_SLUG.get(slug);
    return l ? `${l.country} · ${l.name}` : '';
  };

  function accaTotals(legs) {
    const live = legs.filter(l => l.ts * 1000 > Date.now());
    const p = live.reduce((s, l) => s * l.p, 1);
    const allOdds = live.length && live.every(l => legOdds(l));
    const odds = allOdds ? live.reduce((s, l) => s * legOdds(l), 1) : null;
    return { n: live.length, started: legs.length - live.length, p, fair: 1 / p, odds, edge: odds ? p * odds - 1 : null };
  }

  const riskDots = r => `<span class="risk r${r}">${'●'.repeat(r)}${'○'.repeat(5 - r)}</span>`;

  // st — статус події (для готових експресів): показуємо рахунок і ✓/✗ замість кф.
  function legRow(l, editable, st) {
    const started = l.ts * 1000 <= Date.now();
    const done = st && st.s !== 'pending';
    const right = done
      ? `<div class="leg-num leg-st"><b>${st.s === 'live' ? `<span class="live">LIVE</span>` : STATUS_ICON[st.s]}</b><small>${esc(st.score || '')}</small></div>`
      : `<div class="leg-num"><b>${l.odds ? l.odds.toFixed(2) : '—'}</b><small>кф DK</small></div>`;
    return `
      <div class="leg ${started && editable ? 'started' : ''} ${st ? `st-${st.s}` : ''}">
        <a href="#/match/${l.slug}/${l.id}" class="leg-main">
          <small>${esc(dateOf(l.ts))} ${esc(timeOf(l.ts))}${started && editable ? ' · матч почався' : ''}</small>
          <em class="leg-league"><img src="${FP.leagueLogo(LEAGUE_BY_SLUG.get(l.slug))}" alt="">${esc(leagueLabel(l.slug))}</em>
          <span>${esc(l.home)} — ${esc(l.away)}</span>
          <b>${esc(l.short)}</b>
        </a>
        <div class="leg-num"><b>${pct(l.p)}</b><small>спр. ${fair(l.p)}</small></div>
        ${editable ? `
          <input class="leg-odds" data-odds="${esc(l.id)}" type="number" inputmode="decimal" step="0.01" min="1.01" placeholder="кф" value="${legOdds(l) ? legOdds(l).toFixed(2) : ''}">
          <button class="leg-x" data-remove="${esc(l.id)}" aria-label="Прибрати">✕</button>` : right}
      </div>`;
  }

  function slipTotalsHtml() {
    const t = accaTotals(FP.slip.all());
    if (!t.n) return '<p class="hint">Немає подій, що ще не почались.</p>';
    const v = t.odds ? model.value(t.p, t.odds) : null;
    return `
      <div class="totals">
        <div><span>Подій</span><b>${t.n}</b></div>
        <div><span>Ймовірність</span><b>${t.p >= 0.01 ? pct(t.p) : '<1%'}</b></div>
        <div><span>Справедливий кф</span><b>${t.fair.toFixed(2)}</b></div>
        <div><span>Ваш кф</span><b>${t.odds ? t.odds.toFixed(2) : '—'}</b></div>
      </div>
      ${v ? `<p class="value-out">${v.edge > 0
        ? `<span class="ok">Експрес вигідний: перевага +${(v.edge * 100).toFixed(1)}%.</span> Розмір ставки: до <b>${(v.kelly * 100).toFixed(1)}%</b> банку.`
        : `<span class="bad">Експрес невигідний: ${(v.edge * 100).toFixed(1)}%.</span> Кф букмекера нижчий за справедливий.`}</p>`
        : '<p class="hint">Введіть коефіцієнти свого букмекера для кожної події, щоб перевірити, чи вигідний експрес. Там, де є, підставлено кф DraftKings.</p>'}
      ${t.started ? `<p class="hint">Подій, що вже почались: ${t.started}. Вони не враховуються.</p>` : ''}`;
  }

  function renderSlip() {
    const $s = document.getElementById('slip');
    if (!$s) return;
    const legs = FP.slip.all().sort((a, b) => a.ts - b.ts);
    $s.innerHTML = legs.length ? `
      <div class="legs">${legs.map(l => legRow(l, true)).join('')}</div>
      <div id="slip-totals">${slipTotalsHtml()}</div>
      <div class="btn-row"><button class="btn ghost" data-slip-clear="1">Очистити купон</button></div>` : `
      <p class="hint top">Купон порожній. Додавайте події кнопкою <b>+</b> на екрані матчу (у рекомендованій ставці, найкращих варіантах або в «Усіх ринках») чи завантажте готовий експрес нижче.</p>`;
  }

  async function viewExpress() {
    const rid = ++renderId;
    setHeader('Експреси');
    $view.innerHTML = `
      <section class="card">
        <h3>Мій експрес ${help('acca')}</h3>
        <div id="slip"></div>
      </section>
      <h2 class="section-title">Готові експреси на 3 дні</h2>
      <div id="accas"><div class="loading">Аналіз матчів найближчих днів…</div></div>`;
    renderSlip();

    // Матчі на 3 дні, моделі, статистика — усе з кешу, якщо вже завантажувалось.
    const days = await Promise.all([0, 1, 2].map(o => loadDay(o, false)));
    if (rid !== renderId) return;
    const items = days.flatMap(d => d.items).filter(x => isUpcoming(x.ev) && x.ev.ts * 1000 > Date.now() + 5 * MIN);

    // Моделі (а з ними й результати сезону) — для майбутніх матчів і для подій активних експресів.
    let active = FP.history.activeAccas();
    const slugs = [...new Set([...items.map(x => x.slug), ...Object.values(active).flatMap(a => a.legs.map(l => l.slug))])]
      .filter(s => LEAGUE_BY_SLUG.has(s));
    for (const slug of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) {
      await ensureModel(slug);
      if (rid !== renderId) return;
    }
    await loadTeamStats(items);
    if (rid !== renderId) return;

    // Експреси, у яких завершилась перша подія, ідуть у статистику; на їхнє місце — нові.
    for (const cfg of ACCA_SLOTS) {
      if (active[cfg.slot] && firstLegDone(active[cfg.slot])) FP.history.retire(cfg.slot);
    }
    active = FP.history.activeAccas();
    const used = { events: new Set(), matches: new Set() };
    Object.values(active).forEach(a => markUsed(a.legs, used));
    const pool = items.map(x => ({ ...x, pred: predictionFor(x.slug, x.ev) })).filter(x => x.pred);
    for (const cfg of ACCA_SLOTS) {
      if (active[cfg.slot]) continue;
      const a = buildAcca(pool, used, cfg);
      if (!a) continue;
      markUsed(a.legs, used);
      FP.history.setActive(cfg.slot, a);
      active[cfg.slot] = a;
    }
    state.accas = ACCA_SLOTS.map(cfg => active[cfg.slot] || null);

    const card = (cfg, i) => {
      const a = active[cfg.slot];
      if (!a) {
        return `<section class="card acca-card"><div class="acca-title">${cfg.risk ? riskDots(cfg.risk) : ''}<b>${esc(cfg.name)}</b></div>
          <p class="hint">Недостатньо відповідних матчів на найближчі 3 дні.</p></section>`;
      }
      const st = accaStatus(a);
      const [label, cls] = ACCA_STATUS[st.s];
      const first = a.legs[0];
      const bookOdds = a.legs.every(l => l.odds) ? a.legs.reduce((s, l) => s * l.odds, 1) : null;
      return `
        <section class="card acca-card">
          <div class="acca-title">${riskDots(a.risk)}<b>${esc(a.title)}</b><span>кф ${a.fair.toFixed(2)}</span></div>
          <div class="acca-sub">Ймовірність ${a.p >= 0.01 ? pct(a.p) : '<1%'} · подій ${a.legs.length}${bookOdds ? ` · за кф DraftKings ${bookOdds.toFixed(2)}` : ''}
            <span class="chip-st ${cls}">${label}${st.settledLegs ? ` · ${st.wins}/${a.legs.length}` : ''}</span></div>
          <div class="legs">${a.legs.map((l, j) => legRow(l, false, st.legs[j])).join('')}</div>
          <p class="hint">Новий експрес у цьому пункті з'явиться після завершення першої події: ${esc(first.home)} — ${esc(first.away)}, ${esc(dateOf(first.ts))} ${esc(timeOf(first.ts))}.</p>
          ${a.legs.some(l => l.ts * 1000 > Date.now()) ? `<div class="btn-row"><button class="btn ghost" data-load-acca="${i}">Завантажити в конструктор</button></div>` : ''}
        </section>`;
    };

    let html = '';
    for (const [cat, title] of Object.entries(ACCA_CATS)) {
      html += `<h2 class="section-title">${esc(title)}</h2>`;
      ACCA_SLOTS.forEach((cfg, i) => { if (cfg.cat === cat) html += card(cfg, i); });
    }
    document.getElementById('accas').innerHTML = html + `
      <p class="hint pad">Події (матч + ставка) в 11 експресах не повторюються; один матч може траплятися з різними ставками. Коефіцієнт — справедливий (без маржі): букмекер на кожну подію дає на 5–8% менше. Ймовірність показує, як часто такий експрес заходить: 5% — приблизно раз на 20 спроб. Результати всіх експресів — у вкладці «Історія».</p>`;
  }

  // Події купону: видалення, введення кф, очищення, завантаження готового експресу.
  $view.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove) { FP.slip.remove(b.dataset.remove); renderSlip(); }
    else if (b.dataset.slipClear) { FP.slip.clear(); renderSlip(); }
    else if (b.dataset.loadAcca != null && state.accas && state.accas[Number(b.dataset.loadAcca)]) {
      FP.slip.setAll(state.accas[Number(b.dataset.loadAcca)].legs.filter(l => l.ts * 1000 > Date.now()));
      renderSlip();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Експрес завантажено в конструктор');
    }
  });
  $view.addEventListener('input', e => {
    const id = e.target.dataset && e.target.dataset.odds;
    if (!id) return;
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    FP.slip.setOdds(id, v > 1 ? v : null);
    const $t = document.getElementById('slip-totals');
    if ($t) $t.innerHTML = slipTotalsHtml();
  });

  function updateSlipBadge() {
    const $c = document.getElementById('slip-count');
    if (!$c) return;
    const n = FP.slip.all().length;
    $c.textContent = n;
    $c.hidden = !n;
  }
  FP.slip.onChange(updateSlipBadge);
  updateSlipBadge();

  // ---------- Лайв: матчі в перерві ----------
  const isHalftime = ev => ev.state === 'in' && /HALFTIME/.test(ev.status);
  state.liveK2 = true;   // показувати лише ринки з кф від 2.00

  async function viewLive(silent = false) {
    const rid = silent ? renderId : ++renderId;
    if (!silent) {
      setHeader('Лайв');
      $view.innerHTML = '<div class="loading">Пошук матчів у перерві…</div>';
    }
    const boards = await api.pool(LEAGUES, 6, async l => {
      try { return (await api.liveBoard(l.slug)).events.map(ev => ({ slug: l.slug, ev })); } catch { return []; }
    });
    if (rid !== renderId) return;
    const all = boards.flat();
    all.forEach(x => state.events.set(evKey(x.slug, x.ev.id), x));
    const halftime = all.filter(x => isHalftime(x.ev));
    const playing = all.filter(x => isLive(x.ev) && !isHalftime(x.ev)).sort((a, b) => a.ev.ts - b.ev.ts);
    const soon = all.filter(x => isUpcoming(x.ev) && x.ev.ts * 1000 > Date.now() && x.ev.ts * 1000 - Date.now() < 8 * 3600e3)
      .sort((a, b) => a.ev.ts - b.ev.ts);

    // Аналіз кожного матчу в перерві: передматчевий прогноз + статистика 1-го тайму.
    const analyses = [];
    const slugs = [...new Set(halftime.map(x => x.slug))];
    for (const slug of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) {
      await ensureModel(slug);
      if (rid !== renderId) return;
    }
    await loadTeamStats(halftime);
    for (const x of halftime) {
      const entry = state.models.get(x.slug);
      if (!entry || entry.error) continue;
      const ctx = ctxFor(x.ev);
      const pre = model.predict(entry.m, x.ev, ctx);
      if (!pre) continue;
      let ls;
      try { ls = await api.liveStats(x.slug, x.ev.id); } catch { continue; }
      if (rid !== renderId) return;
      const h = ls.home.score ?? x.ev.home.score ?? 0, a = ls.away.score ?? x.ev.away.score ?? 0;
      const an = model.liveAnalysis({ lh: pre.lh, la: pre.la }, { h, a, home: ls.home, away: ls.away }, ctx);
      FP.history.recordLive(x.slug, x.ev, { home: h, away: a }, an.recs);
      analyses.push({ ...x, ls, h, a, an });
    }
    state.liveData = { analyses, playing, soon, at: Date.now() };
    renderLive();
  }

  function renderLive() {
    const { analyses, playing, soon, at } = state.liveData;
    const k2 = m => !state.liveK2 || 1 / m.p >= 2;
    const statRow = (label, h, a, suffix = '') => `<tr><td>${h ?? '—'}${h != null ? suffix : ''}</td><th>${label}</th><td>${a ?? '—'}${a != null ? suffix : ''}</td></tr>`;
    const card = ({ slug, ev, ls, h, a, an }) => `
      <section class="card live-card">
        <a class="band-head" href="#/match/${slug}/${ev.id}">
          <small><img src="${FP.leagueLogo(LEAGUE_BY_SLUG.get(slug))}" alt="">${esc(leagueLabel(slug))}</small>
        </a>
        <div class="live-score">
          <span>${esc(ev.home.name)}</span><b>${h}:${a}</b><span>${esc(ev.away.name)}</span>
        </div>
        <div class="live-status">Перерва</div>
        <table class="compare live-stats"><tbody>
          ${statRow('Удари', ls.home.shots, ls.away.shots)}
          ${statRow('У площину', ls.home.sot, ls.away.sot)}
          ${statRow('Володіння', ls.home.poss != null ? Math.round(ls.home.poss) : null, ls.away.poss != null ? Math.round(ls.away.poss) : null, '%')}
          ${statRow('Кутові', ls.home.corners, ls.away.corners)}
          ${statRow('Жовті', ls.home.yellow, ls.away.yellow)}
          ${(ls.home.red || ls.away.red) ? statRow('Червоні', ls.home.red, ls.away.red) : ''}
        </tbody></table>
        <h3>Рекомендації на 2-й тайм · кф від 2.00</h3>
        <div class="live-recs">${an.recs.length ? an.recs.map(m => `
          <div class="live-rec"><span>${esc(m.group)}</span><b>${esc(m.long)}</b><i>${pct(m.p)} · кф ${fair(m.p)}</i></div>`).join('')
          : '<p class="hint">Немає ринків з кф від 2.00.</p>'}</div>
        <h3>Аналіз</h3>
        <ul class="reasons">${an.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        <details class="mgroup live-all">
          <summary>Усі ринки${state.liveK2 ? ' з кф від 2.00' : ''}<span>${an.markets.filter(k2).length}</span></summary>
          ${Object.values(an.groups).map(g => {
            const list = an.markets.filter(m => m.group === g && k2(m));
            return list.length ? `<div class="live-group">${esc(g)}</div>
              <table class="markets"><tbody>${list.map(m => `
                <tr><td>${esc(m.long)}</td>
                  <td><div class="pbar"><i style="width:${(m.p * 100).toFixed(1)}%"></i><span>${pct(m.p)}</span></div></td>
                  <td><b>${fair(m.p)}</b></td></tr>`).join('')}</tbody></table>` : '';
          }).join('')}
        </details>
      </section>`;

    $view.innerHTML = `
      <div class="live-top">
        <span>Оновлено о ${timeOf(at / 1000)} · щохвилини</span>
        <label class="switch"><input type="checkbox" id="live-k2" ${state.liveK2 ? 'checked' : ''}> лише кф ≥ 2.00</label>
      </div>
      ${analyses.length ? analyses.map(card).join('') : `
        <section class="card">
          <h3>Зараз немає матчів у перерві</h3>
          <p class="hint">Розділ показує матчі лише під час перерви: тоді вже відома статистика 1-го тайму, а 2-й ще попереду. Сторінка оновлюється щохвилини — відкрийте її під час перерви.</p>
        </section>`}
      ${playing.length ? `<h2 class="section-title">Зараз ідуть</h2>
        <section class="card">${playing.map(({ slug, ev }) => `
          <a class="hrow" href="#/match/${slug}/${ev.id}">
            <div class="hrow-main"><small>${esc(leagueLabel(slug))}</small><span>${esc(ev.home.name)} — ${esc(ev.away.name)} <b>${ev.home.score ?? 0}:${ev.away.score ?? 0}</b></span></div>
            <div class="hrow-st"><span class="live">${esc(ev.clock || '')}</span></div>
          </a>`).join('')}</section>` : ''}
      ${soon.length ? `<h2 class="section-title">Найближчі матчі</h2>
        <section class="card">${soon.slice(0, 20).map(({ slug, ev }) => `
          <a class="hrow" href="#/match/${slug}/${ev.id}">
            <div class="hrow-main"><small>${esc(leagueLabel(slug))}</small><span>${esc(ev.home.name)} — ${esc(ev.away.name)}</span></div>
            <div class="hrow-st"><small class="soon">${esc(timeOf(ev.ts))}<br>перерва ≈ ${esc(timeOf(ev.ts + 47 * 60))}</small></div>
          </a>`).join('')}</section>` : ''}
      <p class="hint pad">Живих коефіцієнтів у безкоштовних даних немає, тож показано справедливий кф за нашою ймовірністю: «кф від 2.00» = ймовірність до 50%. У лайві букмекер зазвичай дає на 5–10% менше. Прогноз 2-го тайму поєднує передматчеву силу команд зі статистикою 1-го тайму, рахунком і вилученнями. ${help('fair')}</p>`;

    const $k2 = document.getElementById('live-k2');
    if ($k2) $k2.onchange = () => { state.liveK2 = $k2.checked; renderLive(); };
  }

  // ---------- Статистика прогнозів ----------
  // Одиночні: основна рекомендація і цінна ставка кожного матчу (останній прогноз перед стартом).
  // Експреси: усі 11 готових експресів — активні й замінені.
  state.histTab = 'singles';
  state.histPeriod = 30;

  async function viewHistory() {
    const rid = ++renderId;
    setHeader('Статистика');
    $view.innerHTML = '<div class="loading">Перевірка результатів…</div>';

    // Відтворюємо прогнози для зіграних з дня запуску матчів, яких немає в журналі.
    await backfill(rid);
    if (rid !== renderId) return;

    const singles = FP.history.all();
    const accas = [...FP.history.archivedAccas(), ...Object.values(FP.history.activeAccas())];
    const lives = FP.history.allLive();
    if (!singles.length && !accas.length && !lives.length) {
      $view.innerHTML = `<div class="empty">Статистика поки порожня.<br>Додаток запам'ятовує свої прогнози й експреси перед матчами, а після матчів показує тут, скільки з них зіграло.</div>`;
      return;
    }

    // Результати матчів беремо з даних сезонів відповідних турнірів.
    const slugs = [...new Set([...singles.map(e => e.slug), ...lives.map(e => e.slug), ...accas.flatMap(a => a.legs.map(l => l.slug))])]
      .filter(s => LEAGUE_BY_SLUG.has(s));
    await api.pool(slugs, 4, async slug => {
      try {
        const s = await api.season(slug);
        s.events.forEach(ev => state.events.set(evKey(slug, ev.id), { slug, ev }));
      } catch {}
    });
    if (rid !== renderId) return;

    // Для ставок на тайми, кутові й картки потрібні факти матчу (рахунок 1-го тайму, статистика).
    const FACT_GROUPS = new Set(['Тайми', 'Кутові', 'Жовті картки']);
    const LIVE_FACT_GROUPS = new Set(['Кутові', 'Жовті картки']);
    const needFacts = [
      ...singles.filter(e => (e.picks || []).some(p => FACT_GROUPS.has(p.group))),
      ...lives.filter(e => e.picks.some(p => LIVE_FACT_GROUPS.has(p.group))),
    ].filter(e => {
      const x = state.events.get(evKey(e.slug, e.id));
      return x && isFinished(x.ev) && !state.facts.has(e.id);
    }).sort((a, b) => b.ts - a.ts).slice(0, 200);
    if (needFacts.length) {
      $view.innerHTML = `<div class="loading">Завантаження статистики матчів (${needFacts.length})…</div>`;
      await api.pool(needFacts, 4, async e => {
        try { state.facts.set(e.id, await api.matchFacts(e.slug, e.id)); } catch {}
      });
      if (rid !== renderId) return;
    }
    state.hist = { singles, accas, lives };
    renderHistory();
  }

  // Статус лайв-ставки за фінальним рахунком (і кутовими/картками матчу).
  function liveStatus(e, key) {
    const x = state.events.get(evKey(e.slug, e.id));
    const ev = x && x.ev;
    if (!ev) return { s: e.ts * 1000 + 4 * 3600e3 < Date.now() ? 'unknown' : 'pending' };
    if (VOID_STATUS.test(ev.status)) return { s: 'void' };
    if (!isFinished(ev)) return { s: isLive(ev) ? 'live' : 'pending' };
    const f = state.facts.get(e.id);
    const r = model.liveSettle(key, { home: ev.home.score, away: ev.away.score }, e.ht, f && f.box);
    const score = `${ev.home.score}:${ev.away.score}`;
    if (r === undefined) return { s: 'nodata', score };
    return { s: r === true ? 'win' : r === false ? 'loss' : 'void', score };
  }

  function liveRows() {
    return state.hist.lives.filter(e => inPeriod(e.ts)).map(e => ({
      ...e, items: e.picks.map(p => ({ ...p, st: liveStatus(e, p.key) })),
    })).sort((a, b) => b.ts - a.ts);
  }

  function liveHistHtml() {
    const rows = liveRows();
    const done = rows.flatMap(r => r.items).filter(x => DONE(x.st.s));
    const wins = done.filter(x => x.st.s === 'win').length;
    const profit = done.reduce((s, x) => s + (x.st.s === 'win' ? x.k - 1 : -1), 0);
    const exp = done.length ? done.reduce((s, x) => s + x.p, 0) / done.length : null;
    const groups = [...new Set(done.map(x => x.group))].map(g => {
      const list = done.filter(x => x.group === g);
      return rateRow(g, list.filter(x => x.st.s === 'win').length, list.length, list.reduce((s, x) => s + x.p, 0) / list.length);
    }).join('');
    const byDay = new Map();
    for (const r of rows) {
      const d = dateOf(r.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const days = [...byDay].map(([d, list]) => `
      <div class="day-head"><b>${esc(d)}</b></div>
      ${list.map(r => `
        <a class="hrow" href="#/match/${r.slug}/${r.id}">
          <div class="hrow-main">
            <small>${esc(leagueLabel(r.slug))} · перерва ${r.ht.home}:${r.ht.away}</small>
            <span>${esc(r.home)} — ${esc(r.away)} ${r.items[0].st.score ? `<b>${esc(r.items[0].st.score)}</b>` : ''}</span>
            <div class="pchips">${r.items.map(x => `<span class="pchip ${x.st.s}">${esc(x.short)} @${x.k.toFixed(2)} ${STATUS_ICON[x.st.s] || ''}</span>`).join('')}</div>
          </div>
        </a>`).join('')}`).join('');
    return `
      <section class="card">
        <div class="kpis">
          <div><b>${pctOf(wins, done.length)}</b><span>зіграло<br>${wins} з ${done.length}</span></div>
          <div><b>${exp != null ? Math.round(exp * 100) + '%' : '—'}</b><span>очікувалось<br>за прогнозом</span></div>
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${done.length ? units(profit) : '—'}</b><span>прибуток, од.<br>за справедливим кф</span></div>
        </div>
        <p class="hint">Записуються 3 рекомендації з кф від 2.00, зроблені під час перерви, коли ви відкривали розділ «Лайв». Прибуток — при ставці 1 од. за справедливим кф; у букмекера в лайві кф нижчий.</p>
      </section>
      ${groups ? `<section class="card"><h3>За ринками</h3>${groups}</section>` : ''}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : '<div class="empty">За цей період лайв-рекомендацій ще немає.</div>'}`;
  }

  // Відтворення прогнозів з дня запуску (FP.APP_START) для зіграних матчів чемпіонатів, яких немає
  // в журналі. Модель будується лише з матчів до дня гри, без коефіцієнтів букмекера і без
  // статистики команд (вона вже містить цей матч), тож кутових і карток у відтворених записах немає.
  async function backfill(rid) {
    const start = Date.parse(`${FP.APP_START}T00:00:00`) / 1000;
    const now = Date.now() / 1000;
    if (now - start < 3600) return;
    await api.pool(LEAGUES.filter(l => !l.cup), 3, async league => {
      let season;
      try { season = await api.season(league.slug, false, true); } catch { return; }
      if (rid !== renderId) return;
      const todo = season.events.filter(ev => ev.ts >= start && isFinished(ev) && !FP.history.has(ev.id));
      if (!todo.length) return;
      // Одна модель на день: станом на початок дня гри.
      const byDay = new Map();
      for (const ev of todo) {
        const d = new Date(ev.ts * 1000);
        const asOf = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
        if (!byDay.has(asOf)) byDay.set(asOf, []);
        byDay.get(asOf).push(ev);
      }
      for (const [asOf, list] of byDay) {
        const before = season.events.filter(e => e.ts < asOf);
        if (!before.some(model.isResult) && !season.previous.length) continue;
        const m = model.build(league, before, null, season.previous, asOf);
        for (const ev of list) {
          const pred = model.predict(m, { ...ev, state: 'pre', odds: null }, null);
          if (pred) FP.history.recordReconstructed(league.slug, ev, pred);
        }
      }
    });
  }

  const DONE = s => s === 'win' || s === 'loss';
  const units = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const inPeriod = ts => !state.histPeriod || ts * 1000 >= Date.now() - state.histPeriod * 864e5;

  function singlesData() {
    return state.hist.singles.filter(e => inPeriod(e.ts)).map(e => {
      const tip = legStatus({ slug: e.slug, id: e.id, ts: e.ts, key: e.tip.key });
      const val = e.value ? legStatus({ slug: e.slug, id: e.id, ts: e.ts, key: e.value.key }) : null;
      return { ...e, tipSt: tip, valSt: val };
    }).sort((a, b) => b.ts - a.ts);
  }

  function accasData() {
    return state.hist.accas
      .map(a => ({ ...a, st: accaStatus(a), lastTs: a.legs[a.legs.length - 1].ts }))
      .filter(a => inPeriod(a.legs[0].ts))
      .sort((a, b) => b.createdAt - a.createdAt);
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
          <button class="${tab === 'singles' ? 'on' : ''}" data-htab="singles">Основні</button>
          <button class="${tab === 'picks' ? 'on' : ''}" data-htab="picks">Варіанти</button>
          <button class="${tab === 'bands' ? 'on' : ''}" data-htab="bands">Кф 1.64+</button>
          <button class="${tab === 'live' ? 'on' : ''}" data-htab="live">Лайв</button>
          <button class="${tab === 'accas' ? 'on' : ''}" data-htab="accas">Експреси</button>
        </div>
        <div class="chips">${periods.map(([d, l]) => `<button class="chip ${state.histPeriod === d ? 'on' : ''}" data-hper="${d}">${l}</button>`).join('')}</div>
      </div>`;
    const foot = `
      <div class="btn-row pad">
        <button class="btn" data-export="${tab}">Завантажити таблицю (CSV)</button>
        <button class="btn ghost" data-hclear="1">Очистити статистику</button>
      </div>
      <p class="hint pad">CSV відкривається в Excel, Google Таблицях чи Numbers. Об'єктивні висновки можна робити після кількох сотень ставок: на десятках результат сильно залежить від везіння.</p>`;
    const body = { singles: singlesHtml, picks: picksHtml, bands: bandsHtml, live: liveHistHtml, accas: accasHtml }[tab]();
    $view.innerHTML = head + body + foot;
  }

  // Позначка відтвореного запису (прогноз відновлено за даними до матчу).
  const recTag = e => (e.rec ? '<span class="rec-tag" title="Відтворено за даними до матчу">відн.</span>' : '');
  const recNote = list => {
    const n = list.filter(e => e.rec).length;
    return n ? `<p class="hint">З них відтворено ${n}: для матчів з ${FP.APP_START.split('-').reverse().join('.')}, яких немає в журналі, прогноз пораховано за даними до матчу, без коефіцієнтів букмекера.</p>` : '';
  };

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
              <small>${esc(leagueLabel(r.slug))} ${recTag(r)}</small>
              <span>${esc(r.home)} — ${esc(r.away)} ${r.items[0].st.score ? `<b>${esc(r.items[0].st.score)}</b>` : ''}</span>
              <div class="pchips">${r.items.map(x => `<span class="pchip ${x.st.s}">${esc(chipLabel(x))} ${STATUS_ICON[x.st.s] || ''}</span>`).join('')}</div>
            </div>
          </a>`).join('')}`;
    }).join('');
  }

  function picksHtml() {
    const rows = withStatuses('picks');
    const all = rows.flatMap(r => r.items.map(x => ({ ...x, rec: r.rec })));
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
        ${recNote(rows)}
        ${nodata ? `<p class="hint">Ще не розраховано ${nodata} варіантів на тайми, кутові чи картки: статистика цих матчів поки недоступна.</p>` : ''}
      </section>
      ${done.length ? `<section class="card">
        <h3>За групами ринків</h3>
        ${groups}
        <p class="hint">Найкращий варіант у кожній групі — найімовірніший з ймовірністю 55–85% (як у блоці «Найкращі варіанти по ринках» на екрані матчу). Риска — скільки мало зіграти за прогнозом.</p>
      </section>` : ''}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : '<div class="empty">За цей період ще немає зіграних матчів.</div>'}`;
  }

  function bandsHtml() {
    const rows = withStatuses('bands');
    const all = rows.flatMap(r => r.items);
    const done = all.filter(x => DONE(x.st.s));
    const profitOf = list => list.reduce((s, x) => s + (x.st.s === 'win' ? x.k - 1 : -1), 0);
    const bandRows = model.ODDS_BANDS.map(([lo, hi]) => {
      const list = done.filter(x => x.band === `${lo}–${hi}`);
      const w = list.filter(x => x.st.s === 'win').length;
      const pr = profitOf(list);
      const avgK = list.length ? list.reduce((s, x) => s + x.k, 0) / list.length : null;
      return `${rateRow(`Кф ${lo}–${hi}`, w, list.length, list.length ? list.reduce((s, x) => s + x.p, 0) / list.length : null)}
        ${list.length ? `<p class="band-sum">середній кф ${avgK.toFixed(2)} · прибуток <b class="${pr >= 0 ? 'ok' : 'bad'}">${units(pr)}</b> од. · ROI ${(pr / list.length * 100).toFixed(0)}%</p>` : ''}`;
    }).join('');
    const values = done.filter(x => x.value);
    const vProfit = profitOf(values);
    const total = profitOf(done);
    const days = dayList(rows, x => `${x.short} @${x.k.toFixed(2)}`);
    return `
      <section class="card">
        <div class="kpis">
          <div><b>${pctOf(done.filter(x => x.st.s === 'win').length, done.length)}</b><span>зіграло<br>${done.filter(x => x.st.s === 'win').length} з ${done.length}</span></div>
          <div><b class="${total >= 0 ? 'ok' : 'bad'}">${done.length ? units(total) : '—'}</b><span>прибуток, од.<br>по 1 од. на кожну</span></div>
          <div><b class="${vProfit >= 0 ? 'ok' : 'bad'}">${values.length ? units(vProfit) : '—'}</b><span>з них цінні<br>${values.length} ст.</span></div>
        </div>
        ${recNote(rows)}
        <p class="hint">Прибуток рахується за кф DraftKings, якщо він був, інакше за справедливим кф; у вашого букмекера кф зазвичай на 5–8% нижчий.</p>
      </section>
      ${done.length ? `<section class="card"><h3>За діапазонами</h3>${bandRows}</section>` : ''}
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
              <small>${esc(leagueLabel(r.slug))} ${recTag(r)}</small>
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
        ${recNote(rows)}
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

  function accasHtml() {
    const list = accasData();
    const settled = list.filter(a => DONE(a.st.s));
    const wins = settled.filter(a => a.st.s === 'win').length;
    const expected = settled.reduce((s, a) => s + a.st.p, 0);
    const profit = settled.reduce((s, a) => s + (a.st.s === 'win' ? a.st.fair - 1 : -1), 0);
    const legsDone = list.reduce((s, a) => s + a.st.settledLegs, 0);
    const legsWon = list.reduce((s, a) => s + a.st.wins, 0);
    const pending = list.filter(a => a.st.s === 'pending').length;

    const byCat = Object.entries(ACCA_CATS).map(([cat, title]) => {
      const c = settled.filter(a => a.cat === cat);
      return rateRow(title, c.filter(a => a.st.s === 'win').length, c.length, c.length ? c.reduce((s, a) => s + a.st.p, 0) / c.length : null);
    }).join('');

    const bySlot = ACCA_SLOTS.map(cfg => {
      const c = settled.filter(a => a.slot === cfg.slot);
      const w = c.filter(a => a.st.s === 'win').length;
      return `<tr><td>${esc(cfg.name)}</td><td>${c.length ? `${w} з ${c.length}` : '—'}</td><td>${c.length ? (c.reduce((s, a) => s + a.st.p, 0)).toFixed(1) : '—'}</td></tr>`;
    }).join('');

    const cards = list.slice(0, 40).map(a => {
      const [label, cls] = ACCA_STATUS[a.st.s];
      return `
        <details class="hacca">
          <summary>
            <span class="chip-st ${cls}">${label}</span>
            <b>${esc(a.title)}</b>
            <span class="hacca-k">кф ${a.fair.toFixed(2)}</span>
            <small>${esc(dateOf(a.legs[0].ts))} · ${a.st.wins}/${a.legs.length} подій</small>
          </summary>
          <div class="legs">${a.legs.map((l, j) => legRow(l, false, a.st.legs[j])).join('')}</div>
        </details>`;
    }).join('');

    return `
      <section class="card">
        <div class="kpis">
          <div><b>${wins} з ${settled.length}</b><span>експресів зайшло<br>очікувалось ${expected.toFixed(1)}</span></div>
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${settled.length ? units(profit) : '—'}</b><span>умовний прибуток, од.<br>за справедливим кф</span></div>
          <div><b>${pctOf(legsWon, legsDone)}</b><span>подій зіграло<br>${legsWon} з ${legsDone}</span></div>
        </div>
        <p class="hint">У грі зараз: ${pending}. «Очікувалось» — скільки експресів мало зайти за ймовірностями додатка. Умовний прибуток — якщо ставити 1 од. на кожен експрес за справедливим кф; у букмекера кф нижчий.</p>
      </section>
      ${settled.length ? `<section class="card">
        <h3>За типами</h3>
        ${byCat}
      </section>
      <section class="card">
        <h3>За пунктами</h3>
        <table class="markets"><thead><tr><th>Експрес</th><th>Зайшло</th><th>Очікувалось</th></tr></thead><tbody>${bySlot}</tbody></table>
      </section>` : ''}
      ${cards ? `<section class="card"><h3>Усі експреси</h3>${cards}</section>` : '<div class="empty">За цей період експресів ще немає.</div>'}`;
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
    } else if (tab === 'live') {
      rows = [['Дата', 'Турнір', 'Господарі', 'Гості', 'Перерва', 'Фінал', 'Ринок', 'Ставка', 'Ймовірність', 'Кф (справедливий)', 'Результат']];
      for (const r of liveRows()) {
        for (const x of r.items) {
          rows.push([FP.dateOfTs(r.ts), leagueLabel(r.slug), r.home, r.away, `${r.ht.home}:${r.ht.away}`, x.st.score || '',
            x.group, x.short, num(x.p), num(x.k), RES[x.st.s] || 'немає даних']);
        }
      }
    } else if (tab === 'picks' || tab === 'bands') {
      rows = [['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Рахунок', tab === 'picks' ? 'Група ринків' : 'Діапазон кф',
        'Ставка', 'Ймовірність', 'Кф', 'Результат', 'Відтворено']];
      for (const r of withStatuses(tab)) {
        for (const x of r.items) {
          rows.push([FP.dateOfTs(r.ts), timeOf(r.ts), leagueLabel(r.slug), r.home, r.away, x.st.score || '',
            tab === 'picks' ? x.group : x.band, x.short, num(x.p), num(tab === 'bands' ? x.k : 1 / x.p),
            RES[x.st.s] || 'немає даних', r.rec ? 'так' : '']);
        }
      }
    } else {
      rows = [['Створено', 'Експрес', 'Подій', 'Кф (справедливий)', 'Ймовірність', 'Статус', 'Зіграло подій', 'Події']];
      for (const a of accasData()) {
        rows.push([new Date(a.createdAt).toLocaleString('uk-UA'), a.title, a.legs.length, num(a.fair), num(a.p), ACCA_STATUS[a.st.s][0],
          `${a.st.wins}/${a.legs.length}`,
          a.legs.map((l, j) => `${l.home} — ${l.away}: ${l.short} (${RES[a.st.legs[j].s]})`).join(' | ')]);
      }
    }
    const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `statystyka-${{ singles: 'osnovni', picks: 'varianty', bands: 'kf-1.64-9.99', live: 'live', accas: 'ekspresy' }[tab]}-${FP.localDate(0)}.csv`;
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
    else if (b.dataset.hclear) {
      if (!confirm('Видалити всю статистику прогнозів і експресів?')) return;
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
          <li>Вкладка «Історія» показує, скільки прогнозів додатка справді зіграло.</li>
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
        <p class="hint">Кеш — збережені на телефоні дані (матчі, таблиці, статистика), щоб додаток відкривався швидко і не завантажував усе щоразу заново. Зазвичай його чіпати не треба. Кнопка потрібна, лише якщо дані виглядають застарілими чи неправильними: тоді все завантажиться наново. Історія прогнозів і купон експресу не зітруться.</p>
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
      case 'express': return viewExpress();
      case 'live': return viewLive();
      default: return viewHome();
    }
  }

  $view.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add) {
      addFromMatch(b.dataset.add);
    } else if (b.dataset.day) {
      state.dayOffset = Number(b.dataset.day);
      viewHome();
    } else if (b.dataset.league) {
      state.league = b.dataset.league;
      b.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
      renderList();
    } else if (b.dataset.sort) {
      state.sort = b.dataset.sort;
      b.parentElement.querySelectorAll('button').forEach(c => c.classList.toggle('on', c === b));
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
      else if (parts[0] === 'live') {
        // Не перемальовуємо, якщо користувач розгорнув «Усі ринки» — щоб не згорталось під пальцем.
        if (!document.querySelector('.live-all[open]')) await viewLive(true);
      }
    } finally {
      ticking = false;
    }
  }
  setInterval(tick, TICK);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  route();
})();
