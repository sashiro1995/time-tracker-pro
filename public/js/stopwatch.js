const Stopwatch = (() => {
  let state = {
    status: 'idle',
    categoryId: null,
    elapsedSeconds: 0,
  };

  let allCategories = [];

  // ── Formatting ────────────────────────────────────────────────────────────
  function fmtElapsed(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const display  = document.getElementById('swDisplay');
    const catLabel = document.getElementById('swCategoryLabel');
    if (!display) return;

    display.textContent = fmtElapsed(state.elapsedSeconds);

    const cat = state.categoryId && state.categoryId !== '__none__'
      ? allCategories.find(c => c.id === state.categoryId)
      : null;
    if (catLabel) catLabel.textContent = cat ? cat.name : (state.categoryId === '__none__' ? 'No category' : '—');

    const dot = document.getElementById('swDot');
    if (dot) dot.style.background = cat ? cat.color : 'var(--text-muted)';

    const btnToggle   = document.getElementById('btnSwToggle');
    const iconPlay    = document.getElementById('swToggleIconPlay');
    const iconPause   = document.getElementById('swToggleIconPause');
    const toggleLabel = document.getElementById('swToggleLabel');

    if (state.status === 'running') {
      iconPlay.hidden  = true;
      iconPause.hidden = false;
      toggleLabel.textContent = 'Pause';
      btnToggle.setAttribute('aria-label', 'Pause stopwatch');
    } else {
      iconPlay.hidden  = false;
      iconPause.hidden = true;
      toggleLabel.textContent = state.status === 'paused' ? 'Resume' : 'Start';
      btnToggle.setAttribute('aria-label', state.status === 'paused' ? 'Resume stopwatch' : 'Start stopwatch');
    }
    document.getElementById('btnSwStop').hidden = state.status === 'idle';

    const catSelect = document.getElementById('swCategory');
    const noteInput = document.getElementById('swNote');
    if (catSelect) catSelect.disabled = state.status !== 'idle';
    if (noteInput) noteInput.disabled = state.status !== 'idle';
  }

  // ── WebSocket messages ────────────────────────────────────────────────────
  function handleWS(msg) {
    const sw_events = ['stopwatch:tick','stopwatch:started','stopwatch:paused','stopwatch:stopped'];
    if (!sw_events.includes(msg.type)) return;

    if (msg.stopwatch) {
      Object.assign(state, msg.stopwatch);
    }

    if (msg.type === 'stopwatch:stopped') {
      state = { status: 'idle', categoryId: null, elapsedSeconds: 0 };
      App.refreshDashboard();
      Logs.refresh();
    }

    render();
    updateSidebarStopwatch();
  }

  // ── Sidebar widget ────────────────────────────────────────────────────────
  function updateSidebarStopwatch() {
    const widget   = document.getElementById('sidebarStopwatch');
    const catSpan  = document.getElementById('sidebarSwCategory');
    const timeSpan = document.getElementById('sidebarSwTime');
    if (!widget) return;

    if (state.status === 'idle') { widget.hidden = true; return; }
    widget.hidden = false;
    const cat = allCategories.find(c => c.id === state.categoryId);
    if (catSpan)  catSpan.textContent  = cat ? cat.name : '—';
    if (timeSpan) timeSpan.textContent = fmtElapsed(state.elapsedSeconds);
  }

  // ── Arm server with current UI selection ─────────────────────────────────
  function armServer() {
    const categoryId = document.getElementById('swCategory')?.value;
    const note       = document.getElementById('swNote')?.value.trim() || '';
    API.stopwatch.arm({ categoryId, note }).catch(() => {});
  }

  // ── Controls ──────────────────────────────────────────────────────────────
  function bindControls() {
    document.getElementById('btnSwToggle').addEventListener('click', async () => {
      if (state.status === 'idle') {
        const categoryId = document.getElementById('swCategory').value;
        const note       = document.getElementById('swNote').value.trim();
        try {
          await API.stopwatch.arm({ categoryId, note });
          await API.stopwatch.toggle(categoryId);
        } catch (err) { console.error(err); }
      } else if (state.status === 'running') {
        try { await API.stopwatch.pause(); } catch (err) { console.error(err); }
      } else if (state.status === 'paused') {
        try { await API.stopwatch.toggle(); } catch (err) { console.error(err); }
      }
    });

    document.getElementById('btnSwStop').addEventListener('click', async () => {
      try { await API.stopwatch.stop(); } catch (err) { console.error(err); }
    });
  }

  // ── Category select ───────────────────────────────────────────────────────
  function populateCategorySelect(categories) {
    allCategories = categories;
    const sel = document.getElementById('swCategory');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML =
      `<option value="__none__">No category</option>` +
      categories
        .filter(c => !c.archived)
        .map(c => `<option value="${c.id}">${c.name}</option>`)
        .join('');
    if (categories.some(c => c.id === current)) sel.value = current;
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  async function init(categories) {
    populateCategorySelect(categories);
    bindControls();

    document.getElementById('swCategory').addEventListener('change', armServer);
    document.getElementById('swNote').addEventListener('input', armServer);

    try {
      const s = await API.stopwatch.status();
      Object.assign(state, s);
      if (s.status !== 'idle') {
        const catSelect = document.getElementById('swCategory');
        if (catSelect && s.categoryId) catSelect.value = s.categoryId;
        const noteInput = document.getElementById('swNote');
        if (noteInput && s.note) noteInput.value = s.note;
      }
    } catch {}
    render();
  }

  return { init, populateCategorySelect, handleWS };
})();
