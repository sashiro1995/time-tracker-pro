// One form for logging time away from the PC (from Goals) and editing a session (from the Log).
const SessionForm = (() => {
  const MAX_SECONDS = 24 * 3600;
  let editing = null;
  let initialEnd = '';

  const el = id => document.getElementById(id);
  const toInputValue = date => `${date.toLocaleDateString('sv')}T${date.toLocaleTimeString('sv').slice(0, 5)}`;

  function fmtDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    return h > 0 ? `${h}h` : `${m}m`;
  }

  function enteredSeconds() {
    const hours   = Math.floor(Number(el('sessionHours').value) || 0);
    const minutes = Math.floor(Number(el('sessionMinutes').value) || 0);
    return Math.max(hours, 0) * 3600 + Math.max(minutes, 0) * 60;
  }

  function syncChips() {
    const seconds = enteredSeconds();
    document.querySelectorAll('[data-session-minutes]').forEach(chip => {
      const active = Number(chip.dataset.sessionMinutes) * 60 === seconds;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active);
    });
  }

  function setDuration(seconds) {
    const hours   = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    el('sessionHours').value   = hours || '';
    el('sessionMinutes').value = minutes || '';
    syncChips();
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
    setDuration(session ? session.durationSeconds : 0);
    initialEnd = toInputValue(session ? new Date(session.endTime) : new Date());
    el('sessionEnd').value  = initialEnd;
    el('sessionNote').value = session?.note || '';
    el('sessionModalTitle').textContent = session ? 'Edit session' : 'Log time';
    el('btnSessionSave').textContent    = session ? 'Save changes' : 'Log time';
    el('sessionModal').hidden = false;
    el('sessionHours').focus();
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
    let seconds = enteredSeconds();
    // The form only shows whole minutes, so an untouched duration keeps its exact seconds
    const durationChanged = !original || seconds !== Math.floor(original.durationSeconds / 60) * 60;
    if (!durationChanged) seconds = original.durationSeconds;

    if (durationChanged && seconds <= 0) return showError('Enter how long it took.');
    if (durationChanged && seconds > MAX_SECONDS) return showError('A session can be up to 24 hours.');

    const endValue = el('sessionEnd').value;
    if (!endValue) return showError('Choose when it finished.');
    const endChanged = !original || endValue !== initialEnd;
    if (endChanged && new Date(endValue) > new Date()) return showError('The finish time can\'t be in the future.');

    const endTime = endChanged ? new Date(endValue).toISOString() : original.endTime;
    // Paused time isn't part of a duration, so an untouched session keeps its original start
    const startTime = (durationChanged || endChanged)
      ? new Date(new Date(endTime).getTime() - seconds * 1000).toISOString()
      : original.startTime;

    const body = {
      categoryId: el('sessionCategory').value,
      startTime,
      endTime,
      durationSeconds: seconds,
      note: el('sessionNote').value.trim(),
    };

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
        App.showToast(`Logged ${fmtDuration(seconds)} to ${name}`, 6000, {
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
    el('sessionForm').addEventListener('input', () => showError(''));
    el('btnSessionCancel').addEventListener('click', close);
    el('sessionModal').addEventListener('click', e => { if (e.target === el('sessionModal')) close(); });
    el('sessionHours').addEventListener('input', syncChips);
    el('sessionMinutes').addEventListener('input', syncChips);
    el('sessionChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-session-minutes]');
      if (!chip) return;
      setDuration(Number(chip.dataset.sessionMinutes) * 60);
      showError('');
    });
  }

  return { init, open };
})();
