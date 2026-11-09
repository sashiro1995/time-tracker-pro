const AlertSound = (() => {
  let alertSoundPath = null;
  let alertAudio     = null;
  let alertSoundMode = 'loop';
  let alertSoundDuration = 10;
  let alertSoundTimer = null;
  let globalSoundPath = null;
  let globalSoundName = null;
  let onSoundSettingsLoaded = null;
  let allCategories = [];

  // Per page load: shared with the WebSocket so connection and sound events match.
  const WIN_ID = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const WIN_KIND = navigator.userAgent.includes('Electron') ? 'app-window' : 'browser';
  function report(action, extra) {
    try {
      fetch('/api/diag/sound', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ action, mode: alertSoundMode, win: WIN_ID, kind: WIN_KIND,
          visible: document.visibilityState, ...extra }),
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Sound row UI ──────────────────────────────────────────────────────────
  function updateSoundRowUI() {
    const row     = document.querySelector('.sound-row');
    const testBtn = document.getElementById('btnTestSound');
    if (row)     row.classList.toggle('sound-row--active', !!alertSoundPath);
    if (testBtn) testBtn.hidden = !alertSoundPath;
  }

  // ── Category-aware sound selection ───────────────────────────────────────
  function applyForCategory(catId) {
    if (catId === '__none__') {
      alertSoundPath = globalSoundPath;
      const el = document.getElementById('soundName');
      if (el) el.textContent = globalSoundName || 'No sound set';
      updateSoundRowUI();
      return;
    }
    const cat = allCategories.find(c => c.id === catId);
    const el  = document.getElementById('soundName');
    if (cat && cat.soundPath) {
      alertSoundPath = cat.soundPath;
      if (el) el.textContent = cat.soundName || 'Category sound';
    } else {
      alertSoundPath = globalSoundPath;
      if (el) el.textContent = globalSoundName || 'No sound set';
    }
    updateSoundRowUI();
  }

  // ── Alert sound ───────────────────────────────────────────────────────────
  // A bar with a Stop sound button shows while the alert plays, on every screen,
  // so silencing it never means starting another session.
  function showStopBar() {
    let bar = document.getElementById('alertStopBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'alertStopBar';
      bar.className = 'alert-stop-bar';
      bar.setAttribute('role', 'status');
      bar.innerHTML = `
        <i data-lucide="bell-ring" aria-hidden="true"></i>
        <span class="alert-stop-bar__text">Time's up</span>
        <button type="button" class="btn btn--primary btn--sm alert-stop-bar__btn" id="btnAlertStop">
          <i data-lucide="volume-x" aria-hidden="true"></i>Stop sound
        </button>`;
      document.body.appendChild(bar);
      bar.querySelector('#btnAlertStop').addEventListener('click', () => stop('stop-button'));
      if (window.lucide) lucide.createIcons({ nodes: [bar] });
    }
    bar.hidden = false;
  }

  function hideStopBar() {
    const bar = document.getElementById('alertStopBar');
    if (bar) bar.hidden = true;
  }

  function play(trigger = 'unknown') {
    stop('replaced');
    if (!alertSoundPath) return;
    report('play', { trigger });
    alertAudio = new Audio(alertSoundPath);
    alertAudio.addEventListener('ended', () => { if (alertAudio && !alertAudio.loop) stop(); });
    showStopBar();
    if (alertSoundMode === 'loop') {
      alertAudio.loop = true;
      alertAudio.play().catch(() => {});
    } else if (alertSoundMode === 'once') {
      alertAudio.play().catch(() => {});
    } else if (alertSoundMode === 'duration') {
      alertAudio.play().catch(() => {});
      alertSoundTimer = setTimeout(() => stop('duration-limit'), alertSoundDuration * 1000);
    }
  }

  function playOnce(trigger = 'unknown') {
    stop('replaced');
    if (!alertSoundPath) return;
    report('play', { trigger, mode: 'once-auto' });
    alertAudio = new Audio(alertSoundPath);
    alertAudio.addEventListener('ended', stop);
    showStopBar();
    alertAudio.play().catch(() => {});
    alertSoundTimer = setTimeout(() => stop('duration-limit'), alertSoundDuration * 1000);
  }

  function stop(reason) {
    if (alertAudio) report('stop', { reason: typeof reason === 'string' ? reason : 'ended' });
    hideStopBar();
    if (alertSoundTimer) {
      clearTimeout(alertSoundTimer);
      alertSoundTimer = null;
    }
    if (alertAudio) {
      alertAudio.pause();
      alertAudio.currentTime = 0;
      alertAudio = null;
    }
  }

  async function reload() {
    try {
      const s = await API.settings.get();
      if (s.alertSound) {
        globalSoundPath = `/sounds/${s.alertSound}?v=${Date.now()}`;
        globalSoundName = s.alertSoundName || null;
      } else {
        globalSoundPath = null;
        globalSoundName = null;
      }
      alertSoundMode     = s.alertSoundMode     || 'loop';
      alertSoundDuration = s.alertSoundDuration || 10;
      const catId = document.getElementById('timerCategory')?.value ?? null;
      if (catId) applyForCategory(catId);
      else {
        alertSoundPath = globalSoundPath;
        const el = document.getElementById('soundName');
        if (el) el.textContent = globalSoundName || 'No sound set';
        updateSoundRowUI();
      }
      if (onSoundSettingsLoaded) onSoundSettingsLoaded(globalSoundName);
    } catch (err) { console.error('AlertSound.reload failed:', err); }
  }

  function bindPicker() {
    const picker = document.getElementById('soundFilePicker');
    document.getElementById('btnChangeSound').addEventListener('click', () => picker.click());
    document.getElementById('btnTestSound').addEventListener('click', () => {
      if (!alertSoundPath) return;
      new Audio(alertSoundPath).play().catch(() => {});
    });

    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target.result.split(',')[1];
        try {
          await API.post('/api/settings/sound', { name: file.name, data: base64 });
          await reload();
        } catch (err) {
          console.error('Sound upload failed:', err);
          alert('Sound upload failed — file may be too large or unsupported format.');
        }
        picker.value = '';
      };
      reader.readAsDataURL(file);
    });
  }

  return {
    windowId: WIN_ID,
    play,
    stop,
    playOnce,
    applyForCategory,
    setCategories: (categories) => { allCategories = categories; },
    reload,
    bindPicker,
    getGlobalSoundPath: () => globalSoundPath,
    getGlobalSoundName: () => globalSoundName,
    onLoaded: (cb) => { onSoundSettingsLoaded = cb; },
  };
})();
