function toLocalDate(isoString) {
  return new Date(isoString).toLocaleDateString('sv');
}

const App = (() => {
  let categories = [];
  let currentScreen = 'dashboard';
  let lastGoalTimerKey = '';
  let lastDashTimerKey = '';
  let lastDashSessions = [];
  let todayJourneyPick = null;
  let focusCardDurations = new Map();
  let focusCardCustomEditing = new Map();
  let analyticsRange = { key: '14', customFrom: null, customTo: null };
  const finishedTimerCats = new Set();
  const expandedTargetPanels = new Set();

  function timerStateKey(timers) {
    return timers.map(t => `${t.categoryId}:${t.status}`).sort().join(',');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getCategoryById(id) {
    return categories.find(c => c.id === id) || null;
  }

  // Call after any change to `categories`, so every screen shows the same names and order.
  function syncCategories() {
    Timer.populateCategorySelect(categories);
    Pomodoro.populateCategorySelect(categories);
    Stopwatch.populateCategorySelect(categories);
    Logs.setCategories(categories);
  }

  function setCategoryDuration(catId, secs) {
    focusCardDurations.set(catId, secs);
    categories = categories.map(c => c.id === catId ? { ...c, defaultDuration: secs } : c);
    syncCategories();
    API.categories.setDefaultDuration(catId, secs).catch(() => {});
  }

  const fmtHours = Charts.fmtDur;
  const esc = Charts.esc;

  function fmtDeadlineShort(iso) {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function getPeriodLabel(period) {
    return { day: 'Today', week: 'This week', month: 'This month', year: 'This year' }[period] || 'This period';
  }

  function getPeriodShortLabel(period) {
    return { day: 'day', week: 'week', month: 'month', year: 'year' }[period] || 'period';
  }

  // The calendar day / week / month / year containing `date`, as local YYYY-MM-DD strings.
  function periodContaining(period, date) {
    const iso = d => d.toLocaleDateString('sv');
    const y = date.getFullYear();
    const m = date.getMonth();
    if (period === 'week') {
      const start = new Date(y, m, date.getDate() + (date.getDay() === 0 ? -6 : 1 - date.getDay()));
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return { from: iso(start), to: iso(end) };
    }
    if (period === 'month') return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    if (period === 'year')  return { from: `${y}-01-01`, to: `${y}-12-31` };
    return { from: iso(date), to: iso(date) };
  }

  function getPeriodBounds(period) {
    const now = new Date();
    return { from: periodContaining(period, now).from, to: now.toLocaleDateString('sv') };
  }

  function secsInRange(sessions, catId, from, to) {
    return sessions
      .filter(s => { const d = toLocalDate(s.startTime); return s.categoryId === catId && d >= from && d <= to; })
      .reduce((sum, s) => sum + s.durationSeconds, 0);
  }

  // Seven cells for a target: Mon–Sun for daily targets, otherwise the last seven periods.
  function goalHistory(c, sessions) {
    const now = new Date();
    const today = now.toLocaleDateString('sv');
    const targetSecs = c.targetValue * 3600;
    const dates = [];
    for (let i = 0; i < 7; i++) {
      if (c.targetPeriod === 'day') {
        const monday = new Date(periodContaining('week', now).from + 'T00:00:00');
        dates.push(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
      } else if (c.targetPeriod === 'week') {
        dates.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i) * 7));
      } else if (c.targetPeriod === 'month') {
        dates.push(new Date(now.getFullYear(), now.getMonth() - (6 - i), 1));
      } else {
        dates.push(new Date(now.getFullYear() - (6 - i), 0, 1));
      }
    }
    return dates.map(date => {
      const { from, to } = periodContaining(c.targetPeriod, date);
      const secs = from > today ? 0 : secsInRange(sessions, c.id, from, to);
      const when = {
        day:   date.toLocaleDateString('en-US', { weekday: 'long' }),
        week:  `Week of ${new Date(from + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        month: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        year:  String(date.getFullYear()),
      }[c.targetPeriod];
      const label = {
        day:   date.toLocaleDateString('en-US', { weekday: 'narrow' }),
        week:  String(new Date(from + 'T00:00:00').getDate()),
        month: date.toLocaleDateString('en-US', { month: 'narrow' }),
        year:  `'${String(date.getFullYear()).slice(2)}`,
      }[c.targetPeriod];
      return {
        label,
        title: `${when}: ${fmtHours(secs)} of ${c.targetValue}h`,
        ratio: Math.min(secs / targetSecs, 1),
        met: secs >= targetSecs,
        future: from > today,
        current: from <= today && to >= today,
      };
    });
  }

  function goalCellsHTML(c, sessions) {
    return `
      <div class="goal-cells" style="--goal-color:${c.color}">
        ${goalHistory(c, sessions).map(cell => `
          <div class="goal-cell${cell.future ? ' goal-cell--future' : ''}${cell.current ? ' goal-cell--current' : ''}" title="${cell.title}">
            <div class="goal-cell__box" style="--fill:${Math.round(cell.ratio * 100)}%">${cell.met ? '<i data-lucide="check"></i>' : ''}</div>
            <div class="goal-cell__label">${cell.label}</div>
          </div>`).join('')}
      </div>`;
  }

  function computeStreak(c, sessions) {
    if (!c.targetValue || !c.targetPeriod) return 0;
    const targetSecs = c.targetValue * 3600;
    const catSessions = sessions.filter(s => s.categoryId === c.id);
    const now = new Date();
    let streak = 0;
    let offset = 1;
    while (offset <= 365) {
      let from, to;
      if (c.targetPeriod === 'day') {
        const d = new Date(now);
        d.setDate(d.getDate() - offset);
        from = to = d.toLocaleDateString('sv');
      } else if (c.targetPeriod === 'week') {
        const d = new Date(now);
        const dow = d.getDay();
        d.setDate(d.getDate() + ((dow === 0 ? -6 : 1) - dow) - offset * 7);
        from = d.toLocaleDateString('sv');
        const end = new Date(d); end.setDate(end.getDate() + 6);
        to = end.toLocaleDateString('sv');
      } else if (c.targetPeriod === 'month') {
        const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        from = d.toLocaleDateString('sv');
        to = new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString('sv');
      } else if (c.targetPeriod === 'year') {
        const y = now.getFullYear() - offset;
        from = `${y}-01-01`; to = `${y}-12-31`;
      } else break;
      const secs = catSessions.filter(s => { const d = toLocalDate(s.startTime); return d >= from && d <= to; }).reduce((sum, s) => sum + s.durationSeconds, 0);
      if (secs >= targetSecs) { streak++; offset++; } else break;
    }
    return streak;
  }

  // ── Global sound UI (Goals header) ────────────────────────────────────────
  function updateGlobalSoundUI(soundName) {
    const strip    = document.querySelector('.global-sound-strip');
    const nameSpan = document.getElementById('globalSoundName');
    const testBtn  = document.getElementById('btnGlobalTestSound');
    const resetBtn = document.getElementById('btnGlobalResetSound');
    if (!strip) return;
    const hasSound = !!soundName;
    strip.classList.toggle('global-sound-strip--active', hasSound);
    if (nameSpan)  nameSpan.textContent = soundName || 'No sound';
    if (testBtn)   testBtn.hidden  = !hasSound;
    if (resetBtn)  resetBtn.hidden = !hasSound || soundName === 'Default';
  }

  // ── Screen routing ─────────────────────────────────────────────────────────
  function closeAllModals() {
    document.getElementById('newCategoryModal').hidden    = true;
    document.getElementById('customDurationModal').hidden = true;
    document.getElementById('confirmDeleteModal').hidden  = true;
    document.getElementById('sessionModal').hidden        = true;
    Trackers.closeAll();
  }

  function showDeleteConfirm(catName, sessionCount, timeStr) {
    return new Promise(resolve => {
      const backdrop  = document.getElementById('confirmDeleteModal');
      const body      = document.getElementById('confirmDeleteBody');
      const warning   = document.getElementById('confirmDeleteWarning');
      const sessionsEl = document.getElementById('confirmDeleteSessions');
      const okBtn     = document.getElementById('btnConfirmDeleteOk');
      const cancelBtn = document.getElementById('btnConfirmDeleteCancel');

      body.textContent = `"${catName}" will be permanently removed.`;

      if (sessionCount > 0) {
        sessionsEl.textContent = `This category has ${sessionCount} recorded session${sessionCount !== 1 ? 's' : ''} (${timeStr} total). All logged time will also be erased.`;
        warning.hidden = false;
      } else {
        warning.hidden = true;
      }

      backdrop.hidden = false;
      lucide.createIcons({ nodes: [backdrop] });

      function finish(result) {
        backdrop.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        resolve(result);
      }
      function onOk()       { finish(true);  }
      function onCancel()   { finish(false); }
      function onBackdrop(e) { if (e.target === backdrop) finish(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
    });
  }

  function showScreen(name) {
    closeAllModals();
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = s.id !== `screen-${name}`;
    });
    document.querySelectorAll('.sidebar__nav-item').forEach(a => {
      const active = a.dataset.screen === name;
      a.classList.toggle('is-active', active);
      a.setAttribute('aria-current', active ? 'page' : 'false');
    });
    currentScreen = name;
    if (name === 'dashboard') refreshDashboard();
    if (name === 'log')       Logs.refresh();
    if (name === 'analytics') refreshAnalytics();
    if (name === 'goals')     renderGoals();
    if (name === 'trackers')  Trackers.refresh();
    if (name === 'notes')     Notes.refresh();
    if (name === 'pomodoro')  Pomodoro.refresh();
    if (name === 'settings')  Settings.refresh();
  }

  function bindNav() {
    document.querySelectorAll('.sidebar__nav-item').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        showScreen(a.dataset.screen);
      });
    });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  async function refreshDashboard() {
    if (currentScreen !== 'dashboard') return;

    const dateEl = document.getElementById('dashboardDate');
    if (dateEl) {
      dateEl.textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
    }

    try {
      const { sessions } = await API.logs.list();

      const today = new Date().toLocaleDateString('sv');
      const weekStart = (() => {
        const d = new Date();
        const day = d.getDay();
        const diff = (day === 0 ? -6 : 1) - day;
        d.setDate(d.getDate() + diff);
        return d.toLocaleDateString('sv');
      })();

      const todayTotal = sessions
        .filter(s => toLocalDate(s.startTime) === today)
        .reduce((sum, s) => sum + s.durationSeconds, 0);

      const weekTotal = sessions
        .filter(s => toLocalDate(s.startTime) >= weekStart)
        .reduce((sum, s) => sum + s.durationSeconds, 0);

      const todaySessions = sessions.filter(s => toLocalDate(s.startTime) === today);

      const lastWeekStart = new Date(weekStart + 'T00:00:00');
      lastWeekStart.setDate(lastWeekStart.getDate() - 7);
      const lastWeekFrom = lastWeekStart.toLocaleDateString('sv');
      const lastWeekTotal = sessions
        .filter(s => { const d = toLocalDate(s.startTime); return d >= lastWeekFrom && d < weekStart; })
        .reduce((sum, s) => sum + s.durationSeconds, 0);

      document.getElementById('statToday').textContent    = fmtHours(todayTotal);
      document.getElementById('statWeek').textContent     = fmtHours(weekTotal);
      document.getElementById('statWeekNote').textContent = `${fmtHours(lastWeekTotal)} last week`;
      document.getElementById('statSessions').textContent = todaySessions.length;
      document.getElementById('statSessionsNote').textContent = todaySessions.length
        ? `${fmtHours(Math.max(...todaySessions.map(s => s.durationSeconds)))} longest`
        : '';

      lastDashSessions = sessions;
      renderInProgress(Timer.getTimers());
      renderTodayTimeline(todaySessions);
      renderDashboardGoals(sessions);
      renderTodayJourney(sessions);
      await Trackers.load();
      renderComingUp();
    } catch (err) { console.error(err); }
  }

  // The total-hours goal with the most recent activity, with chips to switch if there are several
  function renderTodayJourney(sessions) {
    const card = document.getElementById('todayJourney');
    if (!card) return;
    const goals = categories.filter(c => !c.archived && c.lifetimeTarget);
    card.hidden = false;
    if (!goals.length) {
      card.innerHTML = `
        <div class="card__head">
          <h2 class="card__title journey__title"><i data-lucide="milestone"></i> Long-term goal journey</h2>
        </div>
        <div class="today-empty">
          <p>Give a category a total, like 1,000 hours of Japanese. You'll see your pace, a finish date and milestones here.</p>
          <button class="btn btn--ghost btn--sm" data-journey-goals><i data-lucide="plus"></i> Set a total-hours goal</button>
        </div>`;
      lucide.createIcons({ nodes: [card] });
      return;
    }

    const lastActive = c => sessions.filter(s => s.categoryId === c.id).reduce((m, s) => (s.startTime > m ? s.startTime : m), '');
    if (!goals.some(c => c.id === todayJourneyPick)) {
      todayJourneyPick = [...goals].sort((a, b) => lastActive(b).localeCompare(lastActive(a)))[0].id;
    }
    const c = goals.find(g => g.id === todayJourneyPick);

    const chips = goals.length > 1
      ? `<div class="segmented segmented--sm" role="group" aria-label="Choose a goal">
           ${goals.slice(0, 4).map(g => `<button class="segmented__btn${g.id === c.id ? ' is-active' : ''}" data-journey-pick="${g.id}" aria-pressed="${g.id === c.id}">${esc(g.name)}</button>`).join('')}
         </div>`
      : '';

    card.innerHTML = `
      <div class="card__head">
        <h2 class="card__title journey__title"><i data-lucide="milestone"></i> Long-term goal journey</h2>
        <div class="journey__head-tools">
          ${chips}
          <button class="link-btn" data-journey-goals>Goals <i data-lucide="arrow-up-right"></i></button>
        </div>
      </div>
      ${Journey.cardHTML(c, sessions, { key: 'today', compact: true, label: true })}`;
    lucide.createIcons({ nodes: [card] });
    Journey.mount(card);
  }

  // "In progress": every running or paused timer, live, with Pause/Resume and Stop.
  // Pomodoro has no pause (true to the technique), so its row only opens the Pomodoro screen.
  function renderInProgress(timers) {
    const card = document.getElementById('todayInProgress');
    if (!card) return;
    card.hidden = timers.length === 0;
    if (!timers.length) { card.innerHTML = ''; return; }

    const running = timers.filter(t => t.status === 'running').length;
    const note = running ? `${running} running` : 'Paused';

    card.innerHTML = `
      <div class="card__head">
        <h2 class="card__title">In progress</h2>
        <span class="card__note">${note}</span>
      </div>
      <ul class="in-progress__list">
        ${timers.map(t => {
          const cat = t.categoryId !== '__none__' ? getCategoryById(t.categoryId) : null;
          const isBreak = t.pomodoroPhase === 'short-break' || t.pomodoroPhase === 'long-break';
          const name = isBreak ? 'Break' : (cat?.name ?? 'No category');
          const kind = t.pomodoroPhase ? 'Pomodoro' : `${fmtHours(t.durationSeconds)} timer`;
          const id = esc(t.categoryId);
          const state = t.status === 'finished' ? 'Finished' : t.status === 'paused' ? 'Paused' : '';
          let actions;
          if (t.pomodoroPhase) {
            actions = `<button class="btn btn--ghost" data-ip-pomodoro><i data-lucide="arrow-up-right"></i> Open Pomodoro</button>`;
          } else {
            const toggle = t.status === 'finished' ? '' : t.status === 'running'
              ? `<button class="btn btn--ghost" data-ip-toggle="${id}"><i data-lucide="pause"></i> Pause</button>`
              : `<button class="btn btn--ghost" data-ip-toggle="${id}"><i data-lucide="play"></i> Resume</button>`;
            actions = `${toggle}<button class="btn btn--primary" data-ip-stop="${id}"><i data-lucide="square"></i> Stop</button>`;
          }
          return `
            <li class="in-progress__row" data-ip-row="${id}">
              <div class="in-progress__who">
                <span class="in-progress__name">
                  <span class="pulse-dot${t.status === 'running' ? '' : ' pulse-dot--static'}" style="--dot-color:${cat?.color ?? 'var(--text-muted)'}"></span>
                  ${esc(name)}
                </span>
                <span class="in-progress__meta">${kind} · <span data-ip-done>${fmtHours(t.durationSeconds - t.remainingSeconds)}</span> done${state ? ` · ${state}` : ''}</span>
              </div>
              <div class="in-progress__clock" role="timer" aria-label="Time left" data-ip-clock>${Timer.fmtTime(t.remainingSeconds)}</div>
              <div class="in-progress__actions">${actions}</div>
            </li>`;
        }).join('')}
      </ul>`;
    lucide.createIcons({ nodes: [card] });
  }

  // Every second: only the numbers change
  function tickInProgress(timers) {
    timers.forEach(t => {
      const row = document.querySelector(`#todayInProgress [data-ip-row="${CSS.escape(t.categoryId)}"]`);
      if (!row) return;
      row.querySelector('[data-ip-clock]').textContent = Timer.fmtTime(t.remainingSeconds);
      row.querySelector('[data-ip-done]').textContent = fmtHours(t.durationSeconds - t.remainingSeconds);
    });
  }

  function renderComingUp() {
    const card = document.getElementById('todayComingUp');
    if (!card) return;
    card.innerHTML = Trackers.comingUpHTML(3);
    lucide.createIcons({ nodes: [card] });
  }
  // A 24-hour strip of today: one block per session, placed at the time it happened.
  function renderTodayTimeline(todaySessions) {
    const container = document.getElementById('todayTimeline');
    if (!container) return;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const pctOfDay = secs => (secs / 86400) * 100;
    const nowPct = pctOfDay((Date.now() - dayStart) / 1000);

    // A paused session draws one block per worked stretch, with the pause left empty
    const blocks = todaySessions.flatMap(s => {
      const cat = getCategoryById(s.categoryId);
      const color = cat ? cat.color : 'var(--text-muted)';
      return sessionSegments(s).map(seg => {
        const left = Math.max(0, pctOfDay((seg.start - dayStart) / 1000));
        const width = Math.min(pctOfDay(seg.seconds), 100 - left);
        const startLabel = seg.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `<div class="daybar__block" style="left:${left}%;width:${width}%;background:${color}"
                     title="${esc(cat ? cat.name : s.categoryId)}: ${fmtHours(seg.seconds)} from ${startLabel}"></div>`;
      });
    }).join('');

    const totals = categories
      .map(c => ({ ...c, secs: todaySessions.filter(s => s.categoryId === c.id).reduce((sum, s) => sum + s.durationSeconds, 0) }))
      .filter(c => c.secs > 0)
      .sort((a, b) => b.secs - a.secs);

    const legend = totals.length
      ? totals.map(c => `
          <span class="chart-legend__item">
            <span class="chart-legend__dot" style="background:${c.color}"></span>${esc(c.name)}
            <span class="chart-legend__value">${fmtHours(c.secs)}</span>
          </span>`).join('')
      : `<span class="today__empty">Nothing tracked yet today. Sessions show up here as you finish them.</span>`;

    container.innerHTML = `
      <div class="daybar" role="img" aria-label="Today's sessions on a 24-hour timeline">
        <div class="daybar__track">
          ${blocks}
          <div class="daybar__now" style="left:${nowPct}%"></div>
        </div>
        <span class="daybar__now-label" style="left:${nowPct}%" aria-hidden="true">Now</span>
        <div class="daybar__ticks" aria-hidden="true">
          <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
        </div>
      </div>
      <div class="chart-legend today__legend">${legend}</div>`;
  }

  // Recurring targets (2h a day, 14h a week): plain done/target, a thin bar and the streak
  function renderDashboardGoals(sessions) {
    const container = document.getElementById('dashboardGoals');
    if (!container) return;

    // Total-hours goals have their own journey card
    const goals = categories.filter(c => !c.archived && c.targetValue && c.targetPeriod);
    container.hidden = false;

    // "Nov 2–8": this week, Monday to Sunday
    const wk = periodContaining('week', new Date());
    const wkStart = new Date(wk.from + 'T12:00:00');
    const wkEnd = new Date(wk.to + 'T12:00:00');
    const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const range = wkStart.getMonth() === wkEnd.getMonth() ? `${md(wkStart)}–${wkEnd.getDate()}` : `${md(wkStart)}–${md(wkEnd)}`;
    const head = `
      <div class="card__head">
        <h2 class="card__title">This week's goals</h2>
        <span class="card__note">${range}</span>
      </div>`;

    if (goals.length === 0) {
      container.innerHTML = `${head}
        <div class="today-empty">
          <p>Set a regular target, like 2 hours a day or 14 hours a week. Your progress and streaks show up here.</p>
          <button class="btn btn--ghost btn--sm" data-dash-open><i data-lucide="plus"></i> Set a weekly target</button>
        </div>`;
      lucide.createIcons({ nodes: [container] });
      return;
    }

    const timers = Timer.getTimers();

    container.innerHTML = `${head}
      <ul class="week-goals">
        ${goals.map(c => {
          const { from, to } = getPeriodBounds(c.targetPeriod);
          const periodSecs = secsInRange(sessions, c.id, from, to);
          const pct = Math.min(Math.round((periodSecs / (c.targetValue * 3600)) * 100), 100);
          const streak = computeStreak(c, sessions);
          const running = timers.some(t => t.categoryId === c.id && t.status === 'running');
          return `
            <li class="week-goal">
              <div class="week-goal__top">
                <span class="goal-row__name"><span class="breakdown-item__dot" style="background:${c.color}"></span>${esc(c.name)}</span>
                <span class="week-goal__streak">
                  ${running ? '<span class="pulse-dot"></span> Running' : ''}
                  ${!running && streak > 0 ? `<i data-lucide="repeat"></i> ${streak}-${getPeriodShortLabel(c.targetPeriod)} streak` : ''}
                </span>
              </div>
              <div class="goal-row__amount"><strong>${fmtHours(periodSecs)}</strong> of ${fmtHours(c.targetValue * 3600)} ${getPeriodLabel(c.targetPeriod).toLowerCase()}</div>
              <div class="goal-row__bar"><div class="goal-row__fill" style="width:${pct}%;background:${c.color}"></div></div>
            </li>`;
        }).join('')}
      </ul>`;

    lucide.createIcons({ nodes: [container] });
  }

  function bindDashboardControls() {
    document.getElementById('dashboardGoals').addEventListener('click', e => {
      if (e.target.closest('[data-dash-open]')) showScreen('goals');
    });

    document.getElementById('todayJourney').addEventListener('click', e => {
      if (e.target.closest('[data-journey-goals]')) { showScreen('goals'); return; }
      const pick = e.target.closest('[data-journey-pick]');
      if (!pick) return;
      todayJourneyPick = pick.dataset.journeyPick;
      renderTodayJourney(lastDashSessions);
    });

    Trackers.bindComingUp(document.getElementById('todayComingUp'));

    document.getElementById('todayInProgress').addEventListener('click', async e => {
      if (e.target.closest('[data-ip-pomodoro]')) { showScreen('pomodoro'); return; }
      const toggle = e.target.closest('[data-ip-toggle]');
      const stop = e.target.closest('[data-ip-stop]');
      if (!toggle && !stop) return;
      (toggle || stop).disabled = true;
      AlertSound.stop('today-control');
      try {
        if (stop) {
          await API.timer.stop(stop.dataset.ipStop);
          refreshDashboard();
          Logs.refresh();
        } else {
          const catId = toggle.dataset.ipToggle;
          const t = Timer.getTimers().find(x => x.categoryId === catId && !x.pomodoroPhase);
          if (t?.status === 'running') await API.timer.pause(catId);
          else await API.timer.start({ categoryId: catId });
        }
      } catch (err) { console.error(err); (toggle || stop).disabled = false; }
    });
  }

  function categoryTotals(sessions) {
    return categories
      .filter(c => !c.archived)
      .map(c => ({
        ...c,
        secs: sessions.filter(s => s.categoryId === c.id).reduce((sum, s) => sum + s.durationSeconds, 0),
      }))
      .filter(c => c.secs > 0)
      .sort((a, b) => b.secs - a.secs);
  }

  function breakdownHTML(totals) {
    const max = totals[0].secs;
    const sum = totals.reduce((acc, c) => acc + c.secs, 0);
    return totals.map(c => `
      <div class="breakdown-item">
        <div class="breakdown-item__name">
          <div class="breakdown-item__dot" style="background:${c.color}"></div>
          <span class="breakdown-item__label">${esc(c.name)}</span>
        </div>
        <div class="breakdown-item__share">${Math.round((c.secs / sum) * 100)}%</div>
        <div class="breakdown-item__time">${fmtHours(c.secs)}</div>
        <div class="breakdown-bar">
          <div class="breakdown-bar__fill" style="width:${Math.round((c.secs / max) * 100)}%;background:${c.color}"></div>
        </div>
      </div>`).join('');
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  function getAnalyticsDates(sessions) {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const key = analyticsRange.key;

    if (key === 'today') {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      return { from, to: today, label: from.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) };
    }

    if (key === 'all') {
      let earliest = today.toLocaleDateString('sv');
      sessions.forEach(s => { if (toLocalDate(s.startTime) < earliest) earliest = toLocalDate(s.startTime); });
      const from = new Date(earliest + 'T00:00:00');
      const fromLabel = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return { from, to: today, label: `All time, since ${fromLabel}` };
    }

    if (key === 'custom') {
      const fromStr = analyticsRange.customFrom || today.toLocaleDateString('sv');
      const toStr   = analyticsRange.customTo   || today.toLocaleDateString('sv');
      const from = new Date(fromStr + 'T00:00:00');
      const to   = new Date(toStr   + 'T23:59:59');
      const fromLabel = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const toLabel   = to.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return { from, to, label: `${fromLabel} – ${toLabel}` };
    }

    const days = parseInt(key);
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    from.setHours(0, 0, 0, 0);
    return { from, to: today, label: `Last ${days} days` };
  }

  async function refreshAnalytics() {
    try {
      const { sessions } = await API.logs.list();
      const { from, to, label } = getAnalyticsDates(sessions);

      const fromStr = from.toLocaleDateString('sv');
      const toStr   = to.toLocaleDateString('sv');
      const inRange = sessions.filter(s => { const d = toLocalDate(s.startTime); return d >= fromStr && d <= toStr; });
      const totals  = categoryTotals(inRange);

      document.getElementById('analyticsRangeLabel').textContent = label;

      const unit = Charts.renderDailyChart(sessions, categories, from, to);
      document.getElementById('analyticsBarLabel').textContent = unit === 'hour' ? 'Time by hour' : `Hours per ${unit}`;

      Charts.renderDoughnutChart(totals);
      document.getElementById('doughnutTotal').textContent = fmtHours(totals.reduce((sum, c) => sum + c.secs, 0));
      document.getElementById('analyticsBreakdown').innerHTML = totals.length
        ? breakdownHTML(totals)
        : `<p class="muted-note">No sessions in this range.</p>`;

      renderKpis(sessions, inRange, totals, from, to);
      renderHeatmap(inRange);
      renderGoalReview(sessions, inRange, from, to);
      lucide.createIcons({ nodes: [document.getElementById('screen-analytics')] });
    } catch (err) { console.error(err); }
  }

  function renderKpis(sessions, inRange, totals, from, to) {
    const container = document.getElementById('analyticsKpis');
    if (!container) return;

    const rangeDays = Math.floor((to - from) / 86400000) + 1;
    const total = inRange.reduce((sum, s) => sum + s.durationSeconds, 0);
    const activeDays = new Set(inRange.map(s => toLocalDate(s.startTime))).size;

    let comparison = '';
    if (analyticsRange.key !== 'all') {
      const prevTo = new Date(from);
      prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom = new Date(prevTo);
      prevFrom.setDate(prevFrom.getDate() - (rangeDays - 1));
      const prevFromStr = prevFrom.toLocaleDateString('sv');
      const prevToStr   = prevTo.toLocaleDateString('sv');
      const prevTotal = sessions
        .filter(s => { const d = toLocalDate(s.startTime); return d >= prevFromStr && d <= prevToStr; })
        .reduce((sum, s) => sum + s.durationSeconds, 0);
      comparison = `${analyticsRange.key === 'today' ? 'Yesterday' : `Prior ${rangeDays} days`}: ${fmtHours(prevTotal)}`;
    }

    const top = totals[0];
    const longest = inRange.reduce((best, s) => (!best || s.durationSeconds > best.durationSeconds ? s : best), null);
    const longestCat = longest ? getCategoryById(longest.categoryId) : null;

    const kpi = (label, value, note) => `
      <div class="kpi">
        <div class="label">${label}</div>
        <div class="kpi__value">${value}</div>
        <div class="kpi__note">${note}</div>
      </div>`;

    container.innerHTML = [
      kpi('Total tracked', fmtHours(total), comparison || `${inRange.length} session${inRange.length === 1 ? '' : 's'}`),
      kpi('Per day', fmtHours(total / rangeDays), `Averaged over ${rangeDays} day${rangeDays === 1 ? '' : 's'}`),
      kpi('Active days', `${activeDays}`, `of ${rangeDays}`),
      kpi('Most time on', top ? esc(top.name) : '—', top ? fmtHours(top.secs) : 'No sessions'),
      kpi('Longest session', longest ? fmtHours(longest.durationSeconds) : '—', longestCat ? esc(longestCat.name) : 'No sessions'),
    ].join('');
  }

  // Weekday × hour grid: shows the rhythm of when tracked time actually happens.
  function renderHeatmap(inRange) {
    const container = document.getElementById('analyticsHeatmap');
    if (!container) return;

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const grid = dayNames.map(() => new Array(24).fill(0));

    inRange.forEach(s => Charts.forEachHourSlice(s, (date, secs) => {
      grid[(date.getDay() + 6) % 7][date.getHours()] += secs;
    }));

    let max = 0, peakDay = 0, peakHour = 0;
    grid.forEach((row, d) => row.forEach((v, h) => { if (v > max) { max = v; peakDay = d; peakHour = h; } }));

    if (max === 0) {
      container.innerHTML = `<p class="muted-note">No sessions in this range.</p>`;
      return;
    }

    const longNames = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
    const peak = `Most often ${longNames[peakDay]} around ${Charts.hourLabel(peakHour)}`;

    const rows = grid.map((row, d) => `
      <div class="heatmap__day">${dayNames[d]}</div>
      ${row.map((v, h) => `<div class="heatmap__cell${v > 0 ? ' heatmap__cell--on' : ''}"
        ${v > 0 ? `style="--v:${Math.round(20 + (v / max) * 80)}%"` : ''}
        title="${dayNames[d]} ${Charts.hourLabel(h)}: ${fmtHours(v)}"></div>`).join('')}`).join('');

    const hourTicks = Array.from({ length: 24 }, (_, h) =>
      `<div class="heatmap__hour">${h % 6 === 0 ? Charts.hourLabel(h) : ''}</div>`).join('');

    container.innerHTML = `
      <div class="heatmap" role="img" aria-label="${peak}">
        ${rows}
        <div></div>
        ${hourTicks}
      </div>
      <div class="heatmap__foot">
        <span>${peak}</span>
        <span class="heatmap__scale" aria-hidden="true">
          Less
          <i style="--v:20%"></i><i style="--v:45%"></i><i style="--v:70%"></i><i style="--v:100%"></i>
          More
        </span>
      </div>`;
  }

  function bindAnalyticsControls() {
    document.getElementById('analyticsRangeBar').addEventListener('click', e => {
      const pill = e.target.closest('[data-range]');
      if (!pill) return;
      const range = pill.dataset.range;

      document.querySelectorAll('#analyticsRangeBar .segmented__btn').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');

      const customRow = document.getElementById('analyticsCustomRange');
      if (range === 'custom') {
        customRow.hidden = false;
        const todayStr = new Date().toLocaleDateString('sv');
        const defaultFrom = new Date();
        defaultFrom.setDate(defaultFrom.getDate() - 29);
        document.getElementById('analyticsFrom').value = analyticsRange.customFrom || defaultFrom.toLocaleDateString('sv');
        document.getElementById('analyticsTo').value   = analyticsRange.customTo   || todayStr;
      } else {
        customRow.hidden = true;
        analyticsRange = { key: range, customFrom: null, customTo: null };
        if (currentScreen === 'analytics') refreshAnalytics();
      }
    });

    document.getElementById('applyCustomRange').addEventListener('click', () => {
      const from = document.getElementById('analyticsFrom').value;
      const to   = document.getElementById('analyticsTo').value;
      if (!from || !to || from > to) return;
      analyticsRange = { key: 'custom', customFrom: from, customTo: to };
      if (currentScreen === 'analytics') refreshAnalytics();
    });
  }

  // Every calendar period that overlaps the range, oldest first.
  function periodsInRange(period, from, to) {
    const list = [];
    const endStr = to.toLocaleDateString('sv');
    let cursor = new Date(from);
    while (cursor.toLocaleDateString('sv') <= endStr) {
      const p = periodContaining(period, cursor);
      list.push(p);
      const next = new Date(p.to + 'T00:00:00');
      next.setDate(next.getDate() + 1);
      cursor = next;
    }
    return list;
  }

  // Goals over the selected range: what was done and how often the target was reached.
  function renderGoalReview(sessions, inRange, from, to) {
    const card = document.getElementById('analyticsGoalsCard');
    const container = document.getElementById('goalProgressList');
    if (!container) return;

    const goals = categories.filter(c => !c.archived && (c.targetValue || c.lifetimeTarget));
    card.hidden = goals.length === 0;

    container.innerHTML = goals.map(c => {
      const rangeSecs = inRange.filter(s => s.categoryId === c.id).reduce((sum, s) => sum + s.durationSeconds, 0);

      let reachedHTML = '';
      if (c.targetValue && c.targetPeriod) {
        const periods = periodsInRange(c.targetPeriod, from, to);
        const reached = periods.filter(p => secsInRange(sessions, c.id, p.from, p.to) >= c.targetValue * 3600).length;
        const noun = getPeriodShortLabel(c.targetPeriod);
        reachedHTML = `
          <div class="goal-review__stat">
            <div class="label">${c.targetValue}h a ${noun}</div>
            <div class="goal-review__value">${reached} of ${periods.length}</div>
            <div class="goal-review__note">${noun}${periods.length === 1 ? '' : 's'} reached</div>
          </div>`;
      }

      let lifetimeHTML = '';
      if (c.lifetimeTarget) {
        const countedSecs = Journey.countedSecs(c, sessions);
        const pct = Math.min((countedSecs / 3600 / c.lifetimeTarget) * 100, 100);
        lifetimeHTML = `
          <div class="goal-review__lifetime">
            <div class="goal-review__lifetime-row">
              <span>${Journey.hint(c, sessions)}</span>
            </div>
            <div class="goal-row__bar"><div class="goal-row__fill" style="width:${pct}%;background:${c.color}"></div></div>
          </div>`;
      }

      return `
        <div class="goal-review">
          <div class="goal-row__name">
            <span class="breakdown-item__dot" style="background:${c.color}"></span>${esc(c.name)}
          </div>
          <div class="goal-review__stat">
            <div class="label">In this range</div>
            <div class="goal-review__value">${fmtHours(rangeSecs)}</div>
          </div>
          ${reachedHTML || '<div></div>'}
          ${lifetimeHTML}
        </div>`;
    }).join('');
  }

  // ── Goals screen (Focus cards) ─────────────────────────────────────────────

  function focusTimerSectionHTML(c, activeTimer) {
    if (finishedTimerCats.has(c.id)) {
      return `
        <div class="focus-card__done-row">
          <button class="btn btn--primary btn--sm" data-focus-done="${c.id}">
            <i data-lucide="check"></i> Done
          </button>
        </div>`;
    }

    if (!activeTimer) {
      const selectedDur = focusCardDurations.get(c.id) || 1800;
      const standardSecs = [600, 1500, 1800, 3600, 7200];
      const isEditing    = focusCardCustomEditing.get(c.id) || false;

      if (isEditing) {
        const editMins = Math.round(selectedDur / 60);
        return `
          <div class="focus-card__custom-editor">
            <button class="btn btn--ghost btn--sm btn--icon" data-focus-custom-dec="${c.id}" aria-label="Subtract 1 minute">
              <i data-lucide="minus"></i>
            </button>
            <input type="number" class="focus-card__custom-input focus-card__custom-input--lg"
                   value="${editMins}" min="1" max="480"
                   data-focus-custom-val="${c.id}" aria-label="Duration in minutes" />
            <span class="focus-card__time-unit">min</span>
            <button class="btn btn--ghost btn--sm btn--icon" data-focus-custom-inc="${c.id}" aria-label="Add 1 minute">
              <i data-lucide="plus"></i>
            </button>
            <button class="btn btn--ghost btn--sm" data-focus-custom-cancel="${c.id}">Cancel</button>
            <button class="btn btn--primary btn--sm" data-focus-custom-ok="${c.id}">Set</button>
          </div>`;
      }

      const durations = standardSecs.includes(selectedDur) ? standardSecs : [...standardSecs, selectedDur].sort((a, b) => a - b);
      const startStyle = (c.targetValue || c.lifetimeTarget) ? 'btn--primary' : 'btn--ghost';

      return `
        <div class="focus-card__idle-action">
          <select class="form-select form-select--sm focus-card__duration" data-focus-duration="${c.id}" aria-label="Timer length for ${esc(c.name)}">
            ${durations.map(secs => `<option value="${secs}"${secs === selectedDur ? ' selected' : ''}>${fmtHours(secs)}</option>`).join('')}
            <option value="custom">Custom…</option>
          </select>
          <button class="btn ${startStyle} btn--sm" data-focus-start="${c.id}" aria-label="Start ${fmtHours(selectedDur)} timer for ${esc(c.name)}">
            <i data-lucide="play"></i> Start
          </button>
        </div>`;
    }

    const time = Timer.fmtTime(activeTimer.remainingSeconds);
    const isRunning = activeTimer.status === 'running';

    return `
      <div class="focus-card__active-row">
        <div class="focus-card__active-status">
          <span class="pulse-dot${isRunning ? '' : ' pulse-dot--static'}"></span>
          <span class="focus-card__countdown">${time}</span>
          <span class="focus-card__status-label" style="color:${isRunning ? 'var(--color-success)' : 'var(--color-warning)'}">${isRunning ? 'running' : 'paused'}</span>
        </div>
        <div class="focus-card__active-actions">
          ${isRunning
            ? `<button class="btn btn--ghost btn--sm" data-focus-pause="${c.id}"><i data-lucide="pause"></i> Pause</button>`
            : `<button class="btn btn--ghost btn--sm" data-focus-resume="${c.id}"><i data-lucide="play"></i> Resume</button>`
          }
          <button class="btn btn--danger btn--sm" data-focus-stop="${c.id}"><i data-lucide="square"></i> Stop</button>
        </div>
      </div>`;
  }

  function targetPanelHTML(c, isExpanded) {
    const hasGoal = c.targetValue || c.lifetimeTarget;
    return `
      <div class="target-panel" data-cat-id="${c.id}"${isExpanded ? '' : ' hidden'}>
        <div class="target-panel__body">
          <div class="target-panel__field">
            <label class="form-label">Regular target</label>
            <div class="target-panel__period-row">
              <input type="number" class="form-input form-input--sm" placeholder="Hours" min="0.5" step="0.5"
                     value="${c.targetValue || ''}" data-target-value="${c.id}" aria-label="Hours per period" />
              <select class="form-select form-select--sm" data-target-period="${c.id}" aria-label="Period">
                <option value="day"${c.targetPeriod === 'day' ? ' selected' : ''}>/ day</option>
                <option value="week"${(!c.targetPeriod || c.targetPeriod === 'week') ? ' selected' : ''}>/ week</option>
                <option value="month"${c.targetPeriod === 'month' ? ' selected' : ''}>/ month</option>
                <option value="year"${c.targetPeriod === 'year' ? ' selected' : ''}>/ year</option>
              </select>
            </div>
          </div>
          <div class="target-panel__field">
            <label class="form-label">Total hours <span class="form-label--optional">(optional)</span></label>
            <input type="number" class="form-input form-input--sm" placeholder="e.g. 500" min="1"
                   value="${c.lifetimeTarget || ''}" data-lifetime-target="${c.id}" aria-label="Total hours goal" />
          </div>
          <div class="target-panel__field">
            <label class="form-label">Count from <span class="form-label--optional">(optional)</span></label>
            <input type="date" class="form-input form-input--sm"
                   value="${c.lifetimeStart || ''}" data-lifetime-start="${c.id}" aria-label="Count hours from this date"
                   title="Empty counts all your time. Set a date to start a fresh challenge." />
          </div>
          <div class="target-panel__field">
            <label class="form-label">By date <span class="form-label--optional">(optional)</span></label>
            <input type="date" class="form-input form-input--sm"
                   value="${c.lifetimeDeadline || ''}" data-lifetime-deadline="${c.id}" aria-label="Deadline" />
          </div>
        </div>
        <div class="target-panel__actions">
          ${hasGoal ? `<button class="btn btn--ghost btn--sm target-panel__remove" data-target-clear="${c.id}">Remove goal</button>` : ''}
          <button class="btn btn--ghost btn--sm" data-target-cancel="${c.id}">Cancel</button>
          <button class="btn btn--primary btn--sm" data-target-save="${c.id}">Save goal</button>
        </div>
      </div>`;
  }

  function cardStateClasses(c, activeTimer) {
    const stateClass    = activeTimer ? ` focus-card--${activeTimer.status}` : '';
    const finishedClass = finishedTimerCats.has(c.id) ? ' focus-card--finished' : '';
    return `${stateClass}${finishedClass}`;
  }

  function timerSectionHTML(c, activeTimer) {
    return `
      <div class="focus-card__timer-section" data-cat-id="${c.id}" data-state="${activeTimer ? activeTimer.status : 'idle'}">
        ${focusTimerSectionHTML(c, activeTimer)}
      </div>`;
  }

  const dragHandleHTML = `
    <div class="goal-card__drag-bar" aria-hidden="true" title="Drag to reorder">
      <i data-lucide="grip-vertical"></i>
    </div>`;

  // A category with a goal: progress first, then a way to start.
  function goalCardHTML(c, sessions, activeTimer, isExpanded) {
    const hasTarget = c.targetValue && c.targetPeriod;
    const periodSecs = hasTarget
      ? (({ from, to }) => secsInRange(sessions, c.id, from, to))(getPeriodBounds(c.targetPeriod))
      : Journey.countedSecs(c, sessions);
    const goalHours = hasTarget ? c.targetValue : c.lifetimeTarget;
    const pct = Math.min(Math.round((periodSecs / (goalHours * 3600)) * 100), 100);
    const streak = hasTarget ? computeStreak(c, sessions) : 0;
    const periodWord = hasTarget
      ? getPeriodLabel(c.targetPeriod).toLowerCase()
      : (c.lifetimeStart ? `since ${fmtDeadlineShort(c.lifetimeStart)}` : 'all time');

    // Total-hours goal: pace, projected finish, milestones and chart
    const lifetimeHTML = c.lifetimeTarget
      ? `<div class="goal-card__lifetime">${Journey.cardHTML(c, sessions, { key: 'goals', showTotal: !!hasTarget })}</div>`
      : '';

    const meta = [
      streak > 0 ? `${streak}-${getPeriodShortLabel(c.targetPeriod)} streak` : '',
    ].filter(Boolean).join(' · ');

    return `
      <article class="goal-card focus-card goal-card--goal${cardStateClasses(c, activeTimer)}" data-cat-id="${c.id}" style="--card-color:${c.color}">
        ${dragHandleHTML}
        <div class="goal-card__head">
          <div class="goal-row__name">
            <span class="breakdown-item__dot" style="background:${c.color}"></span>${esc(c.name)}
          </div>
          <div class="goal-card__tools">
            <button class="btn btn--ghost btn--sm" data-log-time="${c.id}" title="Add time you spent away from the PC"><i data-lucide="plus"></i> Log time</button>
            <button class="btn btn--ghost btn--sm goal-card__target-expand${isExpanded ? ' is-expanded' : ''}" data-target-expand="${c.id}">Edit goal</button>
            <button class="btn btn--ghost btn--sm btn--icon" aria-label="Edit ${esc(c.name)}" data-edit="${c.id}" title="Name, color and sound">
              <i data-lucide="pencil"></i>
            </button>
          </div>
        </div>
        <div class="goal-card__progress">
          <div class="goal-card__amount"><strong>${fmtHours(periodSecs)}</strong> of ${goalHours.toLocaleString('en-US')}h ${periodWord}</div>
          <div class="goal-row__bar"><div class="goal-row__fill" style="width:${pct}%;background:${c.color}"></div></div>
          ${meta ? `<div class="goal-row__meta">${meta}</div>` : ''}
        </div>
        ${hasTarget ? goalCellsHTML(c, sessions) : ''}
        ${timerSectionHTML(c, activeTimer)}
        ${lifetimeHTML}
        ${targetPanelHTML(c, isExpanded)}
      </article>`;
  }

  // A category without a goal: one compact row.
  function categoryRowHTML(c, sessions, weekStart, activeTimer, isExpanded) {
    const totalSecs = sessions.filter(s => s.categoryId === c.id).reduce((sum, s) => sum + s.durationSeconds, 0);
    const weekSecs  = sessions.filter(s => s.categoryId === c.id && toLocalDate(s.startTime) >= weekStart).reduce((sum, s) => sum + s.durationSeconds, 0);

    return `
      <div class="goal-card focus-card category-row${cardStateClasses(c, activeTimer)}" data-cat-id="${c.id}" style="--card-color:${c.color}">
        ${dragHandleHTML}
        <div class="goal-row__name category-row__name">
          <span class="breakdown-item__dot" style="background:${c.color}"></span>
          <span class="breakdown-item__label">${esc(c.name)}</span>
        </div>
        <div class="category-row__stat"><strong>${fmtHours(weekSecs)}</strong> this week</div>
        <div class="category-row__stat"><strong>${fmtHours(totalSecs)}</strong> total</div>
        <div class="goal-card__tools">
          <button class="btn btn--ghost btn--sm" data-log-time="${c.id}" title="Add time you spent away from the PC"><i data-lucide="plus"></i> Log time</button>
          <button class="btn btn--ghost btn--sm goal-card__target-expand${isExpanded ? ' is-expanded' : ''}" data-target-expand="${c.id}">Set goal</button>
          <button class="btn btn--ghost btn--sm btn--icon" aria-label="Edit ${esc(c.name)}" data-edit="${c.id}" title="Name, color and sound">
            <i data-lucide="pencil"></i>
          </button>
        </div>
        ${timerSectionHTML(c, activeTimer)}
        ${targetPanelHTML(c, isExpanded)}
      </div>`;
  }

  async function renderGoals() {
    const container = document.getElementById('goalsList');
    if (!container) return;

    try {
      const { sessions } = await API.logs.list();

      const weekStart = periodContaining('week', new Date()).from;
      const timers = Timer.getTimers();
      const active = categories.filter(c => !c.archived);

      active.forEach(c => {
        if (!focusCardDurations.has(c.id)) focusCardDurations.set(c.id, c.defaultDuration || 1800);
      });

      const timerFor = c => timers.find(t => t.categoryId === c.id) ?? null;
      const goals  = active.filter(c => c.targetValue || c.lifetimeTarget);
      const others = active.filter(c => !c.targetValue && !c.lifetimeTarget);

      const goalsHTML = goals.length
        ? `<div class="goals-list goals-list--goals">
             ${goals.map(c => goalCardHTML(c, sessions, timerFor(c), expandedTargetPanels.has(c.id))).join('')}
           </div>`
        : `<p class="goals-empty">No goals yet. Choose a category below and press Set goal.</p>`;

      const othersHTML = others.length
        ? `<h2 class="goals-section-header">${goals.length ? 'Other categories' : 'Categories'}</h2>
           <div class="goals-list goals-list--rows">
             ${others.map(c => categoryRowHTML(c, sessions, weekStart, timerFor(c), expandedTargetPanels.has(c.id))).join('')}
           </div>`
        : '';

      lastGoalTimerKey = timerStateKey(timers);
      container.innerHTML = `${goalsHTML}${othersHTML}`;
      lucide.createIcons();
      Journey.mount(container);
      bindGoalsDragAndDrop();

      container.querySelectorAll('[data-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cat = categories.find(c => c.id === btn.dataset.edit);
          if (cat) openCategoryModal(cat);
        });
      });

      container.querySelectorAll('[data-log-time]').forEach(btn => {
        btn.addEventListener('click', () => SessionForm.open({ categoryId: btn.dataset.logTime }));
      });
    } catch (err) { console.error(err); }
  }

  // ── Goals drag-and-drop (SortableJS) ──────────────────────────────────────
  let _sortableGoals = [];

  function bindGoalsDragAndDrop() {
    _sortableGoals.forEach(s => s.destroy());
    _sortableGoals = [...document.querySelectorAll('#goalsList .goals-list')].map(list => Sortable.create(list, {
      handle: '.goal-card__drag-bar',
      animation: 200,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      ghostClass: 'goal-card--dnd-ghost',
      chosenClass: 'goal-card--dnd-chosen',
      dragClass: 'goal-card--dnd-dragging',
      onEnd: async () => {
        const newOrder = [...document.querySelectorAll('#goalsList .goal-card')].map(c => c.dataset.catId);
        const catMap = new Map(categories.map(c => [c.id, c]));
        const reordered = newOrder.map(id => catMap.get(id)).filter(Boolean);
        const rest = categories.filter(c => !newOrder.includes(c.id));
        categories = [...reordered, ...rest];
        syncCategories();
        try { await API.categories.reorder(newOrder); }
        catch (err) { console.error('Reorder failed:', err); }
      },
    }));
  }

  // ── Focus card event delegation ────────────────────────────────────────────
  function bindFocusCardControls() {
    const container = document.getElementById('goalsList');
    if (!container) return;

    // Enter / Escape on the custom-duration number input
    container.addEventListener('keydown', e => {
      if (!e.target.dataset.focusCustomVal) return;
      const catId   = e.target.dataset.focusCustomVal;
      const section = e.target.closest('.focus-card__timer-section');
      if (e.key === 'Enter') { e.preventDefault(); section?.querySelector(`[data-focus-custom-ok="${catId}"]`)?.click(); }
      if (e.key === 'Escape') { section?.querySelector(`[data-focus-custom-cancel="${catId}"]`)?.click(); }
    });

    function reRenderTimerSection(catId, activeTimer = null) {
      const section = document.querySelector(`.focus-card__timer-section[data-cat-id="${catId}"]`);
      const cat = categories.find(c => c.id === catId);
      if (section && cat) {
        section.innerHTML = focusTimerSectionHTML(cat, activeTimer);
        section.dataset.state = activeTimer ? activeTimer.status : 'idle';
        lucide.createIcons({ nodes: [section] });
        if (!activeTimer) {
          const input = section.querySelector(`[data-focus-custom-val="${catId}"]`);
          if (input) { input.focus(); input.select(); }
        }
      }
    }

    // Timer length dropdown (also what Stream Dock uses for this category)
    container.addEventListener('change', e => {
      const catId = e.target.dataset.focusDuration;
      if (!catId) return;
      if (e.target.value === 'custom') {
        focusCardCustomEditing.set(catId, true);
        reRenderTimerSection(catId);
        return;
      }
      setCategoryDuration(catId, parseInt(e.target.value));
      reRenderTimerSection(catId);
    });

    container.addEventListener('click', async e => {
      // Target panel — remove goal
      const clearBtn = e.target.closest('[data-target-clear]');
      if (clearBtn) {
        const catId = clearBtn.dataset.targetClear;
        clearBtn.disabled = true;
        try {
          const cleared = { targetValue: null, targetPeriod: null, lifetimeTarget: null, lifetimeDeadline: null, lifetimeStart: null };
          const updated = await API.categories.update(catId, cleared);
          categories = categories.map(c => c.id === catId ? { ...c, ...updated } : c);
          syncCategories();
          expandedTargetPanels.delete(catId);
          renderGoals();
        } catch (err) { console.error(err); clearBtn.disabled = false; }
        return;
      }

      // Custom duration — decrement
      const decBtn = e.target.closest('[data-focus-custom-dec]');
      if (decBtn) {
        const catId = decBtn.dataset.focusCustomDec;
        const section = decBtn.closest('.focus-card__timer-section');
        const input = section?.querySelector(`[data-focus-custom-val="${catId}"]`);
        if (input) input.value = Math.max(1, (parseInt(input.value) || 1) - 1);
        return;
      }

      // Custom duration — increment
      const incBtn = e.target.closest('[data-focus-custom-inc]');
      if (incBtn) {
        const catId = incBtn.dataset.focusCustomInc;
        const section = incBtn.closest('.focus-card__timer-section');
        const input = section?.querySelector(`[data-focus-custom-val="${catId}"]`);
        if (input) input.value = Math.min(480, (parseInt(input.value) || 1) + 1);
        return;
      }

      // Custom duration — OK (Set button)
      const customOk = e.target.closest('[data-focus-custom-ok]');
      if (customOk) {
        const catId   = customOk.dataset.focusCustomOk;
        const section = customOk.closest('.focus-card__timer-section');
        const mins    = parseInt(section?.querySelector(`[data-focus-custom-val="${catId}"]`)?.value) || 1;
        const secs    = Math.max(60, Math.min(mins * 60, 28800));
        setCategoryDuration(catId, secs);
        focusCardCustomEditing.delete(catId);
        reRenderTimerSection(catId);
        return;
      }

      // Custom duration — Cancel
      const customCancel = e.target.closest('[data-focus-custom-cancel]');
      if (customCancel) {
        const catId = customCancel.dataset.focusCustomCancel;
        focusCardCustomEditing.delete(catId);
        reRenderTimerSection(catId);
        return;
      }

      // Target panel — expand/collapse
      const expandBtn = e.target.closest('[data-target-expand]');
      if (expandBtn) {
        const catId = expandBtn.dataset.targetExpand;
        const panel = container.querySelector(`.target-panel[data-cat-id="${catId}"]`);
        if (panel) {
          const nowOpen = panel.hidden;
          panel.hidden = !nowOpen;
          expandBtn.classList.toggle('is-expanded', nowOpen);
          if (nowOpen) { expandedTargetPanels.add(catId); panel.querySelector('[data-target-value]')?.focus(); }
          else          expandedTargetPanels.delete(catId);
        }
        return;
      }

      // Target panel — cancel
      const targetCancelBtn = e.target.closest('[data-target-cancel]');
      if (targetCancelBtn) {
        const catId = targetCancelBtn.dataset.targetCancel;
        const panel = container.querySelector(`.target-panel[data-cat-id="${catId}"]`);
        if (panel) panel.hidden = true;
        container.querySelector(`[data-target-expand="${catId}"]`)?.classList.remove('is-expanded');
        expandedTargetPanels.delete(catId);
        return;
      }

      // Target panel — save
      const targetSaveBtn = e.target.closest('[data-target-save]');
      if (targetSaveBtn) {
        const catId = targetSaveBtn.dataset.targetSave;
        const panel = container.querySelector(`.target-panel[data-cat-id="${catId}"]`);
        if (!panel) return;
        const targetValue    = parseFloat(panel.querySelector(`[data-target-value="${catId}"]`)?.value) || null;
        const targetPeriod   = targetValue ? (panel.querySelector(`[data-target-period="${catId}"]`)?.value || 'week') : null;
        const lifetimeTarget = parseInt(panel.querySelector(`[data-lifetime-target="${catId}"]`)?.value) || null;
        const lifetimeDeadline = panel.querySelector(`[data-lifetime-deadline="${catId}"]`)?.value || null;
        const lifetimeStart    = panel.querySelector(`[data-lifetime-start="${catId}"]`)?.value || null;
        targetSaveBtn.disabled = true;
        try {
          const updated = await API.categories.update(catId, { targetValue, targetPeriod, lifetimeTarget, lifetimeDeadline, lifetimeStart });
          categories = categories.map(c => c.id === catId ? { ...c, ...updated } : c);
          syncCategories();
          expandedTargetPanels.delete(catId);
          renderGoals();
        } catch (err) { console.error(err); targetSaveBtn.disabled = false; }
        return;
      }

      // Done (dismiss finished timer)
      const doneBtn = e.target.closest('[data-focus-done]');
      if (doneBtn) {
        const catId = doneBtn.dataset.focusDone;
        clearTimerFinished(catId);
        API.get(`/api/timer/toggle?category=${encodeURIComponent(catId)}`).catch(() => {});
        return;
      }

      // Start
      const startBtn = e.target.closest('[data-focus-start]');
      if (startBtn) {
        const catId = startBtn.dataset.focusStart;
        const dur   = focusCardDurations.get(catId) || 1800;
        try { await API.timer.start({ duration: dur, categoryId: catId }); }
        catch (err) { console.error(err); }
        return;
      }

      // Pause
      const pauseBtn = e.target.closest('[data-focus-pause]');
      if (pauseBtn) {
        const catId = pauseBtn.dataset.focusPause;
        try { await API.get(`/api/timer/pause?category=${encodeURIComponent(catId)}`); }
        catch (err) { console.error(err); }
        return;
      }

      // Resume
      const resumeBtn = e.target.closest('[data-focus-resume]');
      if (resumeBtn) {
        const catId = resumeBtn.dataset.focusResume;
        try { await API.timer.start({ categoryId: catId }); }
        catch (err) { console.error(err); }
        return;
      }

      // Stop
      const stopBtn = e.target.closest('[data-focus-stop]');
      if (stopBtn) {
        const catId = stopBtn.dataset.focusStop;
        try { await API.get(`/api/timer/stop?category=${encodeURIComponent(catId)}`); }
        catch (err) { console.error(err); }
        return;
      }
    });
  }

  // ── Called by Timer on every WS tick ──────────────────────────────────────
  function onTimersUpdate(timers) {
    if (currentScreen === 'dashboard') {
      const dashKey = timerStateKey(timers);
      if (dashKey !== lastDashTimerKey) {
        lastDashTimerKey = dashKey;
        renderDashboardGoals(lastDashSessions);
        renderInProgress(timers);
      } else {
        tickInProgress(timers);
      }
      return;
    }
    if (currentScreen !== 'goals') return;
    if (!document.getElementById('newCategoryModal').hidden) return;

    const newKey = timerStateKey(timers);

    if (newKey === lastGoalTimerKey) {
      // Pure tick — update countdown text only, no DOM restructuring
      timers.forEach(t => {
        const section = document.querySelector(`.focus-card__timer-section[data-cat-id="${t.categoryId}"]`);
        if (!section) return;
        const countdown = section.querySelector('.focus-card__countdown');
        if (countdown) countdown.textContent = Timer.fmtTime(t.remainingSeconds);
      });
      return;
    }

    lastGoalTimerKey = newKey;

    // Check if the SET of active categories changed (timer started fresh or stopped)
    const prevActiveCatIds = [...document.querySelectorAll('.focus-card__timer-section:not([data-state="idle"])')].map(el => el.dataset.catId).sort().join(',');
    const newActiveCatIds  = timers.map(t => t.categoryId).sort().join(',');

    if (prevActiveCatIds !== newActiveCatIds) {
      // Full re-render: updates progress bars (new session logged) + card states
      renderGoals();
      return;
    }

    // Same active set, status changed (pause ↔ resume) — update sections in place, no fetch
    timers.forEach(t => {
      const section = document.querySelector(`.focus-card__timer-section[data-cat-id="${t.categoryId}"]`);
      if (!section) return;
      const cat = categories.find(c => c.id === t.categoryId);
      if (!cat) return;
      section.innerHTML = focusTimerSectionHTML(cat, t);
      section.dataset.state = t.status;
      lucide.createIcons({ nodes: [section] });
      const card = section.closest('.goal-card');
      if (card) {
        card.classList.remove('focus-card--running', 'focus-card--paused');
        card.classList.add(`focus-card--${t.status}`);
      }
    });
  }

  // ── New / Edit Category modal ──────────────────────────────────────────────
  let pendingCatSoundFile = null;
  let pendingClearCatSound = false;
  let pendingCategoryCreatedCallback = null;

  function setCatSoundUI(soundName) {
    const nameEl    = document.getElementById('newCatSoundName');
    const testBtn   = document.getElementById('btnNewCatTestSound');
    const clearBtn  = document.getElementById('btnNewCatClearSound');
    if (!nameEl) return;
    if (soundName) {
      nameEl.textContent = soundName;
      if (testBtn)  testBtn.hidden  = false;
      if (clearBtn) clearBtn.hidden = false;
    } else {
      nameEl.textContent = 'Uses your default sound';
      if (testBtn)  testBtn.hidden  = true;
      if (clearBtn) clearBtn.hidden = true;
    }
  }

  const CATEGORY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#F97316', '#06B6D4', '#EF4444', '#84CC16', '#6366F1'];

  // Tints the whole window and marks the matching swatch as you pick.
  function setCatFormColor(color) {
    document.getElementById('newCatColor').value = color;
    document.getElementById('newCatForm').style.setProperty('--cat', color);
    let matched = false;
    document.querySelectorAll('#newCatSwatches .note-swatch').forEach(s => {
      const isMatch = s.dataset.catColor.toLowerCase() === color.toLowerCase();
      s.classList.toggle('is-active', isMatch);
      matched = matched || isMatch;
    });
    document.getElementById('newCatCustomColor').classList.toggle('is-active', !matched);
  }

  function setCatFormError(message) {
    const el = document.getElementById('newCatError');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function nextFreeColor() {
    const used = categories.map(c => (c.color || '').toLowerCase());
    return CATEGORY_COLORS.find(color => !used.includes(color.toLowerCase())) || CATEGORY_COLORS[0];
  }

  function openCategoryModal(existing = null, opts = {}) {
    const modal      = document.getElementById('newCategoryModal');
    const title      = document.getElementById('newCategoryTitle');
    const btnConfirm = document.getElementById('btnNewCatConfirm');
    const editIdInput = document.getElementById('editCatId');
    const nameInput  = document.getElementById('newCatName');
    const btnDelete  = document.getElementById('btnNewCatDelete');

    pendingCatSoundFile   = null;
    pendingClearCatSound  = false;
    pendingCategoryCreatedCallback = opts.onCreated || null;
    setCatFormError('');

    // Goal and timer length have their own controls on the Goals screen once a category exists
    document.getElementById('newCatSetup').hidden = !!existing;
    document.getElementById('newCatGoalHours').value = '';
    document.getElementById('newCatGoalPeriod').value = 'week';
    document.getElementById('newCatDuration').value = '1800';

    if (existing) {
      title.textContent      = 'Edit category';
      btnConfirm.textContent = 'Save changes';
      editIdInput.value      = existing.id;
      nameInput.value        = existing.name;
      setCatFormColor(existing.color || CATEGORY_COLORS[0]);
      btnDelete.hidden = false;
      setCatSoundUI(existing.soundName || null);
    } else {
      title.textContent      = 'New category';
      btnConfirm.textContent = 'Add category';
      editIdInput.value      = '';
      nameInput.value        = opts.prefill?.name || '';
      setCatFormColor(opts.prefill?.color || nextFreeColor());
      btnDelete.hidden = true;
      setCatSoundUI(null);
    }

    modal.hidden = false;
    nameInput.focus();
    nameInput.select();
    lucide.createIcons({ nodes: [modal] });
  }

  function bindNewCategory() {
    const modal      = document.getElementById('newCategoryModal');
    const btnCancel  = document.getElementById('btnNewCatCancel');
    const btnConfirm = document.getElementById('btnNewCatConfirm');
    const btnDelete  = document.getElementById('btnNewCatDelete');
    const colorInput = document.getElementById('newCatColor');
    const nameInput  = document.getElementById('newCatName');
    const swatches   = document.getElementById('newCatSwatches');

    swatches.innerHTML = CATEGORY_COLORS.map(color => `
      <button type="button" class="note-swatch" data-cat-color="${color}" aria-label="Color ${color}" style="--swatch:${color}"></button>`).join('');
    swatches.addEventListener('click', e => {
      const swatch = e.target.closest('[data-cat-color]');
      if (swatch) setCatFormColor(swatch.dataset.catColor);
    });

    colorInput.addEventListener('input', () => setCatFormColor(colorInput.value));
    nameInput.addEventListener('input', () => setCatFormError(''));

    // Enter in any text or number field submits
    modal.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('#newCatName, #newCatGoalHours')) {
        e.preventDefault();
        btnConfirm.click();
      }
    });

    // Sound picker for category
    const catSoundPicker = document.getElementById('newCatSoundPicker');
    document.getElementById('btnNewCatSound').addEventListener('click', () => catSoundPicker.click());
    catSoundPicker.addEventListener('change', () => {
      const file = catSoundPicker.files[0];
      if (!file) return;
      pendingCatSoundFile  = file;
      pendingClearCatSound = false;
      setCatSoundUI(file.name);
      catSoundPicker.value = '';
    });
    document.getElementById('btnNewCatTestSound').addEventListener('click', () => {
      if (pendingCatSoundFile) {
        new Audio(URL.createObjectURL(pendingCatSoundFile)).play().catch(() => {});
      } else {
        const editId = document.getElementById('editCatId').value;
        const cat = categories.find(c => c.id === editId);
        if (cat?.soundPath) new Audio(cat.soundPath).play().catch(() => {});
      }
    });
    document.getElementById('btnNewCatClearSound').addEventListener('click', () => {
      pendingCatSoundFile  = null;
      pendingClearCatSound = true;
      setCatSoundUI(null);
    });

    // Global sound strip in Goals screen
    const globalSoundPicker = document.getElementById('globalSoundPicker');
    document.getElementById('btnGlobalSound').addEventListener('click', () => globalSoundPicker.click());
    document.getElementById('btnGlobalTestSound').addEventListener('click', () => {
      const p = AlertSound.getGlobalSoundPath();
      if (p) new Audio(p).play().catch(() => {});
    });
    document.getElementById('btnGlobalResetSound').addEventListener('click', async () => {
      try {
        await API.del('/api/settings/sound');
        await AlertSound.reload();
        updateGlobalSoundUI(AlertSound.getGlobalSoundName());
      } catch (err) { console.error('Reset sound failed:', err); }
    });
    globalSoundPicker.addEventListener('change', async () => {
      const file = globalSoundPicker.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        const base64 = ev.target.result.split(',')[1];
        try {
          await API.post('/api/settings/sound', { name: file.name, data: base64 });
          await AlertSound.reload();
          updateGlobalSoundUI(AlertSound.getGlobalSoundName());
        } catch (err) {
          console.error('Global sound upload failed:', err);
          alert('Sound upload failed — file may be too large or unsupported format.');
        }
        globalSoundPicker.value = '';
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('btnAddCategory').addEventListener('click', () => openCategoryModal());
    btnCancel.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllModals(); });

    btnDelete.addEventListener('click', async () => {
      const editId = document.getElementById('editCatId').value;
      if (!editId) return;
      const cat = categories.find(c => c.id === editId);

      let sessionCount = 0;
      let timeStr = '';
      try {
        const { sessions } = await API.logs.list({ category: editId });
        sessionCount = sessions.length;
        if (sessionCount > 0) {
          const totalMins = Math.round(sessions.reduce((s, x) => s + x.durationSeconds, 0) / 60);
          const hrs = Math.floor(totalMins / 60);
          const mins = totalMins % 60;
          timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        }
      } catch (_) {}

      modal.hidden = true;
      const confirmed = await showDeleteConfirm(cat?.name || 'this category', sessionCount, timeStr);
      if (!confirmed) return;

      try {
        await API.categories.delete(editId);
        categories = categories.filter(c => c.id !== editId);
        syncCategories();
        renderGoals();
      } catch (err) { console.error(err); }
    });

    btnConfirm.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const editId = document.getElementById('editCatId').value;
      const color  = colorInput.value;

      if (!name) {
        setCatFormError('Give it a name first.');
        nameInput.focus();
        return;
      }
      // The id is built from the name, so two categories can't share one
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      const clash = categories.find(c => c.id !== editId && (c.name.toLowerCase() === name.toLowerCase() || (!editId && c.id === slug)));
      if (clash) {
        setCatFormError(`You already have a category called "${clash.name}".`);
        nameInput.focus();
        return;
      }

      try {
        let savedId;
        if (editId) {
          const updated = await API.categories.update(editId, { name, color });
          categories = categories.map(c => c.id === editId ? { ...c, ...updated } : c);
          savedId = editId;
        } else {
          let newCat = await API.categories.create({ name, color });

          const goalHours = parseFloat(document.getElementById('newCatGoalHours').value);
          if (goalHours > 0) {
            const targetPeriod = document.getElementById('newCatGoalPeriod').value;
            newCat = { ...newCat, ...await API.categories.update(newCat.id, { targetValue: goalHours, targetPeriod }) };
          }

          const duration = parseInt(document.getElementById('newCatDuration').value);
          await API.categories.setDefaultDuration(newCat.id, duration);
          newCat.defaultDuration = duration;
          focusCardDurations.set(newCat.id, duration);

          categories.push(newCat);
          savedId = newCat.id;
          if (pendingCategoryCreatedCallback) {
            const cb = pendingCategoryCreatedCallback;
            pendingCategoryCreatedCallback = null;
            cb(newCat);
          }
        }

        // Handle sound
        if (pendingClearCatSound && editId) {
          await API.categories.clearSound(savedId);
          categories = categories.map(c => c.id === savedId ? { ...c, soundPath: undefined, soundName: undefined } : c);
        } else if (pendingCatSoundFile) {
          const reader = new FileReader();
          await new Promise(resolve => {
            reader.onload = async ev => {
              const base64 = ev.target.result.split(',')[1];
              try {
                const r = await API.categories.uploadSound(savedId, pendingCatSoundFile.name, base64);
                categories = categories.map(c => c.id === savedId ? { ...c, soundPath: r.soundPath, soundName: r.soundName } : c);
              } catch (err) { console.error('Sound upload failed:', err); }
              resolve();
            };
            reader.readAsDataURL(pendingCatSoundFile);
          });
        }

        syncCategories();
        modal.hidden = true;
        renderGoals();
      } catch (err) { console.error(err); }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const data = await API.categories.list();
      categories = data.categories;
    } catch (err) {
      console.error('Failed to load categories', err);
      categories = [];
    }

    API.app.version().then(({ version }) => {
      const el = document.getElementById('sidebarVersion');
      if (el) el.textContent = `v${version}`;
    }).catch(() => {});

    await Appearance.init();
    bindNav();
    bindNewCategory();
    bindFocusCardControls();
    bindAnalyticsControls();
    bindDashboardControls();
    await Timer.init(categories);
    AlertSound.onLoaded(name => updateGlobalSoundUI(name));
    updateGlobalSoundUI(AlertSound.getGlobalSoundName());
    await Pomodoro.init(categories);
    await Stopwatch.init(categories);
    await Logs.init(categories);
    Settings.init();
    Notes.init();
    SessionForm.init();
    Trackers.init();
    showScreen('dashboard');
    lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', () => {
    init();
    setupUpdateNotifier();
  });

  // Entering a number box that already has a value selects it, so typing replaces the value
  // instead of adding digits after it. Covers every number box, including ones built later.
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'number' || el.value === '') return;
    el.select();
    // A mouse click would put the cursor back at the click point on release; keep the selection
    const keep = ev => ev.preventDefault();
    el.addEventListener('mouseup', keep, { once: true });
    el.addEventListener('blur', () => el.removeEventListener('mouseup', keep), { once: true });
  });

  function setupUpdateNotifier() {
    if (!window.electronAPI?.onUpdateAvailable) return;

    let announcedVersion = null;

    window.electronAPI.onUpdateAvailable(info => {
      Settings.setUpdateState('available', info);
      if (info.version === announcedVersion) return;
      announcedVersion = info.version;
      showToast(`Version ${info.version} is available`, 10000, {
        label: 'View',
        onClick: async () => {
          showScreen('settings');
          await Settings.refresh(); // the page changes height as it loads, so scroll after
          document.getElementById('settingsUpdateCard').scrollIntoView({ block: 'center' });
        },
      });
    });

    window.electronAPI.onUpdateProgress(percent => {
      Settings.setUpdateState('downloading', percent);
    });

    window.electronAPI.onUpdateDownloaded(() => {
      Settings.setUpdateState('downloaded');
    });

    window.electronAPI.onUpdateNotAvailable(() => {
      Settings.setUpdateState('uptodate');
    });

    window.electronAPI.onUpdateError(kind => {
      Settings.setUpdateState('error', kind);
    });
  }

  function updateFinishedCardDOM(categoryId) {
    const card = document.querySelector(`.goal-card[data-cat-id="${categoryId}"]`);
    if (!card) return;
    const isFinished = finishedTimerCats.has(categoryId);
    card.classList.toggle('focus-card--finished', isFinished);
    const section = card.querySelector('.focus-card__timer-section');
    const cat = categories.find(c => c.id === categoryId);
    if (section && cat) {
      section.innerHTML = focusTimerSectionHTML(cat, null);
      section.dataset.state = 'idle';
      lucide.createIcons({ nodes: [section] });
    }
  }

  function markTimerFinished(categoryId) {
    finishedTimerCats.add(categoryId);
    updateFinishedCardDOM(categoryId);
  }

  function clearTimerFinished(categoryId) {
    finishedTimerCats.delete(categoryId);
    updateFinishedCardDOM(categoryId);
  }

  function showToast(msg, duration = 3000, action = null) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);

    const dismiss = () => {
      el.classList.remove('toast--visible');
      setTimeout(() => el.remove(), 300);
    };

    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast__action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { action.onClick(); dismiss(); });
      el.appendChild(btn);
    }

    requestAnimationFrame(() => el.classList.add('toast--visible'));
    setTimeout(dismiss, duration);
  }

  // Opens the Goals screen with a category's goal form already expanded.
  function showGoalSetup(categoryId) {
    const cat = getCategoryById(categoryId);
    if (!cat?.targetValue && !cat?.lifetimeTarget) expandedTargetPanels.add(categoryId);
    showScreen('goals');
  }

  return { getCategoryById, showGoalSetup, refreshDashboard, renderGoals, showScreen, getCategories: () => categories, onTimersUpdate, getCurrentScreen: () => currentScreen, markTimerFinished, clearTimerFinished, showDeleteConfirm, showToast,
    openCategoryModalPrefilled: (name, color, onCreated) => openCategoryModal(null, { prefill: { name, color }, onCreated }) };
})();
