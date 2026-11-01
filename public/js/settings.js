const Settings = (() => {

  const DEFAULT_SHORTCUTS = {
    startTimer:   'Ctrl+Shift+T',
    pauseTimer:   'Ctrl+Shift+P',
    stopTimer:    'Ctrl+Shift+S',
    toggleWindow: 'Ctrl+Shift+Space',
  };

  const SHORTCUT_LABELS = {
    startTimer:   'Start / Resume Timer',
    pauseTimer:   'Pause Timer',
    stopTimer:    'Stop Timer',
    toggleWindow: 'Show / Hide Window',
  };

  let currentShortcuts = { ...DEFAULT_SHORTCUTS };
  let capturingId = null;
  let capturingEl = null;

  // ── Key combo formatting ──────────────────────────────────────────────────
  function formatCombo(e) {
    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey)   parts.push('Alt');
    if (e.metaKey)  parts.push('Super');

    const ignored = new Set(['Control', 'Shift', 'Alt', 'Meta']);
    if (!ignored.has(e.key)) {
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    }

    return parts.join('+');
  }

  // ── Render shortcut rows ─────────────────────────────────────────────────
  function renderShortcuts(shortcuts) {
    const list = document.getElementById('shortcutsList');
    if (!list) return;

    list.innerHTML = Object.entries(SHORTCUT_LABELS).map(([id, label]) => `
      <div class="shortcut-row" data-shortcut-id="${id}">
        <div class="shortcut-row__label">${label}</div>
        <div class="shortcut-input-wrap">
          <button class="shortcut-input" data-shortcut-btn="${id}" aria-label="Click then press keys to set shortcut for ${label}">
            <span class="shortcut-input__keys">${shortcuts[id] || '—'}</span>
          </button>
          <span class="shortcut-conflict" id="conflict-${id}" hidden>Conflict!</span>
        </div>
      </div>
    `).join('');
  }

  // ── Capture mode ─────────────────────────────────────────────────────────
  function startCapture(id, btn) {
    if (capturingId) stopCapture(false);
    capturingId = id;
    capturingEl = btn;
    btn.classList.add('is-capturing');
    btn.querySelector('.shortcut-input__keys').textContent = 'Press keys…';
  }

  function stopCapture(keepValue = true) {
    if (!capturingEl) return;
    capturingEl.classList.remove('is-capturing');
    if (!keepValue) {
      capturingEl.querySelector('.shortcut-input__keys').textContent = currentShortcuts[capturingId] || '—';
    }
    capturingId = null;
    capturingEl = null;
  }

  function onKeyDown(e) {
    if (!capturingId) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = formatCombo(e);
    const modifiersOnly = new Set(['Ctrl', 'Shift', 'Alt', 'Super', 'Ctrl+Shift', 'Ctrl+Alt', 'Shift+Alt', 'Ctrl+Shift+Alt']);
    if (!combo || modifiersOnly.has(combo)) return;

    if (e.key === 'Escape') { stopCapture(false); return; }

    capturingEl.querySelector('.shortcut-input__keys').textContent = combo;
    currentShortcuts[capturingId] = combo;
    stopCapture(true);
  }

  // ── Show/hide Electron-only cards ────────────────────────────────────────
  function updateStartupCardVisibility() {
    const card = document.getElementById('settingsStartupCard');
    // Electron can only launch at startup on Windows and macOS
    if (card) card.hidden = !window.electronAPI?.isElectron || window.electronAPI.platform === 'linux';
    const diagCard = document.getElementById('settingsDiagnosticsCard');
    if (diagCard) diagCard.hidden = !window.electronAPI?.isElectron;
    const updateCard = document.getElementById('settingsUpdateCard');
    if (updateCard) updateCard.hidden = !window.electronAPI?.isElectron;
  }

  // ── Update card state ─────────────────────────────────────────────────────
  let _appVersion    = '';
  let _updateVersion = '';
  let _updateNotes   = '';
  let _updateState   = 'idle';
  let _updatePercent = 0;

  const UPDATE_ERRORS = {
    connection: { text: 'Could not reach GitHub',           sub: 'Check your internet connection and try again.' },
    release:    { text: 'No update information found',      sub: 'The problem is with the release, not your PC. Try again later.' },
    download:   { text: 'The update did not finish downloading', sub: 'Nothing on your PC changed. Try again.' },
    unknown:    { text: 'Could not check for updates',      sub: 'Try again later. Details are in the log file.' },
  };

  // Release notes arrive as HTML from GitHub. Parsing without inserting it keeps only the words.
  function notesToText(html) {
    const spaced = html
      .replace(/<li[^>]*>/gi, '$&• ')
      .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '$&\n');
    return new DOMParser().parseFromString(spaced, 'text/html').body.textContent.replace(/\n\s*\n+/g, '\n').trim();
  }

  function setUpdateState(state, detail) {
    const label = document.getElementById('updateStatusLabel');
    if (!label) return;

    if (state === 'available') {
      _updateVersion = detail.version;
      _updateNotes   = notesToText(detail.notes);
    }
    if (state === 'downloading') _updatePercent = detail ?? 0;

    const uv = _updateVersion;
    const cv = _appVersion ? `Current version: v${_appVersion}` : '';
    const error = UPDATE_ERRORS[detail] || UPDATE_ERRORS.unknown;

    const states = {
      idle:        { icon: 'circle-check',   text: _appVersion ? `Version ${_appVersion}` : 'Updates', sub: 'Nothing downloads or installs until you choose to.', check: true },
      checking:    { icon: 'refresh-cw',     text: 'Checking for updates…',  sub: cv, check: true, checkDisabled: true, spin: true },
      uptodate:    { icon: 'circle-check',   text: 'You\'re up to date',     sub: cv, tone: 'success', check: true },
      available:   { icon: 'arrow-up',       text: `Version ${uv} is available`, sub: `${cv}. Download it when you're ready.`, tone: 'accent', download: true, notes: true, badge: true },
      downloading: { icon: 'download',       text: `Downloading version ${uv}…`, sub: `${_updatePercent}%`, tone: 'accent', progress: true, notes: true, badge: true },
      downloaded:  { icon: 'arrow-up',       text: `Version ${uv} is ready to install`, sub: 'The app closes and reopens by itself. Running timers pause and your data stays as it is. Install now or any time later.', tone: 'accent', install: true, notes: true, badge: true },
      error:       { icon: 'triangle-alert', text: error.text, sub: error.sub, tone: 'warning', check: true },
      unsupported: { icon: 'info',           text: 'Updates work in the installed app', sub: `${cv}. Running from the project folder, so update with git pull, then npm install.` },
    };

    const s = states[state];
    if (!s) return;
    _updateState = state;

    label.textContent = s.text;
    document.getElementById('updateStatusSub').textContent = s.sub;

    const icon = document.getElementById('updateStatusIcon');
    icon.dataset.tone = s.tone || '';
    icon.classList.toggle('is-spinning', !!s.spin);
    if (icon.dataset.icon !== s.icon) {
      icon.dataset.icon = s.icon;
      icon.innerHTML = `<i data-lucide="${s.icon}"></i>`;
      lucide.createIcons({ nodes: [icon] });
    }

    document.getElementById('btnDownloadUpdate').hidden = !s.download;
    document.getElementById('btnInstallUpdate').hidden  = !s.install;
    const checkBtn = document.getElementById('btnCheckUpdates');
    checkBtn.hidden   = !s.check;
    checkBtn.disabled = !!s.checkDisabled;

    document.getElementById('updateProgress').hidden = !s.progress;
    document.getElementById('updateProgressFill').style.width = `${_updatePercent}%`;

    document.getElementById('updateNotes').hidden = !(s.notes && _updateNotes);
    document.getElementById('updateNotesTitle').textContent = `What's new in ${uv}`;
    document.getElementById('updateNotesText').textContent = _updateNotes;

    document.getElementById('settingsUpdateBadge').hidden = !s.badge;
  }

  async function initUpdates() {
    setUpdateState('idle');
    const { version } = await API.app.version().catch(() => ({ version: '' }));
    _appVersion = version;
    const supported = await window.electronAPI.isUpdateSupported();
    if (!supported) { setUpdateState('unsupported'); return; }
    // A new version may have been found while the version number was loading
    if (_updateState === 'idle') setUpdateState('idle');
    else if (_updateState === 'available') setUpdateState('available', { version: _updateVersion, notes: _updateNotes });
  }

  async function loadLogPath() {
    if (!window.electronAPI?.getLogPath) return;
    try {
      const logPath = await window.electronAPI.getLogPath();
      const el = document.getElementById('settingsLogPath');
      if (el) el.textContent = logPath || '—';
    } catch {}
  }

  // ── Load settings and refresh UI ─────────────────────────────────────────
  async function refresh() {
    try {
      const data = await API.settings.get();

      const checkbox = document.getElementById('settingLaunchAtStartup');
      if (checkbox) checkbox.checked = !!data.launchAtStartup;

      // Alert sound mode
      const mode = data.alertSoundMode || 'loop';
      const modeRadio = document.querySelector(`input[name="alertSoundMode"][value="${mode}"]`);
      if (modeRadio) modeRadio.checked = true;
      const durationInput = document.getElementById('alertSoundDurationInput');
      if (durationInput) {
        durationInput.value   = data.alertSoundDuration || 10;
        durationInput.disabled = mode !== 'duration';
      }

      currentShortcuts = { ...DEFAULT_SHORTCUTS, ...(data.shortcuts || {}) };
      renderShortcuts(currentShortcuts);

      lucide.createIcons({ nodes: [document.getElementById('shortcutsList')] });
      lucide.createIcons({ nodes: [document.querySelector('.settings-card__footer')] });
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
    updateStartupCardVisibility();
    await loadLogPath();
    lucide.createIcons({ nodes: [document.getElementById('settingsDiagnosticsCard')] });
  }

  // ── Wire up all event handlers ───────────────────────────────────────────
  function init() {
    updateStartupCardVisibility();

    // Alert sound mode radios
    document.querySelectorAll('input[name="alertSoundMode"]').forEach(radio => {
      radio.addEventListener('change', async () => {
        const mode = radio.value;
        const durationInput = document.getElementById('alertSoundDurationInput');
        if (durationInput) durationInput.disabled = mode !== 'duration';
        try {
          await API.settings.update({ alertSoundMode: mode });
          await AlertSound.reload();
        } catch (err) { console.error('Failed to save sound mode:', err); }
      });
    });

    document.getElementById('alertSoundDurationInput')?.addEventListener('change', async e => {
      const val = Math.max(1, Math.min(3600, parseInt(e.target.value) || 10));
      e.target.value = val;
      try {
        await API.settings.update({ alertSoundDuration: val });
        await AlertSound.reload();
      } catch (err) { console.error('Failed to save sound duration:', err); }
    });

    // Launch at startup toggle
    document.getElementById('settingLaunchAtStartup')?.addEventListener('change', async e => {
      const enable = e.target.checked;
      try {
        await API.settings.update({ launchAtStartup: enable });
        if (window.electronAPI?.setLoginItem) {
          await window.electronAPI.setLoginItem(enable);
        }
      } catch (err) {
        console.error('Failed to save startup setting:', err);
        e.target.checked = !enable;
      }
    });

    // Shortcut button click — start / stop capture
    document.getElementById('shortcutsList')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-shortcut-btn]');
      if (!btn) return;
      const id = btn.dataset.shortcutBtn;
      if (capturingId === id) { stopCapture(false); return; }
      startCapture(id, btn);
    });

    // Open log folder button
    document.getElementById('btnOpenLogFolder')?.addEventListener('click', () => {
      window.electronAPI?.openLogFolder?.();
    });

    // Updates card
    if (window.electronAPI?.isElectron) {
      initUpdates();

      document.getElementById('btnCheckUpdates')?.addEventListener('click', async () => {
        setUpdateState('checking');
        await window.electronAPI.checkForUpdates?.();
      });

      document.getElementById('btnDownloadUpdate')?.addEventListener('click', () => {
        setUpdateState('downloading', 0);
        window.electronAPI.downloadUpdate?.();
      });

      document.getElementById('btnInstallUpdate')?.addEventListener('click', () => {
        window.electronAPI.installUpdate?.();
      });
    }

    // Global keydown listener for capture mode
    document.addEventListener('keydown', onKeyDown, true);

    // Reset defaults
    document.getElementById('btnResetShortcuts')?.addEventListener('click', () => {
      currentShortcuts = { ...DEFAULT_SHORTCUTS };
      renderShortcuts(currentShortcuts);
      lucide.createIcons({ nodes: [document.getElementById('shortcutsList')] });
      clearAllConflicts();
    });

    // Save shortcuts
    document.getElementById('btnSaveShortcuts')?.addEventListener('click', async () => {
      clearAllConflicts();
      const btn = document.getElementById('btnSaveShortcuts');
      btn.disabled = true;
      try {
        await API.settings.update({ shortcuts: currentShortcuts });

        if (window.electronAPI?.setShortcuts) {
          const result = await window.electronAPI.setShortcuts(currentShortcuts);
          if (result?.conflicts?.length) {
            result.conflicts.forEach(id => {
              const el = document.getElementById(`conflict-${id}`);
              if (el) el.hidden = false;
            });
          }
        }

        // Brief visual feedback on success
        const origText = btn.innerHTML;
        btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><i data-lucide="check"></i> Saved</span>';
        lucide.createIcons({ nodes: [btn] });
        setTimeout(() => { btn.innerHTML = origText; lucide.createIcons({ nodes: [btn] }); }, 1500);
      } catch (err) {
        console.error('Failed to save shortcuts:', err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function clearAllConflicts() {
    Object.keys(SHORTCUT_LABELS).forEach(id => {
      const el = document.getElementById(`conflict-${id}`);
      if (el) el.hidden = true;
    });
  }

  return { init, refresh, setUpdateState };
})();
