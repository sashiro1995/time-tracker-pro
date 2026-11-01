const Appearance = (() => {
  const CACHE_KEY = 'appearance';
  const DEFAULTS = { theme: 'fluorescent', accent: null, zoom: 1 };

  const THEMES = [
    { id: 'fluorescent', label: 'Fluorescent Nights' },
    { id: 'sunset',      label: 'Moody Sunset' },
    { id: 'ocean',       label: 'Ocean Deep' },
    { id: 'night',       label: 'Night Sky' },
    { id: 'campfire',    label: 'Campfire' },
    { id: 'gray',        label: 'Gray' },
  ];
  const ACCENTS = ['#E63950', '#DB2777', '#EA580C', '#16A34A', '#0284C7', '#7C3AED', '#D4D4D8'];
  const SIZES = [
    { zoom: 0.9,  label: 'Small' },
    { zoom: 1,    label: 'Default' },
    { zoom: 1.1,  label: 'Large' },
    { zoom: 1.25, label: 'Extra large' },
  ];

  let state = { ...DEFAULTS };

  function readCache() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CACHE_KEY)) }; }
    catch { return { ...DEFAULTS }; }
  }

  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch {}
  }

  // Light text unless the accent is too pale to read it on
  function onColor(hex) {
    const [r, g, b] = [1, 3, 5]
      .map(i => parseInt(hex.substr(i, 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return 1.05 / (luminance + 0.05) >= 3 ? 'var(--text-primary)' : 'var(--bg-base)';
  }

  function rgbToHex(value) {
    if (value.startsWith('#')) return value;
    const parts = value.match(/\d+/g).slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0'));
    return `#${parts.join('')}`;
  }

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    if (state.accent) {
      root.style.setProperty('--color-primary', state.accent);
    } else {
      root.style.removeProperty('--color-primary');
    }
    window.electronAPI?.setZoom?.(state.zoom);

    // The stylesheet isn't loaded on the very first call; init() runs this again once it is
    const primary = getComputedStyle(root).getPropertyValue('--color-primary').trim();
    if (primary) root.style.setProperty('--color-on-primary', onColor(rgbToHex(primary)));
  }

  function baseColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim();
  }

  function save() {
    writeCache();
    API.settings.update({ appearance: { ...state, baseColor: baseColor() } })
      .catch(err => console.error('Failed to save appearance:', err));
  }

  function change(patch) {
    state = { ...state, ...patch };
    apply();
    renderControls();
    save();
  }

  // ── Settings controls ─────────────────────────────────────────────────────
  function renderControls() {
    const grid = document.getElementById('themeGrid');
    if (!grid) return;

    grid.innerHTML = THEMES.map(t => `
      <button type="button" class="theme-card${t.id === state.theme ? ' is-active' : ''}" data-theme-pick="${t.id}" aria-pressed="${t.id === state.theme}">
        <span class="theme-card__swatch" data-theme="${t.id}"></span>
        <span>${t.label}</span>
      </button>`).join('');

    const current = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim().toLowerCase();
    const hex = rgbToHex(current);
    document.getElementById('accentSwatches').innerHTML = ACCENTS.map(color => `
      <button type="button" class="note-swatch${color.toLowerCase() === hex ? ' is-active' : ''}" data-accent="${color}" aria-label="Accent ${color}" style="--swatch:${color}"></button>`).join('');
    document.getElementById('accentCustom').classList.toggle('is-active', !ACCENTS.some(c => c.toLowerCase() === hex));
    document.getElementById('accentCustomInput').value = hex;

    document.getElementById('textSizeControl').innerHTML = SIZES.map(s => `
      <button type="button" class="segmented__btn${s.zoom === state.zoom ? ' is-active' : ''}" data-zoom="${s.zoom}">${s.label}</button>`).join('');
    document.getElementById('textSizeGroup').hidden = !window.electronAPI?.setZoom;

    document.getElementById('btnAppearanceReset').hidden =
      state.theme === DEFAULTS.theme && !state.accent && state.zoom === DEFAULTS.zoom;
  }

  function bindControls() {
    document.getElementById('themeGrid').addEventListener('click', e => {
      const card = e.target.closest('[data-theme-pick]');
      // A new theme brings its own accent
      if (card) change({ theme: card.dataset.themePick, accent: null });
    });
    document.getElementById('accentSwatches').addEventListener('click', e => {
      const swatch = e.target.closest('[data-accent]');
      if (swatch) change({ accent: swatch.dataset.accent });
    });
    document.getElementById('accentCustomInput').addEventListener('change', e => change({ accent: e.target.value }));
    document.getElementById('textSizeControl').addEventListener('click', e => {
      const btn = e.target.closest('[data-zoom]');
      if (btn) change({ zoom: parseFloat(btn.dataset.zoom) });
    });
    document.getElementById('btnAppearanceReset').addEventListener('click', () => change({ ...DEFAULTS }));
  }

  // settings.json is the saved copy; the browser cache only exists to avoid a flash at startup
  async function init() {
    try {
      const { appearance } = await API.settings.get();
      if (appearance) {
        const { theme, accent, zoom } = appearance;
        state = { ...DEFAULTS, theme: theme || DEFAULTS.theme, accent: accent || null, zoom: zoom || DEFAULTS.zoom };
      }
    } catch (err) { console.error('Failed to load appearance:', err); }
    apply();
    writeCache();
    bindControls();
    renderControls();
  }

  // Keyboard users keep the focus ring; a mouse click doesn't leave one behind
  document.addEventListener('pointerdown', () => document.documentElement.classList.add('using-mouse'), true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') document.documentElement.classList.remove('using-mouse');
  }, true);

  state = readCache();
  apply();

  return { init };
})();
