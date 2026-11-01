const Timer = (() => {
  // circumference of r=96 circle
  const CIRC = 2 * Math.PI * 96;

  let allTimers     = [];    // array of active timer objects from server
  let allCategories = [];
  let ws            = null;
  let selectedDuration = 1500;

  function isPomodoroActive() {
    return typeof Pomodoro !== 'undefined' && Pomodoro.isActive();
  }

  // ── Category select helpers ────────────────────────────────────────────────
  function getSelectedCatId() {
    return document.getElementById('timerCategory')?.value ?? null;
  }

  function setSelectedCatId(id) {
    const sel = document.getElementById('timerCategory');
    if (sel && id) sel.value = id;
  }

  function getTimerForCat(catId) {
    return allTimers.find(t => t.categoryId === catId && !t.pomodoroPhase) ?? null;
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function connectWS() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);

      if (msg.type.startsWith('stopwatch:')) {
        Stopwatch.handleWS(msg);
        return;
      }

      if (msg.type === 'timer:dismissed') {
        AlertSound.stop();
        if (msg.categoryId) App.clearTimerFinished(msg.categoryId);
        return;
      }

      if (msg.type === 'timer:pomodoro-phase') {
        const wasActive = isPomodoroActive();
        if (msg.auto) AlertSound.playOnce();
        if (typeof Pomodoro !== 'undefined') Pomodoro.handleWS(msg);
        if (msg.timers !== undefined) applyTimers(msg.timers, getSelectedCatId());
        if (!wasActive) App.showScreen('pomodoro');
        return;
      }

      if (msg.type === 'timer:pomodoro-waiting') {
        if (typeof Pomodoro !== 'undefined') Pomodoro.handleWS(msg);
        return;
      }

      if (msg.type === 'timer:pomodoro-stopped') {
        AlertSound.stop();
        if (typeof Pomodoro !== 'undefined') Pomodoro.handleWS(msg);
        if (msg.timers !== undefined) applyTimers(msg.timers, getSelectedCatId());
        App.refreshDashboard();
        Logs.refresh();
        return;
      }

      if (msg.timers !== undefined) {
        const prevSelectedCatId = getSelectedCatId();
        applyTimers(msg.timers, prevSelectedCatId);
        if (typeof Pomodoro !== 'undefined') Pomodoro.handleWS(msg);
      }

      if (msg.type === 'timer:finished') {
        if (!isPomodoroActive()) {
          AlertSound.play();
          if (msg.session?.categoryId) App.markTimerFinished(msg.session.categoryId);
        }
        App.refreshDashboard();
        Logs.refresh();
      } else if (msg.type === 'timer:started') {
        if (!isPomodoroActive()) AlertSound.stop();
      } else if (msg.type === 'timer:stopped') {
        AlertSound.stop();
        App.refreshDashboard();
        Logs.refresh();
        if (msg.session?.categoryId) App.clearTimerFinished(msg.session.categoryId);
      }
    });
    ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  }

  // ── State helpers ──────────────────────────────────────────────────────────
  function applyTimers(list, preferCatId) {
    allTimers = list;

    // Decide what to show in the timer ring
    const regularTimers = allTimers.filter(t => !t.pomodoroPhase);
    const preferred = regularTimers.find(t => t.categoryId === preferCatId);
    if (!preferred && regularTimers.length > 0) {
      // Previously selected category was removed — auto-focus running or first
      const running = regularTimers.find(t => t.status === 'running');
      const next    = running ?? regularTimers[0];
      if (next) setSelectedCatId(next.categoryId);
    }

    render();
    updateSidebarTimers();
    renderTimerQueue();
    if (typeof App !== 'undefined') App.onTimersUpdate(allTimers);
  }

  function fmtTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  // ── Ring + controls render ─────────────────────────────────────────────────
  function render() {
    const display = document.getElementById('timerDisplay');
    const ring    = document.getElementById('timerRingProgress');
    const catLbl  = document.getElementById('timerCategoryLabel');
    if (!display) return;

    const catId = getSelectedCatId();
    const active = getTimerForCat(catId);

    let secs, total, status;
    if (active) {
      secs   = active.remainingSeconds;
      total  = active.durationSeconds;
      status = active.status;
    } else {
      secs   = selectedDuration;
      total  = selectedDuration;
      status = 'idle';
    }

    const pct = total > 0 ? secs / total : 1;
    display.textContent              = fmtTime(secs);
    ring.style.strokeDasharray       = CIRC;
    ring.style.strokeDashoffset      = CIRC * (1 - pct);

    const cat = catId !== '__none__' ? App.getCategoryById(catId) : null;
    catLbl.textContent = cat ? cat.name : (catId === '__none__' ? 'No category' : '—');
    ring.style.stroke = cat ? cat.color : 'var(--text-muted)';

    const btnToggle   = document.getElementById('btnTimerToggle');
    const iconPlay    = document.getElementById('timerToggleIconPlay');
    const iconPause   = document.getElementById('timerToggleIconPause');
    const toggleLabel = document.getElementById('timerToggleLabel');
    const btnStop     = document.getElementById('btnTimerStop');

    if (status === 'running') {
      iconPlay.hidden  = true;
      iconPause.hidden = false;
      toggleLabel.textContent = 'Pause';
      btnToggle.setAttribute('aria-label', 'Pause timer');
    } else if (status === 'paused') {
      iconPlay.hidden  = false;
      iconPause.hidden = true;
      toggleLabel.textContent = 'Resume';
      btnToggle.setAttribute('aria-label', 'Resume timer');
    } else {
      iconPlay.hidden  = false;
      iconPause.hidden = true;
      toggleLabel.textContent = 'Start';
      btnToggle.setAttribute('aria-label', 'Start timer');
    }
    btnStop.hidden = status === 'idle';
  }

  // ── Sidebar multi-timer stack ─────────────────────────────────────────────
  function updateSidebarTimers() {
    const container = document.getElementById('sidebarTimers');
    if (!container) return;
    container.innerHTML = '';

    allTimers.forEach(t => {
      const cat   = t.categoryId !== '__none__' ? App.getCategoryById(t.categoryId) : null;
      const color = cat?.color ?? 'var(--text-muted)';
      const catName = cat?.name ?? (t.categoryId === '__none__' ? 'No category' : t.categoryId);
      const isPomoBreak = t.pomodoroPhase === 'short-break' || t.pomodoroPhase === 'long-break';
      const name  = isPomoBreak ? 'Break' : catName;
      const time  = fmtTime(t.remainingSeconds);

      const card = document.createElement('div');
      card.className = 'sidebar__timer-card';
      card.style.setProperty('--card-color', color);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${name} ${time}`);

      card.innerHTML = `
        <div class="sidebar__timer-card__label">
          <span class="pulse-dot${t.status === 'running' ? '' : ' pulse-dot--static'}"></span>
          <span>${name}</span>
        </div>
        <div class="sidebar__timer-card__time">${time}</div>`;

      const focus = () => {
        if (t.pomodoroPhase) { App.showScreen('pomodoro'); return; }
        setSelectedCatId(t.categoryId);
        App.showScreen('timer');
        render();
        renderTimerQueue();
      };
      card.addEventListener('click', focus);
      card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); focus(); } });

      container.appendChild(card);
    });
  }

  // ── Timer queue (below ring — other active timers) ────────────────────────
  function renderTimerQueue() {
    const queue = document.getElementById('timerQueue');
    const list  = document.getElementById('timerQueueList');
    if (!queue || !list) return;

    const catId  = getSelectedCatId();
    const others = allTimers.filter(t => t.categoryId !== catId && !t.pomodoroPhase);

    queue.hidden = others.length === 0;
    list.innerHTML = '';

    others.forEach(t => {
      const cat   = t.categoryId !== '__none__' ? App.getCategoryById(t.categoryId) : null;
      const color = cat?.color ?? 'var(--text-muted)';
      const name  = cat?.name ?? (t.categoryId === '__none__' ? 'No category' : t.categoryId);
      const time  = fmtTime(t.remainingSeconds);

      const card = document.createElement('div');
      card.className = 'timer-queue-card';

      const isRunning    = t.status === 'running';
      const toggleLabel  = isRunning ? 'Pause' : 'Resume';
      const toggleAriaLabel = isRunning ? `Pause ${name}` : `Resume ${name}`;

      card.innerHTML = `
        <div class="timer-queue-card__swatch" style="background:${color}"></div>
        <div class="timer-queue-card__info">
          <span class="timer-queue-card__name">${name}</span>
          <span class="timer-queue-card__time">${time}</span>
        </div>
        <div class="timer-queue-card__actions">
          <button class="btn btn--ghost btn--sm" data-action="toggle" aria-label="${toggleAriaLabel}">${toggleLabel}</button>
          <button class="btn btn--ghost btn--sm btn--icon btn--danger-ghost" data-action="stop" aria-label="Stop ${name}" title="Stop &amp; log ${name}">
            <i data-lucide="square"></i>
          </button>
        </div>`;

      card.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
        try {
          if (t.status === 'running') {
            await API.get(`/api/timer/pause?category=${encodeURIComponent(t.categoryId)}`);
          } else {
            await API.timer.start({ categoryId: t.categoryId });
          }
        } catch (err) { console.error(err); }
      });

      card.querySelector('[data-action="stop"]').addEventListener('click', async () => {
        try {
          await API.get(`/api/timer/stop?category=${encodeURIComponent(t.categoryId)}`);
        } catch (err) { console.error(err); }
      });

      list.appendChild(card);
    });

    // Re-init lucide icons for newly created elements
    if (window.lucide) lucide.createIcons({ nodes: [list] });
  }

  // ── Arm server with current selection ────────────────────────────────────
  function armServer() {
    const categoryId = getSelectedCatId();
    const note       = document.getElementById('timerNote')?.value.trim() || '';
    API.post('/api/timer/arm', { categoryId, durationSeconds: selectedDuration, note }).catch(() => {});
  }

  // ── Preset buttons ────────────────────────────────────────────────────────
  function bindPresets() {
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.seconds;
        if (val === 'custom') {
          document.getElementById('customDurationModal').hidden = false;
          return;
        }
        selectedDuration = parseInt(val);
        document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const catId = getSelectedCatId();
        if (!getTimerForCat(catId)) render();  // only re-render idle state
        armServer();
      });
    });
  }

  // ── Custom duration modal ─────────────────────────────────────────────────
  function bindModal() {
    document.getElementById('btnCustomCancel').addEventListener('click', () => {
      document.getElementById('customDurationModal').hidden = true;
    });
    document.getElementById('btnCustomConfirm').addEventListener('click', () => {
      const mins = parseInt(document.getElementById('customMinutes').value) || 0;
      const secs = parseInt(document.getElementById('customSeconds').value) || 0;
      selectedDuration = Math.max(1, Math.min(mins * 60 + secs, 28800));
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('is-active'));
      document.getElementById('customDurationModal').hidden = true;
      const catId = getSelectedCatId();
      if (!getTimerForCat(catId)) render();
      armServer();
    });
    document.getElementById('customDurationModal').addEventListener('click', e => {
      if (e.target === e.currentTarget) e.currentTarget.hidden = true;
    });
  }

  // ── Control buttons ───────────────────────────────────────────────────────
  function bindControls() {
    document.getElementById('btnTimerToggle').addEventListener('click', async () => {
      AlertSound.stop();
      const catId  = getSelectedCatId();
      const active = getTimerForCat(catId);

      if (!active) {
        // Start fresh
        const note = document.getElementById('timerNote').value.trim();
        try {
          await API.timer.start({ duration: selectedDuration, categoryId: catId, note });
        } catch (err) { console.error(err); }
      } else if (active.status === 'running') {
        try { await API.get(`/api/timer/pause?category=${encodeURIComponent(catId)}`); }
        catch (err) { console.error(err); }
      } else if (active.status === 'paused') {
        try { await API.timer.start({ categoryId: catId }); }
        catch (err) { console.error(err); }
      }
    });

    document.getElementById('btnTimerStop').addEventListener('click', async () => {
      AlertSound.stop();
      const catId = getSelectedCatId();
      try {
        await API.get(`/api/timer/stop?category=${encodeURIComponent(catId)}`);
        App.refreshDashboard();
        Logs.refresh();
      } catch (err) { console.error(err); }
    });
  }

  // ── Category select ───────────────────────────────────────────────────────
  function populateCategorySelect(categories) {
    allCategories = categories;
    AlertSound.setCategories(categories);
    const sel = document.getElementById('timerCategory');
    const current = sel.value;
    sel.innerHTML =
      `<option value="__none__">No category</option>` +
      categories
        .filter(c => !c.archived)
        .map(c => `<option value="${c.id}">${c.name}</option>`)
        .join('');
    if (categories.some(c => c.id === current)) sel.value = current;
    const catId = getSelectedCatId();
    if (catId) AlertSound.applyForCategory(catId);
  }

  function applyDurationForCategory(categoryId) {
    if (categoryId === '__none__') return;
    const cat = allCategories.find(c => c.id === categoryId);
    if (!cat || !cat.defaultDuration) return;
    selectedDuration = cat.defaultDuration;
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('is-active'));
    const match = [...document.querySelectorAll('.btn-preset')]
      .find(b => parseInt(b.dataset.seconds) === selectedDuration);
    if (match) match.classList.add('is-active');
    if (!getTimerForCat(categoryId)) render();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init(categories) {
    populateCategorySelect(categories);
    bindPresets();
    bindModal();
    bindControls();
    connectWS();

    document.getElementById('timerCategory').addEventListener('change', e => {
      const catId = e.target.value;
      if (!getTimerForCat(catId)) applyDurationForCategory(catId);
      AlertSound.applyForCategory(catId);
      render();
      renderTimerQueue();
      armServer();
    });
    document.getElementById('timerNote').addEventListener('input', armServer);

    try {
      const list = await API.get('/api/timers');
      if (Array.isArray(list) && list.length > 0) {
        // Auto-focus: running timer first, then first paused
        const running = list.find(t => t.status === 'running');
        const first   = running ?? list[0];
        setSelectedCatId(first.categoryId);
        applyTimers(list, first.categoryId);
      } else {
        // No active timers — apply default duration for whichever category is selected
        const firstCat = getSelectedCatId();
        if (firstCat) applyDurationForCategory(firstCat);
        render();
        updateSidebarTimers();
        renderTimerQueue();
      }
    } catch {
      render();
    }

    armServer();
    await AlertSound.reload();
    AlertSound.bindPicker();
  }

  // Exposed so sidebar cards can call setSelectedCatId + navigate
  function focusCategory(categoryId) {
    setSelectedCatId(categoryId);
    render();
    renderTimerQueue();
  }

  return { init, populateCategorySelect, fmtTime, focusCategory, getTimers: () => allTimers };
})();
