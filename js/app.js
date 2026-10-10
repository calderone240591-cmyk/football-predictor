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
    $list.innerHTML = summary(items) + valueCard(items)
      + `<div class="group">${items.map(x => matchCard(x, true)).join('')}</div>`;
  }

  // Перевірка моделі на вже зіграних сьогодні матчах.
  function summary(items) {
    const done = items.filter(x => x.pred && isFinished(x.ev));
    if (!done.length) return '';
    const hits = done.filter(x => x.pred.tip.hit(x.ev.home.score, x.ev.away.score)).length;
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
        ${values.map(x => `<a class="acca-row" href="#/match/${x.slug}/${x.ev.id}">
          <span><small>${status(x)}</small> ${esc(x.ev.home.short || x.ev.home.name)} — ${esc(x.ev.away.short || x.ev.away.name)}</span>
          <b>${esc(x.v.short)} @ ${x.v.odds.toFixed(2)} · +${(x.v.edge * 100).toFixed(0)}%</b></a>`).join('')}
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
        ${isUpcoming(ev) ? `<div class="btn-row">${addBtn(ev, pred.tip.key, 'в експрес')}</div>` : ''}
        <a class="gloss-link" href="#/info/markets">Що означають ТБ, ІТ, Ф1 та інші позначення →</a>
      </section>`}

      ${started ? '' : `
      <section class="card">
        <h3>Найкращі ставки на матч за ринками</h3>
        <div class="picks">${pred.groups.filter(g => g.pick).map(g => `
          <div class="pick"><span>${esc(g.name)}</span><b>${esc(g.pick.short)}</b><i>${pct(g.pick.p)} · кф ${fair(g.pick.p)}</i>${addBtn(ev, g.pick.key)}</div>`).join('')}
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
    if (isFinished(ev)) {
      const r = model.settle(pred.tip.key, ev.home.score, ev.away.score);
      return `
        <section class="card tipcard ${r ? 'hi' : 'lo'}">
          <div class="tip-label">Рекомендація до матчу</div>
          <div class="tip-main">${esc(pred.tip.long)} ${r === true ? '<i class="ok">✓ зіграла</i>' : r === false ? '<i class="bad">✗ не зіграла</i>' : '↺'}</div>
          <p class="hint">Ймовірність до матчу ${pct(pred.tip.p)}. Результат враховано у вкладці «Статистика».</p>
        </section>`;
    }
    return `
      <section class="card notice-card">
        <div class="tip-label">Матч іде</div>
        <p>Передматчеві рекомендації вже неактуальні: вони були зафіксовані до початку матчу і враховуються у статистиці.</p>
        <p class="hint">Аналіз для ставок під час гри — у розділі <a href="#/live">«Лайв»</a>: у перерві і до ${LIVE_UNTIL_MINUTE}-ї хвилини.</p>
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

  // ---------- Експреси ----------
  // 11 слотів готових експресів: кількість подій n і цільовий кф у межах [lo, hi].
  // Ймовірність окремої події підбирається так, щоб за n подій вийти на цільовий кф.
  // Експрес у слоті не змінюється, доки не завершиться його перша подія; тоді він іде
  // в статистику, а в слоті з'являється новий.
  // 9 експресів: по 3 варіанти з 2, 3 і 4 матчів; кожна подія — з ймовірністю від 67%.
  // Коефіцієнт — який вийде з таких подій: дубль ≈ 2, трійник ≈ 3, четвірка ≈ 4–5.
  const ACCA_SLOTS = [2, 3, 4].flatMap(n => [1, 2, 3].map(i => ({
    slot: `M${n}-${i}`, set: 'safe', cat: `m${n}`, name: `${n} матчі · варіант ${i}`, n,
    ...({ 2: { target: 2.0, lo: 1.7, hi: 2.25 }, 3: { target: 2.9, lo: 2.4, hi: 3.35 }, 4: { target: 4.0, lo: 3.2, hi: 4.97 } })[n],
    minP: 0.67,
  })));
  const ACCA_SETS = { safe: 'Експреси · кожна подія від 67%' };
  const ACCA_CATS = { m2: 'Експреси з 2 матчів', m3: 'Експреси з 3 матчів', m4: 'Експреси з 4 матчів' };
  // Ринки для експресів: основні, без таймів, кутових і карток (вони розраховуються лише після матчу
  // за його статистикою, а експрес має замінюватись одразу після першої події).
  const ACCA_GROUPS = new Set(['Результат', 'Тотал голів', 'Обидві заб\'ють', 'Фори', 'Індивідуальні тотали', 'Комбіновані']);

  const legOdds = l => (l.userOdds > 1 ? l.userOdds : l.odds > 1 ? l.odds : null);

  const isAccaMarket = m => ACCA_GROUPS.has(m.group);

  // used.events — події (матч + ринок), уже зайняті в інших експресах: повторювати їх не можна.
  // used.matches — матчі, що вже трапляються: можна, але з невеликим штрафом заради різноманітності.
  const eventKey = (id, key) => `${id}:${key}`;
  const usable = (m, ev, used, cfg) => isAccaMarket(m) && m.p >= (cfg.minP || 0.3) && m.p <= 0.9 && !used.events.has(eventKey(ev.id, m.key));
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
          if (!usable(m, ev, used, cfg)) continue;
          // Для надійних — невеликий бонус подіям від 70%.
          const score = -Math.abs(m.p - ideal) + Math.max(0, m.edge || 0) - penalty(pred, ev, used)
            + (cfg.minP && m.p >= 0.7 ? 0.02 : 0);
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
        if (!usable(m, ev, used, cfg)) continue;
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
      id: `${cfg.slot}-${Date.now()}`, slot: cfg.slot, set: cfg.set, cat: cfg.cat, title: cfg.name,
      risk: riskOf(p), createdAt: Date.now(), p, fair: 1 / p, legs,
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
      <p class="hint top">Купон порожній. Додавайте події кнопкою <b>+</b> на екрані матчу (у рекомендованій ставці або в найкращих ставках за ринками) чи завантажте готовий експрес нижче.</p>`;
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
    // Лише матчі, що ще не почались і потрапляють у статистику (від FP.STATS_FROM).
    const items = days.flatMap(d => d.items)
      .filter(x => isUpcoming(x.ev) && x.ev.ts * 1000 > Date.now() + 5 * MIN && x.ev.ts >= FP.STATS_FROM);

    // Моделі (а з ними й результати сезону) — для майбутніх матчів і для подій активних експресів.
    await FP.history.ready;
    if (rid !== renderId) return;
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

    let html = '<p class="hint pad">Кожна подія — з ймовірністю від 67% (переважно 70%+). Тому коефіцієнт невисокий: 2 матчі ≈ 2, 3 матчі ≈ 3, 4 матчі ≈ 4–5 — зате експрес заходить частіше.</p>';
    for (const [cat, title] of Object.entries(ACCA_CATS)) {
      html += `<h2 class="section-title">${esc(title)}</h2>`;
      ACCA_SLOTS.forEach((cfg, i) => { if (cfg.cat === cat) html += card(cfg, i); });
    }
    document.getElementById('accas').innerHTML = html + `
      <p class="hint pad">Події (матч + ставка) в 9 експресах не повторюються; один матч може траплятися з різними ставками. Коефіцієнт — справедливий (без маржі): букмекер на кожну подію дає на 5–8% менше. Експрес не змінюється, доки не завершиться його перша подія; тоді він іде в статистику, а на його місці з'являється новий. Результати — у вкладці «Статистика».</p>`;
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
  const isFirstHalf = ev => ev.state === 'in' && /FIRST_HALF/.test(ev.status);
  const minuteOf = ev => { const m = /(\d+)/.exec(ev.clock || ''); return m ? +m[1] : null; };
  // Після перерви матч показується з рекомендаціями перерви до 50-ї хвилини включно,
  // поки рахунок не змінився; з 51-ї хвилини рекомендації вже неактуальні — матч зникає.
  const LIVE_UNTIL_MINUTE = 50;
  const inGrace = ev => ev.state === 'in' && /SECOND_HALF/.test(ev.status) && (minuteOf(ev) ?? 99) <= LIVE_UNTIL_MINUTE;
  state.liveK2 = true;   // показувати лише ринки з кф від 2.00

  // Знімки аналізу, зробленого в перерві: id матчу → { slug, ls, h, a, an, at }.
  // Зберігаються в IndexedDB, щоб пережити перезапуск додатка між перервою і 50-ю хвилиною.
  let liveSnaps = null;
  async function loadSnaps() {
    if (liveSnaps) return liveSnaps;
    await FP.store.ready;
    liveSnaps = FP.store.get('state', 'liveSnaps') || {};
    return liveSnaps;
  }
  function saveSnaps() {
    const cutoff = Date.now() - 3 * 3600e3;
    for (const id of Object.keys(liveSnaps)) if (liveSnaps[id].at < cutoff) delete liveSnaps[id];
    FP.store.put('state', 'liveSnaps', liveSnaps);
  }

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
    // «Зараз ідуть» — лише 1-й тайм: ці матчі скоро дійдуть до перерви.
    const playing = all.filter(x => isFirstHalf(x.ev)).sort((a, b) => a.ev.ts - b.ev.ts);
    const snaps = await loadSnaps();
    if (rid !== renderId) return;
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
      // Перший тайм 0:0 — окремо показуємо тотал 1.5 (більше / менше) і записуємо ймовірніший варіант.
      // Лайв має окрему статистику і у віртуальний рахунок не йде.
      let zero = null, recs = an.recs;
      if (h === 0 && a === 0) {
        const over = an.markets.find(m => m.key === 'LO1.5'), under = an.markets.find(m => m.key === 'LU1.5');
        if (over && under) {
          zero = { over, under };
          recs = [...recs, { ...(over.p >= under.p ? over : under), group: 'Тотал 1.5 при 0:0', zero: true }];
        }
      }
      FP.history.recordLive(x.slug, x.ev, { home: h, away: a }, recs);
      snaps[x.ev.id] = { slug: x.slug, ls, h, a, an, zero, at: Date.now() };
      analyses.push({ ...x, ls, h, a, an, zero });
    }
    // 2-й тайм до 50-ї хвилини: показуємо аналіз, зроблений у перерві, якщо рахунок не змінився.
    for (const x of all.filter(y => inGrace(y.ev))) {
      const s = snaps[x.ev.id];
      if (!s || x.ev.home.score !== s.h || x.ev.away.score !== s.a) continue;
      analyses.push({ ...s, ev: x.ev, slug: x.slug, grace: true });
    }
    if (halftime.length) saveSnaps();
    // Спершу матчі з 0:0 після 1-го тайму, далі — за часом початку.
    analyses.sort((p, q) => (!!q.zero - !!p.zero) || p.ev.ts - q.ev.ts);
    state.liveData = { analyses, playing, soon, at: Date.now() };
    renderLive();
  }

  function renderLive() {
    const { analyses, playing, soon, at } = state.liveData;
    const k2 = m => !state.liveK2 || 1 / m.p >= 2;
    const statRow = (label, h, a, suffix = '') => `<tr><td>${h ?? '—'}${h != null ? suffix : ''}</td><th>${label}</th><td>${a ?? '—'}${a != null ? suffix : ''}</td></tr>`;
    const zeroBox = z => `
      <div class="zero-box">
        <div class="zero-title">1-й тайм 0:0 · тотал матчу 1.5</div>
        ${[['Більше 1.5', 'щонайменше 2 голи в 2-му таймі', z.over], ['Менше 1.5', 'не більше 1 гола в 2-му таймі', z.under]].map(([t, d, m]) => `
          <div class="zero-row ${m.p >= 0.5 ? 'fav' : ''}"><div><b>${t}</b><small>${d}</small></div><b>${pct(m.p)}</b><i>кф ${fair(m.p)}</i></div>`).join('')}
      </div>`;
    const card = ({ slug, ev, ls, h, a, an, grace, zero }) => `
      <section class="card live-card ${zero ? 'zero-card' : ''}">
        <a class="band-head" href="#/match/${slug}/${ev.id}">
          <small><img src="${FP.leagueLogo(LEAGUE_BY_SLUG.get(slug))}" alt="">${esc(leagueLabel(slug))}</small>
        </a>
        <div class="live-score">
          <span>${esc(ev.home.name)}</span><b>${h}:${a}</b><span>${esc(ev.away.name)}</span>
        </div>
        <div class="live-status">${grace
          ? `2-й тайм · ${esc(ev.clock || '')} · рекомендації з перерви, зникне після ${LIVE_UNTIL_MINUTE}'`
          : 'Перерва'}</div>
        <table class="compare live-stats"><tbody>
          ${statRow('Удари', ls.home.shots, ls.away.shots)}
          ${statRow('У площину', ls.home.sot, ls.away.sot)}
          ${statRow('Володіння', ls.home.poss != null ? Math.round(ls.home.poss) : null, ls.away.poss != null ? Math.round(ls.away.poss) : null, '%')}
          ${statRow('Кутові', ls.home.corners, ls.away.corners)}
          ${statRow('Жовті', ls.home.yellow, ls.away.yellow)}
          ${(ls.home.red || ls.away.red) ? statRow('Червоні', ls.home.red, ls.away.red) : ''}
        </tbody></table>
        ${zero ? zeroBox(zero) : ''}
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
        <span><i class="live-dot"></i>Оновлено о ${new Date(at).toLocaleTimeString('uk-UA')} · кожні 15 с</span>
        <label class="switch"><input type="checkbox" id="live-k2" ${state.liveK2 ? 'checked' : ''}> лише кф ≥ 2.00</label>
      </div>
      ${analyses.length ? analyses.map(card).join('') : `
        <section class="card">
          <h3>Зараз немає матчів у перерві</h3>
          <p class="hint">Розділ показує матчі лише під час перерви: тоді вже відома статистика 1-го тайму, а 2-й ще попереду. Сторінка оновлюється кожні 15 секунд — тримайте її відкритою, і матч з'явиться, щойно почнеться перерва.</p>
        </section>`}
      ${playing.length ? `<h2 class="section-title">1-й тайм · скоро перерва</h2>
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
      <p class="hint pad">Матч показується в перерві і до ${LIVE_UNTIL_MINUTE}-ї хвилини (поки рахунок не змінився), далі рекомендації неактуальні і він зникає. Рекомендації, видані в перерві, мають окрему статистику (вкладка «Лайв» у «Статистиці»), у віртуальний рахунок вони не йдуть. Живих коефіцієнтів у безкоштовних даних немає, тож показано справедливий кф за нашою ймовірністю: «кф від 2.00» = ймовірність до 50%. У лайві букмекер зазвичай дає на 5–10% менше. ${help('fair')}</p>`;

    const $k2 = document.getElementById('live-k2');
    if ($k2) $k2.onchange = () => { state.liveK2 = $k2.checked; renderLive(); };
  }

  // ---------- Статистика прогнозів ----------
  // Одиночні: основна рекомендація і цінна ставка кожного матчу (останній прогноз перед стартом).
  // Експреси: усі 11 готових експресів — активні й замінені.
  state.histTab = 'bank';
  state.histPeriod = 30;

  async function viewHistory() {
    const rid = ++renderId;
    setHeader('Статистика');
    $view.innerHTML = '<div class="loading">Перевірка результатів…</div>';
    await FP.history.ready;
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
    state.hist = { singles, accas, lives };
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
        <div class="segmented small tabs6">
          <button class="${tab === 'bank' ? 'on' : ''}" data-htab="bank">Рахунок</button>
          <button class="${tab === 'singles' ? 'on' : ''}" data-htab="singles">Основні</button>
          <button class="${tab === 'value' ? 'on' : ''}" data-htab="value">Цінні</button>
          <button class="${tab === 'picks' ? 'on' : ''}" data-htab="picks">Варіанти</button>
          <button class="${tab === 'accas' ? 'on' : ''}" data-htab="accas">Експреси</button>
          <button class="${tab === 'live' ? 'on' : ''}" data-htab="live">Лайв</button>
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
    const body = { bank: bankHtml, singles: singlesHtml, value: valueHtml, picks: picksHtml, accas: accasHtml, live: liveHistHtml }[tab]();
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
  // Симуляція: на кожну основну ставку, цінну ставку і кожен готовий експрес — 50 грн.
  // Коефіцієнт — букмекерський (DraftKings), якщо був, інакше справедливий (1 / ймовірність).
  // На «найкращі варіанти» і лайв не ставимо.
  const STAKE = 50;
  const BANK_CATS = { tip: 'Основні', value: 'Цінні', acca: 'Експреси' };
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
    for (const a of accasData()) {
      // Події з поверненням не враховуються в коефіцієнті експресу.
      const legs = a.legs.filter((l, j) => a.st.legs[j].s !== 'void');
      const odds = legs.reduce((s, l) => s * (l.odds || 1 / l.p), 1);
      bets.push({
        ts: a.legs[a.legs.length - 1].ts, cat: 'acca', title: a.title, pick: `${a.legs.length} події`,
        odds, book: a.legs.every(l => l.odds), s: a.st.s,
      });
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
      <a class="hrow" ${b.slug ? `href="#/match/${b.slug}/${b.id}"` : 'href="#/express"'}>
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
        <p class="hint">Симуляція: на кожну основну ставку, цінну ставку і кожен готовий експрес ставиться 50 грн. Коефіцієнт — DraftKings, якщо був, інакше справедливий (у букмекера реальний кф на 5–8% нижчий, тож реальний результат був би трохи гіршим). На «найкращі варіанти» і лайв не ставимо.</p>
      </section>
      <section class="card">
        <h3>За типами ставок</h3>
        <table class="markets"><thead><tr><th></th><th>Зіграло</th><th>Поставлено</th><th>Прибуток</th><th>ROI</th></tr></thead><tbody>${byCat}</tbody></table>
      </section>
      ${(() => {
        // За лігами — лише основні й цінні ставки: експрес складається з матчів різних ліг.
        const single = settled.filter(b => b.slug && DONE(b.s));
        if (!single.length) return '';
        const rows = groupBy(single, b => leagueLabel(b.slug)).map(([l, list]) => {
          const pr = list.reduce((s, b) => s + b.profit, 0), w = list.filter(b => b.s === 'win').length;
          return `<tr><td>${esc(l)}</td><td>${w} з ${list.length}</td><td class="${pr >= 0 ? 'ok' : 'bad'}">${uah(pr)}</td><td>${(pr / (list.length * STAKE) * 100).toFixed(0)}%</td></tr>`;
        }).join('');
        return `<section class="card"><h3>За чемпіонатами</h3>
          <table class="markets"><thead><tr><th>Чемпіонат</th><th>Зіграло</th><th>Прибуток</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table>
          <p class="hint">Основні й цінні ставки. Експреси сюди не входять — у них матчі різних ліг.</p></section>`;
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

  // ---------- Лайв (окрема статистика, у віртуальний рахунок не йде) ----------
  // Статус лайв-ставки за фінальним рахунком, рахунком перерви і кутовими/картками матчу.
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
    return (state.hist.lives || []).filter(e => inPeriod(e.ts)).map(e => ({
      ...e, items: e.picks.map(p => ({ ...p, slug: e.slug, st: liveStatus(e, p.key) })),
    })).sort((a, b) => b.ts - a.ts);
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

  function liveHistHtml() {
    const rows = liveRows();
    const all = rows.flatMap(r => r.items);
    const done = all.filter(x => DONE(x.st.s));
    const wins = done.filter(x => x.st.s === 'win').length;
    const profit = done.reduce((s, x) => s + (x.st.s === 'win' ? x.k - 1 : -1), 0);
    const exp = done.length ? done.reduce((s, x) => s + x.p, 0) / done.length : null;
    const pending = all.filter(x => !DONE(x.st.s) && x.st.s !== 'void' && x.st.s !== 'nodata').length;
    const zero = done.filter(x => x.zero);

    const byGroup = done.length ? statTable('Ринок', groupBy(done, x => x.group)) : '';
    const byMarket = done.length ? statTable('Ставка', groupBy(done, x => x.short).slice(0, 20)) : '';
    const byLeague = done.length ? statTable('Чемпіонат', groupBy(done, x => leagueLabel(x.slug))) : '';

    const byDay = new Map();
    for (const r of rows.filter(r => r.items.some(x => x.st.s !== 'pending'))) {
      const d = dateOf(r.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const days = [...byDay].map(([d, list]) => {
      const dd = list.flatMap(r => r.items).filter(x => DONE(x.st.s));
      return `
        <div class="day-head"><b>${esc(d)}</b><span>${dd.length ? `${dd.filter(x => x.st.s === 'win').length} з ${dd.length}` : ''}</span></div>
        ${list.map(r => `
          <a class="hrow" href="#/match/${r.slug}/${r.id}">
            <div class="hrow-main">
              <small>${esc(leagueLabel(r.slug))} · перерва ${r.ht.home}:${r.ht.away}</small>
              <span>${esc(r.home)} — ${esc(r.away)} ${r.items[0].st.score ? `<b>${esc(r.items[0].st.score)}</b>` : ''}</span>
              <div class="pchips">${r.items.map(x => `<span class="pchip ${x.st.s}">${esc(x.short)} @${x.k.toFixed(2)} ${STATUS_ICON[x.st.s] || ''}</span>`).join('')}</div>
            </div>
          </a>`).join('')}`;
    }).join('');

    return `
      <section class="card">
        <div class="kpis">
          <div><b>${pctOf(wins, done.length)}</b><span>зіграло<br>${wins} з ${done.length}</span></div>
          <div><b>${exp != null ? Math.round(exp * 100) + '%' : '—'}</b><span>очікувалось<br>за прогнозом</span></div>
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${done.length ? units(profit) : '—'}</b><span>прибуток, од.<br>в грі ${pending}</span></div>
        </div>
        <p class="hint">Записуються всі рекомендації, видані в перерві (3 ставки з кф від 2.00, а при 0:0 — ще й тотал 1.5). Прибуток — при ставці 1 од. за справедливим кф; у букмекера в лайві кф нижчий. У віртуальний рахунок лайв не йде.</p>
      </section>
      ${zero.length ? `<section class="card"><h3>Перший тайм 0:0 · тотал 1.5</h3>${statTable('Варіант', groupBy(zero, x => x.short))}</section>` : ''}
      ${byGroup ? `<section class="card"><h3>За ринками</h3>${byGroup}</section>` : ''}
      ${byMarket ? `<section class="card"><h3>За видами ставок</h3>${byMarket}</section>` : ''}
      ${byLeague ? `<section class="card"><h3>За чемпіонатами</h3>${byLeague}</section>` : ''}
      ${days ? `<section class="card"><h3>По днях</h3>${days}</section>` : '<div class="empty">За цей період лайв-рекомендацій ще немає.<br>Вони записуються, коли розділ «Лайв» відкритий під час перерви.</div>'}`;
  }

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
      ${(() => {
        // Події з експресів за лігами: скільки зіграло (за справедливим кф кожної події).
        const legs = list.flatMap(a => a.legs.map((l, j) => ({ ...l, k: 1 / l.p, st: a.st.legs[j] }))).filter(x => DONE(x.st.s));
        return legs.length ? `<section class="card"><h3>Події експресів за чемпіонатами</h3>${statTable('Чемпіонат', groupBy(legs, x => leagueLabel(x.slug)))}
          <p class="hint">Кожна подія з усіх експресів окремо: скільки зіграло і прибуток, якби на неї ставили 1 од. окремо за справедливим кф.</p></section>` : '';
      })()}
      ${cards ? `<section class="card"><h3>Усі експреси</h3>${cards}</section>` : '<div class="empty">За цей період експресів ще немає.</div>'}`;
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
    const accas = accasData();
    const accaItems = accas.map(a => ({ p: a.st.p, fair: a.st.fair, st: { s: a.st.s }, set: a.set, cat: a.cat }));
    const fairK = x => 1 / x.p;
    const lives = liveRows().flatMap(r => r.items);
    const groupRows = (list, key) => groupBy(list, key).map(([l, xs]) => row(l, agg(xs, x => x.k))).join('');

    const summary = [
      row('Основні ставки', agg(tips, x => x.odds || 1 / x.p)),
      row('Цінні ставки (кф DraftKings)', agg(values, x => x.odds)),
      row('Найкращі варіанти по ринках', agg(picks, fairK)),
      row('Експреси', agg(accaItems, x => x.fair)),
      row('Лайв у перерві (без рахунку)', agg(lives, x => x.k)),
    ].join('');

    const byLevel = [3, 2, 1].map(l => row(`${['', 'Низька', 'Середня', 'Висока'][l]} впевненість`,
      agg(tips.filter(t => t.level === l), x => x.odds || 1 / x.p))).join('');
    const byGroup = Object.values(model.GROUPS).map(g => {
      const a = agg(picks.filter(x => x.group === g), fairK);
      return a.n ? row(g, a) : '';
    }).join('');
    const byCat = Object.entries(ACCA_CATS).map(([cat, t]) => row(t, agg(accaItems.filter(a => a.cat === cat), x => x.fair))).join('');

    const journal = singles.filter(r => DONE(r.tipSt.s)).slice(0, 200).map(r => `
      <tr><td>${esc(FP.dateOfTs(r.ts).split('-').reverse().join('.'))}</td><td>${esc(leagueLabel(r.slug))}</td>
        <td>${esc(r.home)} — ${esc(r.away)}</td><td>${esc(r.tipSt.score || '')}</td>
        <td>${esc(r.tip.short)}</td><td>${pct(r.tip.p)}</td><td class="${r.tipSt.s === 'win' ? 'pos' : 'neg'}">${RES[r.tipSt.s]}</td></tr>`).join('');

    const accaList = accas.filter(a => DONE(a.st.s)).slice(0, 60).map(a => `
      <div class="acca">
        <div class="acca-h"><b>${esc(a.title)}</b><span>кф ${a.fair.toFixed(2)} · ${esc(new Date(a.createdAt).toLocaleDateString('uk-UA'))}</span>
          <em class="${a.st.s === 'win' ? 'pos' : 'neg'}">${a.st.s === 'win' ? 'зайшов' : 'не зайшов'}</em></div>
        ${a.legs.map((l, j) => `<div class="leg">${RES[a.st.legs[j].s] || '·'} ${esc(l.home)} — ${esc(l.away)}: <b>${esc(l.short)}</b> (${pct(l.p)})</div>`).join('')}
      </div>`).join('');

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
          .pdf .acca { border: 1px solid #dde2dc; border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; page-break-inside: avoid; }
          .pdf .acca-h { display: flex; gap: 10px; align-items: baseline; } .pdf .acca-h span { color: #5e6862; } .pdf .acca-h em { margin-left: auto; font-style: normal; }
          .pdf .leg { font-size: 11px; color: #33403a; } .pdf .note { color: #5e6862; font-size: 10.5px; margin-top: 14px; }
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
        ${byGroup ? `<h2>Найкращі варіанти за групами ринків</h2>${table(H, byGroup)}` : ''}
        <h2>Експреси за типами</h2>
        ${table(H, byCat)}
        ${lives.some(x => DONE(x.st.s)) ? `
          <h2>Лайв у перерві — за ринками</h2>${table(H, groupRows(lives, x => x.group))}
          <h2>Лайв у перерві — за чемпіонатами</h2>${table(H, groupRows(lives, x => leagueLabel(x.slug)))}` : ''}
        ${accaList ? `<h2>Розраховані експреси</h2>${accaList}` : ''}
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
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.acca'] },
      }).from(holder.firstElementChild).save();
    } catch (e) {
      toast(e.message || 'Не вдалося створити PDF');
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
    } else if (tab === 'live') {
      rows = [['Дата', 'Турнір', 'Господарі', 'Гості', 'Перерва', 'Фінал', 'Ринок', 'Ставка', 'Ймовірність', 'Кф (справедливий)', 'Результат']];
      for (const r of liveRows()) {
        for (const x of r.items) {
          rows.push([FP.dateOfTs(r.ts), leagueLabel(r.slug), r.home, r.away, `${r.ht.home}:${r.ht.away}`, x.st.score || '',
            x.group, x.short, num(x.p), num(x.k), RES[x.st.s] || 'немає даних']);
        }
      }
    } else if (tab === 'picks') {
      rows = [['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Рахунок', 'Група ринків', 'Ставка', 'Ймовірність', 'Кф (справедливий)', 'Результат']];
      for (const r of withStatuses('picks')) {
        for (const x of r.items) {
          rows.push([FP.dateOfTs(r.ts), timeOf(r.ts), leagueLabel(r.slug), r.home, r.away, x.st.score || '',
            x.group, x.short, num(x.p), num(1 / x.p), RES[x.st.s] || 'немає даних']);
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
    a.download = `statystyka-${{ bank: 'rakhunok', singles: 'osnovni', value: 'cinni', picks: 'varianty', accas: 'ekspresy', live: 'live' }[tab]}-${FP.localDate(0)}.csv`;
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
          <li>Модель відкалібровано на 1091 зіграному матчі 25 чемпіонатів (прогноз за даними до гри): виправлено недооцінку голів, уточнено розкид кутових і карток, неефективні ринки прибрано. ${help('calib')}</li>
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

  // Лайв оновлюється постійно — кожні 15 секунд, поки розділ відкритий.
  let liveBusy = false;
  setInterval(async () => {
    if (liveBusy || document.hidden || !location.hash.startsWith('#/live')) return;
    // Не перемальовуємо, якщо розгорнуто «Усі ринки», — щоб список не згортався під пальцем.
    if (document.querySelector('.live-all[open]')) return;
    liveBusy = true;
    try { await viewLive(true); } finally { liveBusy = false; }
  }, 15 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  route();
})();
