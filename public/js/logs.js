const Logs = (() => {
  let allSessions = [];
  let categories  = [];
  let selectMode  = false;
  let selectedIds = new Set();

  // ── Formatters ────────────────────────────────────────────────────────────

  function fmtDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function groupByDay(sessions) {
    const map = {};
    sessions.forEach(s => {
      const day = new Date(s.startTime).toLocaleDateString('sv');
      if (!map[day]) map[day] = [];
      map[day].push(s);
    });
    return map;
  }

  function fmtDayLabel(isoDate) {
    const d = new Date(isoDate + 'T00:00:00');
    const today     = new Date().toLocaleDateString('sv');
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv');
    if (isoDate === today)     return 'Today';
    if (isoDate === yesterday) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function sourceTag(source) {
    const map = {
      'app':         ['Timer',     'log-source-tag--timer'],
      'stream-deck': ['Deck',      'log-source-tag--deck'],
      'stopwatch':   ['Stopwatch', 'log-source-tag--stopwatch'],
      'pomodoro':    ['Pomodoro',  'log-source-tag--pomodoro'],
      'manual':      ['Manual',    'log-source-tag--manual'],
    };
    const [label, cls] = map[source] || ['Timer', 'log-source-tag--timer'];
    return `<span class="log-source-tag ${cls}">${label}</span>`;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    const list = document.getElementById('logList');
    if (!list) return;

    document.getElementById('logDefaultActions').hidden = selectMode;
    document.getElementById('logSelectActions').hidden  = !selectMode;

    const filterCat = document.getElementById('logFilterCategory')?.value || '';
    let sessions = [...allSessions].sort((a, b) => b.startTime.localeCompare(a.startTime));
    if (filterCat) sessions = sessions.filter(s => s.categoryId === filterCat);

    if (sessions.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <i data-lucide="inbox"></i>
          <p class="empty-state__text">No sessions yet. Start the timer to track your first session.</p>
        </div>`;
      lucide.createIcons();
      return;
    }

    const byDay = groupByDay(sessions);
    const days  = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

    list.innerHTML = days.map(day => {
      const daySessions = byDay[day];
      const entries = daySessions.map(s => {
        const cat     = categories.find(c => c.id === s.categoryId);
        const color   = cat ? cat.color : '#6366F1';
        const catName = esc(cat ? cat.name : s.categoryId);
        const note    = s.note ? `<div class="log-entry__note">${esc(s.note)}</div>` : '';
        const checked = selectedIds.has(s.id);

        if (selectMode) {
          return `
            <div class="log-entry log-entry--selectable${checked ? ' log-entry--selected' : ''}" data-id="${s.id}">
              <div class="log-entry__checkbox${checked ? ' log-entry__checkbox--checked' : ''}" aria-hidden="true">
                ${checked ? '<i data-lucide="check"></i>' : ''}
              </div>
              <div class="log-entry__color" style="background:${color}"></div>
              <div class="log-entry__info">
                <div class="log-entry__top">
                  <span class="log-entry__category">${catName}</span>
                  ${sourceTag(s.source)}
                </div>
                ${note}
              </div>
              <div class="log-entry__time">${fmtTime(s.startTime)}</div>
              <div class="log-entry__duration">${fmtDuration(s.durationSeconds)}</div>
            </div>`;
        }

        return `
          <div class="log-entry" data-id="${s.id}">
            <div class="log-entry__checkbox log-entry__checkbox--idle" data-check="${s.id}" aria-label="Select session"></div>
            <div class="log-entry__color" style="background:${color}"></div>
            <div class="log-entry__info">
              <div class="log-entry__top">
                <span class="log-entry__category">${catName}</span>
                ${sourceTag(s.source)}
              </div>
              ${note}
            </div>
            <div class="log-entry__time">${fmtTime(s.startTime)}</div>
            <div class="log-entry__duration">${fmtDuration(s.durationSeconds)}</div>
            <button class="btn btn--icon log-entry__edit" data-edit-session="${s.id}" aria-label="Edit ${catName} session" title="Edit session">
              <i data-lucide="pencil"></i>
            </button>
          </div>`;
      }).join('');

      const dayTotal = daySessions.reduce((sum, s) => sum + s.durationSeconds, 0);

      return `
        <div class="log-day">
          <div class="log-day__header">
            <span>${fmtDayLabel(day)}</span>
            <span class="log-day__total">${fmtDuration(dayTotal)}</span>
          </div>
          <div class="log-day__rows">${entries}</div>
        </div>`;
    }).join('');

    lucide.createIcons();
    syncSelectUI();
    bindListEvents(list);
  }

  function bindListEvents(list) {
    if (selectMode) {
      list.querySelectorAll('.log-entry--selectable').forEach(row => {
        row.addEventListener('click', () => toggleRow(row.dataset.id));
      });
    } else {
      // Idle checkbox — clicking enters select mode and selects that row
      list.querySelectorAll('[data-check]').forEach(cb => {
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = cb.dataset.check;
          enterSelectMode();
          toggleRow(id);
        });
      });

      list.querySelectorAll('[data-edit-session]').forEach(btn => {
        btn.addEventListener('click', () => {
          const session = allSessions.find(s => s.id === btn.dataset.editSession);
          if (session) SessionForm.open({ session });
        });
      });
    }
  }

  // ── Selection helpers ─────────────────────────────────────────────────────

  function toggleRow(id) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    if (selectedIds.size === 0) { exitSelectMode(); return; }
    // Update just the changed row — no full re-render needed
    const row = document.querySelector(`.log-entry[data-id="${id}"]`);
    if (row) {
      const checked = selectedIds.has(id);
      row.classList.toggle('log-entry--selected', checked);
      const cb = row.querySelector('.log-entry__checkbox');
      if (cb) {
        cb.classList.toggle('log-entry__checkbox--checked', checked);
        cb.innerHTML = checked ? '<i data-lucide="check"></i>' : '';
        if (checked) lucide.createIcons({ nodes: [cb] });
      }
    }
    syncSelectUI();
  }

  function getVisibleIds() {
    return [...document.querySelectorAll('#logList .log-entry[data-id]')].map(el => el.dataset.id);
  }

  function syncSelectUI() {
    const count       = selectedIds.size;
    const countEl     = document.getElementById('logSelectCount');
    const deleteBtn   = document.getElementById('logDeleteBtn');
    const selectAllBtn = document.getElementById('logSelectAllBtn');

    if (countEl)   countEl.textContent  = count === 1 ? '1 selected' : `${count} selected`;
    if (deleteBtn) deleteBtn.disabled   = count === 0;

    const visibleIds  = getVisibleIds();
    const allChecked  = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
    if (selectAllBtn) selectAllBtn.textContent = allChecked ? 'Deselect All' : 'Select All';
  }

  function enterSelectMode() {
    selectMode = true;
    selectedIds.clear();
    document.getElementById('logDefaultActions').hidden = true;
    document.getElementById('logSelectActions').hidden  = false;
    render();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds.clear();
    document.getElementById('logDefaultActions').hidden = false;
    document.getElementById('logSelectActions').hidden  = true;
    render();
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map(id => API.logs.delete(id)));
      allSessions = allSessions.filter(s => !ids.includes(s.id));
      exitSelectMode();
      App.refreshDashboard();
    } catch (err) { console.error(err); }
  }

  // ── Filter + init ─────────────────────────────────────────────────────────

  function populateFilter() {
    const sel = document.getElementById('logFilterCategory');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    sel.value = current;
  }

  async function refresh() {
    try {
      const data = await API.logs.list();
      allSessions = data.sessions;
      render();
    } catch (err) { console.error(err); }
  }

  async function init(cats) {
    categories = cats;
    populateFilter();

    document.getElementById('logFilterCategory')
      ?.addEventListener('change', render);

    document.getElementById('logExportBtn')?.addEventListener('click', () => {
      if (allSessions.length === 0) {
        App.showToast('No sessions to export.');
        return;
      }
      window.location = '/api/logs/export';
    });

    document.getElementById('logCancelSelectBtn')
      ?.addEventListener('click', exitSelectMode);
    document.getElementById('logDeleteBtn')
      ?.addEventListener('click', deleteSelected);
    document.getElementById('logSelectAllBtn')
      ?.addEventListener('click', () => {
        const visibleIds = getVisibleIds();
        const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
        if (allChecked) {
          visibleIds.forEach(id => selectedIds.delete(id));
        } else {
          visibleIds.forEach(id => selectedIds.add(id));
        }
        // Update each row directly (same as toggleRow) instead of full re-render
        visibleIds.forEach(id => {
          const row = document.querySelector(`.log-entry[data-id="${id}"]`);
          if (!row) return;
          const checked = selectedIds.has(id);
          row.classList.toggle('log-entry--selected', checked);
          const cb = row.querySelector('.log-entry__checkbox');
          if (cb) {
            if (checked) cb.classList.remove('log-entry__checkbox--idle');
            cb.classList.toggle('log-entry__checkbox--checked', checked);
            cb.innerHTML = checked ? '<i data-lucide="check"></i>' : '';
            if (checked) lucide.createIcons({ nodes: [cb] });
          }
        });
        syncSelectUI();
      });

    await refresh();
  }

  function setCategories(cats) {
    categories = cats;
    populateFilter();
  }

  return { init, refresh, setCategories };
})();
