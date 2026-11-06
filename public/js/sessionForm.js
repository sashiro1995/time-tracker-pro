// One form for logging time away from the PC (from Goals) and editing a session (from the Log).
// You pick when it started and when it finished; the duration is worked out from those.
const SessionForm = (() => {
  const MAX_SECONDS = 24 * 3600;
  let editing = null;
  let initialStart = '';
  let initialEnd = '';

  const el = id => document.getElementById(id);
  const toInputValue = date => `${date.toLocaleDateString('sv')}T${date.toLocaleTimeString('sv').slice(0, 5)}`;

  function fmtDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    return h > 0 ? `${h}h` : `${m}m`;
  }

  // Pauses of the session being edited that still fall inside the chosen start and end
  function pausesWithin(startMs, endMs) {
    return (editing?.pauses || [])
      .map(p => ({ start: Math.max(new Date(p.start).getTime(), startMs), end: Math.min(new Date(p.end).getTime(), endMs) }))
      .filter(p => p.end > p.start);
  }

  // Reads both times. Returns null while either is empty.
  function readRange() {
    const startValue = el('sessionStart').value;
    const endValue   = el('sessionEnd').value;
    if (!startValue || !endValue) return null;
    const startMs = new Date(startValue).getTime();
    const endMs   = new Date(endValue).getTime();
    const pauses  = pausesWithin(startMs, endMs);
    const pausedSecs = pauses.reduce((sum, p) => sum + (p.end - p.start) / 1000, 0);
    return { startValue, endValue, startMs, endMs, pauses, seconds: Math.round((endMs - startMs) / 1000 - pausedSecs), pausedSecs };
  }

  function unchanged() {
    return editing && el('sessionStart').value === initialStart && el('sessionEnd').value === initialEnd;
  }

  function updateTotal() {
    const total = el('sessionTotal');
    const range = readRange();
    let seconds = null;
    if (unchanged()) seconds = editing.durationSeconds;
    else if (range && range.seconds > 0) seconds = range.seconds;

    if (seconds === null) {
      total.textContent = '';
    } else {
      const paused = range && range.pausedSecs >= 60 ? ` (not counting ${fmtDuration(range.pausedSecs)} paused)` : '';
      total.textContent = `Duration: ${fmtDuration(seconds)}${paused}`;
    }

    document.querySelectorAll('[data-session-minutes]').forEach(chip => {
      const active = !!range && !range.pauses.length && Number(chip.dataset.sessionMinutes) * 60 === range.seconds;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active);
    });
  }

  function fillCategories(selectedId) {
    const select = el('sessionCategory');
    select.innerHTML = '';
    const options = App.getCategories().filter(c => !c.archived || c.id === selectedId);
    options.forEach(c => select.add(new Option(c.name, c.id)));
    // A session can outlive its category
    if (!options.some(c => c.id === selectedId)) select.add(new Option(selectedId, selectedId));
    select.value = selectedId;
  }

  function showError(message) {
    const error = el('sessionError');
    error.textContent = message;
    error.hidden = !message;
  }

  function open({ categoryId, session = null }) {
    editing = session;
    showError('');
    fillCategories(session ? session.categoryId : categoryId);
    const end   = session ? new Date(session.endTime) : new Date();
    const start = session ? new Date(session.startTime) : new Date(end.getTime() - 30 * 60 * 1000);
    initialStart = toInputValue(start);
    initialEnd   = toInputValue(end);
    el('sessionStart').value = initialStart;
    el('sessionEnd').value   = initialEnd;
    el('sessionNote').value  = session?.note || '';
    el('sessionModalTitle').textContent = session ? 'Edit session' : 'Log time';
    el('btnSessionSave').textContent    = session ? 'Save changes' : 'Log time';
    updateTotal();
    el('sessionModal').hidden = false;
    el('sessionStart').focus();
  }

  function close() {
    el('sessionModal').hidden = true;
    editing = null;
  }

  async function refreshScreens() {
    await Logs.refresh();
    App.refreshDashboard();
    if (App.getCurrentScreen() === 'goals') App.renderGoals();
  }

  async function save(e) {
    e.preventDefault();
    const original = editing;
    const body = {
      categoryId: el('sessionCategory').value,
      note: el('sessionNote').value.trim(),
    };

    // Times shown to the minute: untouched times keep the session's exact values
    if (!unchanged()) {
      const range = readRange();
      if (!range) return showError('Choose when it started and when it finished.');
      if (range.endMs <= range.startMs) return showError('The finish time has to be after the start time.');
      if (range.endMs > Date.now()) return showError('The finish time can\'t be in the future.');
      if (range.seconds > MAX_SECONDS) return showError('A session can be up to 24 hours.');
      if (range.seconds < 60) return showError('A session has to be at least a minute.');

      body.startTime = el('sessionStart').value === initialStart && original ? original.startTime : new Date(range.startMs).toISOString();
      body.endTime   = el('sessionEnd').value === initialEnd && original ? original.endTime : new Date(range.endMs).toISOString();
      body.durationSeconds = range.seconds;
      if (original?.pauses) {
        body.pauses = range.pauses.map(p => ({ start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() }));
      }
    }

    const saveBtn = el('btnSessionSave');
    saveBtn.disabled = true;
    try {
      if (original) {
        await API.logs.update(original.id, body);
        close();
        await refreshScreens();
        App.showToast('Session updated');
      } else {
        const created = await API.logs.create({ ...body, source: 'manual' });
        close();
        await refreshScreens();
        const name = App.getCategoryById(body.categoryId)?.name || body.categoryId;
        App.showToast(`Logged ${fmtDuration(body.durationSeconds)} to ${name}`, 6000, {
          label: 'Undo',
          onClick: async () => {
            await API.logs.delete(created.id);
            await refreshScreens();
          },
        });
      }
    } catch (err) {
      console.error('Failed to save session:', err);
      showError('Could not save. Try again.');
    } finally {
      saveBtn.disabled = false;
    }
  }

  function init() {
    el('sessionForm').addEventListener('submit', save);
    el('sessionForm').addEventListener('input', () => { showError(''); updateTotal(); });
    el('btnSessionCancel').addEventListener('click', close);
    el('sessionModal').addEventListener('click', e => { if (e.target === el('sessionModal')) close(); });
    el('sessionChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-session-minutes]');
      if (!chip) return;
      // Quick fill keeps the finish time and moves the start back
      const endValue = el('sessionEnd').value || toInputValue(new Date());
      el('sessionEnd').value = endValue;
      const start = new Date(new Date(endValue).getTime() - Number(chip.dataset.sessionMinutes) * 60 * 1000);
      el('sessionStart').value = toInputValue(start);
      showError('');
      updateTotal();
    });
  }

  return { init, open };
})();
