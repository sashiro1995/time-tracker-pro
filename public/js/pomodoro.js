const Pomodoro = (() => {
  const CIRC = 2 * Math.PI * 96;

  const PRESETS = {
    classic: { label: 'Classic', work: 25, short: 5,  long: 15, rounds: 4 },
    deep:    { label: 'Deep work', work: 50, short: 10, long: 30, rounds: 3 },
    quick:   { label: 'Quick', work: 15, short: 3,  long: 10, rounds: 4 },
  };
  const LIMITS = {
    work:   { min: 1, max: 180, step: 5 },
    short:  { min: 1, max: 60,  step: 1 },
    long:   { min: 1, max: 120, step: 5 },
    rounds: { min: 1, max: 12,  step: 1 },
  };
  const PHASE_LABEL = { work: 'Focus', 'short-break': 'Short break', 'long-break': 'Long break' };

  let phase = null;
  let completedWork = 0;
  let active = false;
  let paused = false;
  let waitingForNext = false;
  let nextPhase = null;
  let remainingSeconds = 0;
  let durationSeconds = 0;
  let categoryId = null;
  let note = '';
  let allCategories = [];
  let cfg = { work: 25, short: 5, long: 15, rounds: 4, autoBreaks: false, autoFocus: false };
  let saveNoticeTimer = null;

  const el = id => document.getElementById(id);

  function fmtTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function fmtClock(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function isBreak(p) {
    return p === 'short-break' || p === 'long-break';
  }

  // The phase the screen is about: the running one, or the one about to start
  function shownPhase() {
    if (!active) return 'work';
    return waitingForNext ? nextPhase : phase;
  }

  function phaseSeconds(p) {
    return { work: cfg.work, 'short-break': cfg.short, 'long-break': cfg.long }[p] * 60;
  }

  function getSelectedCatId() {
    return el('pomodoroCategory')?.value ?? null;
  }

  function setSelectedCatId(id) {
    const sel = el('pomodoroCategory');
    if (sel && id) sel.value = id;
  }

  // ── Round track: the whole cycle as one bar, sized by how long each part lasts ──
  function cycleItems() {
    const items = [];
    for (let i = 0; i < cfg.rounds; i++) {
      items.push({ phase: 'work', round: i });
      items.push({ phase: i === cfg.rounds - 1 ? 'long-break' : 'short-break', round: i });
    }
    return items;
  }

  function currentIndex() {
    if (!active) return 0;
    const p = shownPhase();
    const n = cfg.rounds;
    if (isBreak(p)) return ((completedWork - 1 + n) % n) * 2 + 1;
    return (completedWork % n) * 2;
  }

  function renderTrack() {
    const track = el('pomoTrack');
    const round = el('pomoRound');
    const finish = el('pomoFinish');
    if (!track) return;

    const items = cycleItems();
    const index = currentIndex();
    const fill = active && !waitingForNext && durationSeconds > 0
      ? Math.round((1 - remainingSeconds / durationSeconds) * 100)
      : 0;

    track.innerHTML = items.map((item, i) => {
      const pct = i < index ? 100 : (i === index ? fill : 0);
      const kind = isBreak(item.phase) ? 'pomo-seg--break' : 'pomo-seg--focus';
      const current = active && i === index ? ' is-current' : '';
      return `<span class="pomo-seg ${kind}${current}" style="flex-grow:${phaseSeconds(item.phase)};--fill:${pct}%" title="${PHASE_LABEL[item.phase]}, ${phaseSeconds(item.phase) / 60}m"></span>`;
    }).join('');

    const left = items.slice(index + 1).reduce((sum, item) => sum + phaseSeconds(item.phase), 0);
    const nowLeft = active && !waitingForNext ? remainingSeconds : phaseSeconds(items[index].phase);
    const doneAt = new Date(Date.now() + (nowLeft + left) * 1000);

    round.textContent = active
      ? `Round ${items[index].round + 1} of ${cfg.rounds}`
      : `${cfg.rounds} round${cfg.rounds === 1 ? '' : 's'}, ${Charts.fmtDur(nowLeft + left)}`;
    finish.textContent = paused ? 'Paused' : `Done by ${fmtClock(doneAt)}`;
  }

  // ── Main render ───────────────────────────────────────────────────────────
  function renderClock() {
    const ring = el('pomodoroScreenRing');
    const display = el('pomodoroScreenDisplay');
    if (!display) return;
    const running = active && !waitingForNext;
    const pct = running && durationSeconds > 0 ? remainingSeconds / durationSeconds : 1;
    ring.style.strokeDasharray  = CIRC;
    ring.style.strokeDashoffset = CIRC * (1 - pct);
    display.textContent = fmtTime(running ? remainingSeconds : phaseSeconds(shownPhase()));
  }

  function render() {
    const stage = el('pomoStage');
    const toggleBtn = el('btnPomodoroToggle');
    if (!stage) return;

    const shown = shownPhase();
    stage.classList.toggle('pomo-stage--break', isBreak(shown));
    stage.classList.toggle('is-paused', paused);

    renderClock();
    renderTrack();

    el('pomodoroScreenPhase').textContent = waitingForNext ? `Next: ${PHASE_LABEL[shown]}` : PHASE_LABEL[shown];

    const catId = active ? categoryId : getSelectedCatId();
    const cat = allCategories.find(c => c.id === catId);
    el('pomodoroScreenCatLabel').textContent = cat ? cat.name : 'No category';

    el('pomoSetup').hidden = active;
    el('pomoNoCategory').hidden = active || !!cat;
    const focusNote = el('pomoFocusNote');
    focusNote.textContent = note;
    focusNote.hidden = !active || !note;

    let icon, label;
    if (waitingForNext) {
      icon = 'play';
      label = isBreak(nextPhase) ? `Start ${PHASE_LABEL[nextPhase].toLowerCase()}` : 'Start focus';
    } else if (paused) {
      icon = 'play';
      label = 'Resume';
    } else if (active) {
      icon = 'pause';
      label = 'Pause';
    } else {
      icon = 'play';
      label = 'Start focus';
    }
    toggleBtn.innerHTML = `<i data-lucide="${icon}"></i> ${label}`;
    toggleBtn.setAttribute('aria-label', label);

    const skipBtn = el('btnPomodoroScreenSkip');
    skipBtn.hidden = !active || (waitingForNext && !isBreak(nextPhase));
    skipBtn.innerHTML = `<i data-lucide="skip-forward"></i> ${isBreak(shown) ? 'Skip break' : 'Skip'}`;
    el('btnPomodoroStop').hidden = !active;

    lucide.createIcons({ nodes: [el('pomoActions')] });
  }

  // ── Today's total ─────────────────────────────────────────────────────────
  async function refresh() {
    try {
      const { sessions } = await API.logs.list();
      const today = new Date().toLocaleDateString('sv');
      const pomodoros = sessions.filter(s => s.source === 'pomodoro');
      const todays = pomodoros.filter(s => new Date(s.startTime).toLocaleDateString('sv') === today);
      const total = todays.reduce((sum, s) => sum + s.durationSeconds, 0);
      el('pomoToday').textContent = todays.length
        ? `Today: ${todays.length} session${todays.length === 1 ? '' : 's'}, ${Charts.fmtDur(total)} of focus`
        : 'No focus sessions yet today';

      // Start from the category you used last, so time isn't left out of the log by accident
      if (!active && getSelectedCatId() === '__none__' && pomodoros.length) {
        const latest = pomodoros.reduce((a, b) => (a.startTime > b.startTime ? a : b));
        if (allCategories.some(c => c.id === latest.categoryId && !c.archived)) setSelectedCatId(latest.categoryId);
      }
      render();
    } catch (err) { console.error(err); }
  }

  // ── Server events ─────────────────────────────────────────────────────────
  function handleWS(msg) {
    if (msg.type === 'timer:pomodoro-phase') {
      active = true;
      paused = false;
      waitingForNext = false;
      nextPhase = null;
      phase = msg.phase;
      completedWork = msg.completedWorkSessions;
      cfg.rounds = msg.cyclesBeforeLongBreak;
      categoryId = msg.categoryId;
      note = msg.note || '';
      remainingSeconds = msg.duration;
      durationSeconds  = msg.duration;
      if (msg.categoryId) setSelectedCatId(msg.categoryId);
      if (!msg.auto) AlertSound.stop();
      render();
      refresh();
      return;
    }

    if (msg.type === 'timer:pomodoro-waiting') {
      active = true;
      paused = false;
      waitingForNext = true;
      nextPhase = msg.nextPhase;
      categoryId = msg.categoryId;
      completedWork = msg.completedWorkSessions;
      cfg.rounds = msg.cyclesBeforeLongBreak;
      remainingSeconds = 0;
      durationSeconds = 0;
      render();
      refresh();
      AlertSound.play();
      return;
    }

    if (msg.type === 'timer:pomodoro-stopped') {
      active = false;
      paused = false;
      waitingForNext = false;
      nextPhase = null;
      phase = null;
      completedWork = 0;
      remainingSeconds = 0;
      durationSeconds = 0;
      categoryId = null;
      note = '';
      AlertSound.stop();
      render();
      refresh();
      return;
    }

    if (active && msg.timers) {
      const t = msg.timers.find(x => x.categoryId === categoryId && x.pomodoroPhase);
      if (!t) return;
      remainingSeconds = t.remainingSeconds;
      durationSeconds  = t.durationSeconds;
      paused = t.status === 'paused';
      if (msg.type === 'timer:tick') {
        renderClock();
        renderTrack();
      } else {
        render();
      }
    }
  }

  function populateCategorySelect(categories) {
    allCategories = categories;
    const sel = el('pomodoroCategory');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML =
      `<option value="__none__">No category</option>` +
      categories
        .filter(c => !c.archived)
        .map(c => `<option value="${c.id}">${Charts.esc(c.name)}</option>`)
        .join('');
    if (categories.some(c => c.id === current)) sel.value = current;
  }

  // ── Main button ───────────────────────────────────────────────────────────
  async function toggle() {
    const catId = active ? categoryId : getSelectedCatId();
    try {
      if (waitingForNext) {
        AlertSound.stop();
        await API.get(`/api/pomodoro/next?category=${encodeURIComponent(catId)}`);
      } else if (paused) {
        await API.timer.start({ categoryId: catId });
      } else if (active) {
        await API.timer.pause(catId);
      } else {
        await API.post('/api/pomodoro/start', { categoryId: catId, note: el('pomodoroNote').value.trim() });
        el('pomodoroNote').value = '';
      }
    } catch (err) { console.error(err); }
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  function matchingPreset() {
    return Object.keys(PRESETS).find(key => {
      const p = PRESETS[key];
      return p.work === cfg.work && p.short === cfg.short && p.long === cfg.long && p.rounds === cfg.rounds;
    }) || null;
  }

  function renderSettings() {
    const presets = el('pomoPresets');
    if (!presets) return;
    const activePreset = matchingPreset();
    presets.innerHTML = Object.entries(PRESETS).map(([key, p]) => `
      <button type="button" class="pomo-preset${key === activePreset ? ' is-active' : ''}" data-preset="${key}" aria-pressed="${key === activePreset}">
        <span class="pomo-preset__name">${p.label}</span>
        <span class="pomo-preset__values">${p.work} / ${p.short} / ${p.long}</span>
      </button>`).join('');

    document.querySelectorAll('[data-pomo-field]').forEach(input => {
      if (document.activeElement !== input) input.value = cfg[input.dataset.pomoField];
    });
    el('pomoAutoBreaks').checked = cfg.autoBreaks;
    el('pomoAutoFocus').checked = cfg.autoFocus;
  }

  async function saveSettings() {
    try {
      await API.settings.update({
        pomodoro: {
          workDuration:          cfg.work * 60,
          shortBreakDuration:    cfg.short * 60,
          longBreakDuration:     cfg.long * 60,
          cyclesBeforeLongBreak: cfg.rounds,
          autoStartBreaks:       cfg.autoBreaks,
          autoStartFocus:        cfg.autoFocus,
        },
      });
      const notice = el('pomoSaved');
      notice.textContent = active ? 'Saved. Applies from the next phase.' : 'Saved';
      clearTimeout(saveNoticeTimer);
      saveNoticeTimer = setTimeout(() => { notice.textContent = ''; }, 2500);
    } catch (err) { console.error('Failed to save pomodoro settings:', err); }
  }

  function setField(field, value) {
    const { min, max } = LIMITS[field];
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) return;
    cfg[field] = Math.min(max, Math.max(min, parsed));
    renderSettings();
    render();
    saveSettings();
  }

  function bindSettings() {
    el('btnPomoSettings').addEventListener('click', () => {
      const panel = el('pomoSettingsPanel');
      panel.hidden = !panel.hidden;
      el('btnPomoSettings').setAttribute('aria-expanded', String(!panel.hidden));
      el('pomoLayout').classList.toggle('is-settings-open', !panel.hidden);
    });

    el('pomoPresets').addEventListener('click', e => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;
      const { work, short, long, rounds } = PRESETS[btn.dataset.preset];
      Object.assign(cfg, { work, short, long, rounds });
      renderSettings();
      render();
      saveSettings();
    });

    el('pomoSettingsPanel').addEventListener('click', e => {
      const stepBtn = e.target.closest('[data-pomo-step]');
      if (!stepBtn) return;
      const field = stepBtn.dataset.pomoStep;
      const dir = parseInt(stepBtn.dataset.dir);
      const { step } = LIMITS[field];
      // Lands on round numbers: 27 goes to 30 or 25, not 32 or 22
      const next = dir > 0
        ? Math.floor(cfg[field] / step) * step + step
        : Math.ceil(cfg[field] / step) * step - step;
      setField(field, next);
    });

    el('pomoSettingsPanel').addEventListener('change', e => {
      const field = e.target.dataset.pomoField;
      if (field) { setField(field, e.target.value); return; }
      if (e.target.id === 'pomoAutoBreaks') { cfg.autoBreaks = e.target.checked; saveSettings(); }
      if (e.target.id === 'pomoAutoFocus')  { cfg.autoFocus  = e.target.checked; saveSettings(); }
    });
  }

  async function init(categories) {
    populateCategorySelect(categories);

    el('btnPomodoroToggle')?.addEventListener('click', toggle);

    el('pomodoroCategory')?.addEventListener('change', () => {
      if (!active) render();
    });

    el('btnPomodoroScreenSkip')?.addEventListener('click', async () => {
      AlertSound.stop();
      try { await API.get(`/api/pomodoro/skip?category=${encodeURIComponent(categoryId)}`); }
      catch (err) { console.error(err); }
    });

    el('btnPomodoroStop')?.addEventListener('click', async () => {
      try { await API.get(`/api/pomodoro/stop?category=${encodeURIComponent(categoryId)}`); }
      catch (err) { console.error(err); }
    });

    // Space starts or pauses while this screen is open and you aren't typing
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || App.getCurrentScreen() !== 'pomodoro') return;
      if (e.target.closest('input, select, textarea, button, a')) return;
      e.preventDefault();
      toggle();
    });

    bindSettings();

    try {
      const s = await API.settings.get();
      const p = s.pomodoro || {};
      cfg = {
        work:   Math.round((p.workDuration       || 1500) / 60),
        short:  Math.round((p.shortBreakDuration || 300)  / 60),
        long:   Math.round((p.longBreakDuration  || 900)  / 60),
        rounds: p.cyclesBeforeLongBreak || 4,
        autoBreaks: !!p.autoStartBreaks,
        autoFocus:  !!p.autoStartFocus,
      };
    } catch (err) { console.error('Pomodoro settings:', err); }

    // Restore state if Pomodoro was already running before page load
    try {
      const pomoData = await API.get('/api/pomodoro/statuses');
      const sessions = Array.isArray(pomoData?.sessions) ? pomoData.sessions : [];
      if (sessions.length > 0) {
        const s          = sessions[0];
        active           = true;
        phase            = s.phase;
        completedWork    = s.completedWorkSessions;
        cfg.rounds       = s.cyclesBeforeLongBreak || cfg.rounds;
        categoryId       = s.categoryId;
        waitingForNext   = s.waitingForNext || false;
        nextPhase        = s.waitingForNext ? s.phase : null;
        remainingSeconds = s.remainingSeconds;
        durationSeconds  = s.durationSeconds;
        paused           = s.status === 'paused';
        note             = s.note || '';
        setSelectedCatId(s.categoryId);
      }
    } catch (err) { console.error('Pomodoro restore:', err); }

    renderSettings();
    render();
    await refresh();

    // Keeps "Done by" correct while the screen sits idle
    setInterval(() => { if (!active || waitingForNext || paused) renderTrack(); }, 30000);
  }

  return { init, handleWS, populateCategorySelect, refresh, isActive: () => active };
})();
