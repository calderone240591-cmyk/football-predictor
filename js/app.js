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
  // Рівні ризику для готових експресів: цільовий коефіцієнт і орієнтовна кількість подій.
  // Ймовірність окремої події підбирається так, щоб за n подій вийти на цільовий кф.
  const ACCA_LEVELS = [
    { name: 'Надійний',      risk: 1, n: 3, target: 2,   lo: 1.8, hi: 2.5 },
    { name: 'Помірний',      risk: 2, n: 4, target: 3.5, lo: 3,   hi: 4.5 },
    { name: 'Збалансований', risk: 3, n: 5, target: 6,   lo: 5,   hi: 8 },
    { name: 'Ризикований',   risk: 4, n: 5, target: 10,  lo: 8.5, hi: 13 },
    { name: 'Високий ризик', risk: 5, n: 6, target: 22,  lo: 20,  hi: 35 },
  ];
  // Ринки для експресів: лише основні, без таймів, кутових і карток (там модель орієнтовна).
  const ACCA_GROUPS = new Set(['Результат', 'Тотал голів', 'Обидві заб\'ють', 'Фори', 'Індивідуальні тотали', 'Комбіновані']);
  const ACCA_EXCLUDE = new Set(['12', 'DNB1', 'DNB2', 'O05', 'HO05', 'AO05']);

  const legOdds = l => (l.userOdds > 1 ? l.userOdds : l.odds > 1 ? l.odds : null);

  const isAccaMarket = m => ACCA_GROUPS.has(m.group) && !ACCA_EXCLUDE.has(m.key);

  // Оцінка події для експресу: близькість до потрібної ймовірності, бонус за перевагу над
  // букмекером, штраф за мало даних і за матч, уже використаний в іншому експресі.
  const legScore = (m, pred, ev, ideal, used) =>
    -Math.abs(m.p - ideal) + Math.max(0, m.edge || 0) - (pred.lowData ? 0.5 : 0) - (used.has(ev.id) ? 1 : 0);

  const toLeg = ({ slug, ev, m }) => ({
    slug, id: ev.id, ts: ev.ts, home: ev.home.short || ev.home.name, away: ev.away.short || ev.away.name,
    key: m.key, short: m.short, long: m.long, p: m.p, odds: m.odds || null,
  });

  const finishAcca = (title, risk, chosen, used) => {
    chosen.forEach(o => used.add(o.ev.id));
    return { title, risk, legs: chosen.sort((a, b) => a.ev.ts - b.ev.ts).map(toLeg) };
  };

  // Рівень ризику за загальною ймовірністю експресу.
  const riskOf = p => (p >= 0.4 ? 1 : p >= 0.25 ? 2 : p >= 0.15 ? 3 : p >= 0.08 ? 4 : 5);

  // Експреси за рівнями ризику: від надійного (кф ~2) до високого ризику (кф 20+).
  const buildLevelAccas = (pool, used) => ACCA_LEVELS.map(l => ({
    ...buildFixedAccas(pool, used, l.n, [l.target], l.lo, l.hi, l.name)[0], risk: l.risk,
  }));

  // Експреси з фіксованою кількістю подій n і загальним кф у межах [lo, hi], найближчим до target.
  function buildFixedAccas(pool, used, n, targets, lo, hi, name) {
    return targets.map(target => {
      const ideal = Math.pow(target, -1 / n);
      const chosen = [];
      let odds = 1;
      // Перші n−1 подій — найкращі з ймовірністю, близькою до потрібної.
      for (let i = 0; i < n - 1; i++) {
        let best = null;
        for (const { slug, ev, pred } of pool) {
          if (chosen.some(c => c.ev.id === ev.id)) continue;
          for (const m of pred.markets) {
            if (!isAccaMarket(m) || m.p < 0.3 || m.p > 0.9) continue;
            const score = legScore(m, pred, ev, ideal, used);
            if (!best || score > best.score) best = { slug, ev, m, score };
          }
        }
        if (!best) break;
        chosen.push(best);
        odds /= best.m.p;
      }
      // Остання подія — та, що приводить загальний кф якнайближче до цілі в межах діапазону.
      let last = null;
      for (const { slug, ev, pred } of pool) {
        if (chosen.some(c => c.ev.id === ev.id)) continue;
        for (const m of pred.markets) {
          if (!isAccaMarket(m) || m.p < 0.3 || m.p > 0.9) continue;
          const total = odds / m.p;
          if (total < lo || total > hi) continue;
          const score = -2 * Math.abs(Math.log(total / target)) + Math.max(0, m.edge || 0)
            - (pred.lowData ? 0.5 : 0) - (used.has(ev.id) ? 1 : 0);
          if (!last || score > last.score) last = { slug, ev, m, score };
        }
      }
      if (chosen.length !== n - 1 || !last) return { title: name, risk: 3, legs: [] };
      chosen.push(last);
      const p = chosen.reduce((s, o) => s * o.m.p, 1);
      return finishAcca(name, riskOf(p), chosen, used);
    });
  }

  function buildAccas(pool) {
    const used = new Set();
    return {
      levels: buildLevelAccas(pool, used),
      doubles: buildFixedAccas(pool, used, 2, [3.5, 5, 7], 3, 8, 'Експрес з 2 подій'),
      triples: buildFixedAccas(pool, used, 3, [10, 15, 22], 8, 25, 'Експрес з 3 подій'),
    };
  }

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

  function legRow(l, editable) {
    const started = l.ts * 1000 <= Date.now();
    return `
      <div class="leg ${started ? 'started' : ''}">
        <a href="#/match/${l.slug}/${l.id}" class="leg-main">
          <small>${esc(dateOf(l.ts))} ${esc(timeOf(l.ts))}${started ? ' · матч почався' : ''}</small>
          <em class="leg-league"><img src="${FP.leagueLogo(LEAGUE_BY_SLUG.get(l.slug))}" alt="">${esc(leagueLabel(l.slug))}</em>
          <span>${esc(l.home)} — ${esc(l.away)}</span>
          <b>${esc(l.short)}</b>
        </a>
        <div class="leg-num"><b>${pct(l.p)}</b><small>спр. ${fair(l.p)}</small></div>
        ${editable ? `
          <input class="leg-odds" data-odds="${esc(l.id)}" type="number" inputmode="decimal" step="0.01" min="1.01" placeholder="кф" value="${legOdds(l) ? legOdds(l).toFixed(2) : ''}">
          <button class="leg-x" data-remove="${esc(l.id)}" aria-label="Прибрати">✕</button>` : `<div class="leg-num"><b>${l.odds ? l.odds.toFixed(2) : '—'}</b><small>кф DK</small></div>`}
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
    const slugs = [...new Set(items.map(x => x.slug))];
    for (const slug of [...slugs.filter(s => !LEAGUE_BY_SLUG.get(s).cup), ...slugs.filter(s => LEAGUE_BY_SLUG.get(s).cup)]) {
      await ensureModel(slug);
      if (rid !== renderId) return;
    }
    await loadTeamStats(items);
    if (rid !== renderId) return;
    const pool = items.map(x => ({ ...x, pred: predictionFor(x.slug, x.ev) })).filter(x => x.pred);
    const { levels, doubles, triples } = buildAccas(pool);
    state.accas = [...levels, ...doubles, ...triples];

    let idx = 0;
    const card = a => {
      const i = idx++;
      if (!a.legs.length) {
        return `<section class="card acca-card"><div class="acca-title">${riskDots(a.risk)}<b>${esc(a.title)}</b></div>
          <p class="hint">Недостатньо відповідних матчів на найближчі 3 дні.</p></section>`;
      }
      const t = accaTotals(a.legs);
      return `
        <section class="card acca-card">
          <div class="acca-title">${riskDots(a.risk)}<b>${esc(a.title)}</b><span>кф ${t.fair.toFixed(2)}</span></div>
          <div class="acca-sub">Ймовірність ${t.p >= 0.01 ? pct(t.p) : '<1%'} · подій ${t.n}${t.odds ? ` · за кф DraftKings ${t.odds.toFixed(2)}` : ''}</div>
          <div class="legs">${a.legs.map(l => legRow(l, false)).join('')}</div>
          <div class="btn-row"><button class="btn ghost" data-load-acca="${i}">Завантажити в конструктор</button></div>
        </section>`;
    };

    document.getElementById('accas').innerHTML = `
      ${levels.map(card).join('')}
      <h2 class="section-title">З 2 подій · кф від 3 до 8</h2>
      ${doubles.map(card).join('')}
      <h2 class="section-title">З 3 подій · кф від 8 до 25</h2>
      ${triples.map(card).join('')}
      <p class="hint pad">Коефіцієнт тут справедливий (без маржі). Букмекер на кожну подію дає зазвичай на 5–8% менше, тож реальний кф експресу буде нижчим: на 6 подіях — приблизно на третину. Ймовірність показує, як часто такий експрес заходить: 5% — приблизно раз на 20 спроб. Матчі в різних експресах по можливості не повторюються.</p>`;
  }

  // Події купону: видалення, введення кф, очищення, завантаження готового експресу.
  $view.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove) { FP.slip.remove(b.dataset.remove); renderSlip(); }
    else if (b.dataset.slipClear) { FP.slip.clear(); renderSlip(); }
    else if (b.dataset.loadAcca != null && state.accas) {
      FP.slip.setAll(state.accas[Number(b.dataset.loadAcca)].legs);
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

  // ---------- Історія прогнозів ----------
  async function viewHistory() {
    const rid = ++renderId;
    setHeader('Історія');
    const entries = FP.history.all();
    if (!entries.length) {
      $view.innerHTML = `<div class="empty">Історія порожня.<br>Додаток запам'ятовує свої прогнози перед матчами, а після матчів показує тут, скільки з них зіграло.</div>`;
      return;
    }
    $view.innerHTML = '<div class="loading">Перевірка результатів…</div>';

    const slugs = [...new Set(entries.map(e => e.slug))].filter(s => LEAGUE_BY_SLUG.has(s));
    const results = new Map();
    await api.pool(slugs, 4, async slug => {
      try {
        const s = await api.season(slug);
        for (const ev of s.events) if (isFinished(ev)) results.set(ev.id, ev);
      } catch {}
    });
    if (rid !== renderId) return;

    const settled = [], pending = [];
    for (const e of entries) {
      const ev = results.get(e.id);
      if (!ev) { if (e.ts * 1000 > Date.now() - 3 * 864e5) pending.push(e); continue; }
      const h = ev.home.score, a = ev.away.score;
      settled.push({ ...e, h, a, tipRes: model.settle(e.tip.key, h, a), valRes: e.value ? model.settle(e.value.key, h, a) : undefined });
    }
    settled.sort((x, y) => y.ts - x.ts);

    const rate = list => {
      const done = list.filter(x => x.tipRes === true || x.tipRes === false);
      const hit = done.filter(x => x.tipRes).length;
      return done.length ? { hit, n: done.length, pct: hit / done.length } : null;
    };
    const all = rate(settled);
    const byLevel = [3, 2, 1].map(l => ({ l, r: rate(settled.filter(x => x.tip.level === l)) }));
    const vals = settled.filter(x => x.value && (x.valRes === true || x.valRes === false || x.valRes === null));
    const profit = vals.reduce((s, x) => s + (x.valRes === true ? x.value.odds - 1 : x.valRes === false ? -1 : 0), 0);
    const tipsWithOdds = settled.filter(x => x.tip.odds && (x.tipRes === true || x.tipRes === false));
    const tipProfit = tipsWithOdds.reduce((s, x) => s + (x.tipRes ? x.tip.odds - 1 : -1), 0);
    const fmtR = r => (r ? `<b>${Math.round(r.pct * 100)}%</b> <small>${r.hit} з ${r.n}</small>` : '—');
    const units = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

    $view.innerHTML = `
      <section class="card">
        <div class="league-stats">
          <div>${fmtR(all)}<span>основні ставки зіграли</span></div>
          <div><b class="${profit >= 0 ? 'ok' : 'bad'}">${vals.length ? units(profit) : '—'}</b><span>цінні ставки, прибуток в од.${vals.length ? ` (${vals.length})` : ''}</span></div>
          <div><b>${pending.length}</b><span>очікують результату</span></div>
        </div>
      </section>
      <section class="card">
        <h3>Влучність за рівнем впевненості</h3>
        <table class="markets"><tbody>
          ${byLevel.map(x => `<tr><td>${['', 'Низька', 'Середня', 'Висока'][x.l]}</td><td>${fmtR(x.r)}</td></tr>`).join('')}
          ${tipsWithOdds.length ? `<tr><td>Основні ставки за кф букмекера (1 од. на кожну)</td><td><b class="${tipProfit >= 0 ? 'ok' : 'bad'}">${units(tipProfit)}</b> <small>${tipsWithOdds.length} ст.</small></td></tr>` : ''}
          ${vals.length ? `<tr><td>Цінні ставки: ROI</td><td><b class="${profit >= 0 ? 'ok' : 'bad'}">${(profit / vals.length * 100).toFixed(1)}%</b></td></tr>` : ''}
        </tbody></table>
        <p class="hint">Записується останній прогноз перед стартом матчу. Об'єктивні висновки можна робити після кількох сотень ставок; на десятках результат сильно залежить від везіння.</p>
      </section>
      ${settled.length ? `<section class="card flush">
        <div class="table-wrap"><table class="standings history">
          <thead><tr><th class="tl">Матч</th><th>Рах.</th><th class="tl">Прогноз</th><th></th></tr></thead>
          <tbody>${settled.slice(0, 60).map(x => `<tr>
            <td class="tl"><small>${esc(dateOf(x.ts))} · ${esc(leagueLabel(x.slug))}</small><br>${esc(x.home)} — ${esc(x.away)}</td>
            <td>${x.h}:${x.a}</td>
            <td class="tl">${esc(x.tip.short)} <small>${pct(x.tip.p)}</small>${x.value ? `<br><small>цінна: ${esc(x.value.short)} @ ${x.value.odds.toFixed(2)} ${x.valRes === true ? '✓' : x.valRes === false ? '✗' : '↺'}</small>` : ''}</td>
            <td>${x.tipRes === true ? '<i class="ok">✓</i>' : x.tipRes === false ? '<i class="bad">✗</i>' : '↺'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}
      <div class="btn-row pad"><button id="hist-clear" class="btn ghost">Очистити історію</button></div>`;

    document.getElementById('hist-clear').onclick = () => {
      if (!confirm('Видалити всю історію прогнозів?')) return;
      FP.history.clear();
      viewHistory();
    };
  }

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
    } finally {
      ticking = false;
    }
  }
  setInterval(tick, TICK);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  route();
})();
