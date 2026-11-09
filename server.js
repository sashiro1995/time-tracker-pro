const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Writable directories (set by main.js; fall back to dev paths) ─────────────
const DATA_DIR   = process.env.DATA_DIR   || path.join(__dirname, 'data');
const SOUNDS_DIR = process.env.SOUNDS_DIR || path.join(__dirname, 'public', 'sounds');
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });

// First run: start from the clean files in defaults/ (personal data in data/ is never shipped)
fs.mkdirSync(DATA_DIR, { recursive: true });
const DEFAULTS_DIR = path.join(__dirname, 'defaults');
for (const file of fs.readdirSync(DEFAULTS_DIR)) {
  const target = path.join(DATA_DIR, file);
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(DEFAULTS_DIR, file), target);
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Diagnostic events stay in the writable data folder, separate from session logs.
// Keep one backup and never let logging failures interrupt timers or requests.
const EVENTS_LOG = path.join(DATA_DIR, 'events.log');
const EVENTS_LOG_MAX = 1024 * 1024;
const requestContext = new AsyncLocalStorage();

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logEvent(event, fields = {}) {
  try {
    const clean = value => String(value).replace(/[\s\x00-\x1f\x7f]+/g, '_').slice(0, 240);
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${clean(v)}`);
    const line = `${stamp()}  ${clean(event).padEnd(26)} ${parts.join('  ')}\n`;
    if (fs.existsSync(EVENTS_LOG) && fs.statSync(EVENTS_LOG).size + Buffer.byteLength(line) > EVENTS_LOG_MAX) {
      fs.renameSync(EVENTS_LOG, path.join(DATA_DIR, 'events.old.log'));
    }
    fs.appendFileSync(EVENTS_LOG, line);
  } catch (_) {}
}

function guessSource(req) {
  if (typeof req.query.src === 'string' && /^[a-z0-9-]{1,32}$/i.test(req.query.src)) return req.query.src;
  const ua = req.headers['user-agent'] || '';
  if (!ua) return 'electron-main';
  if (ua.includes('Electron')) return 'app-window';
  if (ua.includes('Mozilla')) return 'browser';
  return 'other';
}

app.use('/api', (req, res, next) => {
  // Only retain diagnostic parameters; a URL may also contain a private note.
  const source = new URLSearchParams();
  if (typeof req.query.src === 'string' && /^[a-z0-9-]{1,32}$/i.test(req.query.src)) source.set('src', req.query.src);
  const query = source.toString();
  requestContext.run({ via: guessSource(req), route: `${req.method} ${req.originalUrl.split('?')[0]}${query ? '?' + query : ''}` }, next);
});

function catName(id) {
  if (!id) return undefined;
  try { return read(DATA.categories).categories.find(c => c.id === id)?.name || id; }
  catch (_) { return id; }
}

wss.on('connection', (ws, req) => {
  const kind = (req.headers['user-agent'] || '').includes('Electron') ? 'app-window' : 'browser';
  const candidate = new URL(req.url, 'http://localhost').searchParams.get('win');
  const win = /^[a-z0-9]{4,12}$/i.test(candidate || '') ? candidate : undefined;
  logEvent('window:connected', { win, kind, windows: wss.clients.size });
  ws.on('close', () => logEvent('window:disconnected', { win, kind, windows: wss.clients.size }));
});

// Custom sounds live in SOUNDS_DIR (writable); fall back to bundled public/sounds/
app.get('/sounds/:file', (req, res) => {
  const file        = path.basename(req.params.file);
  const userFile    = path.join(SOUNDS_DIR, file);
  const bundledFile = path.join(__dirname, 'public', 'sounds', file);
  if (fs.existsSync(userFile))    return res.sendFile(userFile);
  if (fs.existsSync(bundledFile)) return res.sendFile(bundledFile);
  res.status(404).end();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ─────────────────────────────────────────────────────────────

const DATA = {
  logs:       path.join(DATA_DIR, 'logs.json'),
  categories: path.join(DATA_DIR, 'categories.json'),
  settings:   path.join(DATA_DIR, 'settings.json'),
  timers:     path.join(DATA_DIR, 'timers.json'),
  stopwatch:  path.join(DATA_DIR, 'stopwatch.json'),
  notes:      path.join(DATA_DIR, 'notes.json'),
  trackers:   path.join(DATA_DIR, 'trackers.json'),
};

function read(file)        { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── In-memory stopwatch state ────────────────────────────────────────────────

let stopwatch = {
  status: 'idle',       // idle | running | paused
  categoryId: null,
  note: '',
  startedAt: null,      // ISO string — when the session first began
  resumedAt: null,      // Date.now() — when last resumed (for elapsed calc)
  accumulatedMs: 0,     // ms elapsed before the current running period
};
let swTickInterval = null;
let lastSwToggleMs = 0;

function swElapsedMs() {
  if (stopwatch.status === 'running') {
    return stopwatch.accumulatedMs + (Date.now() - stopwatch.resumedAt);
  }
  return stopwatch.accumulatedMs;
}

function safeStopwatch() {
  return {
    status:         stopwatch.status,
    categoryId:     stopwatch.categoryId,
    note:           stopwatch.note,
    elapsedSeconds: Math.floor(swElapsedMs() / 1000),
  };
}

function stopAndLogStopwatch(source) {
  clearInterval(swTickInterval);
  swTickInterval = null;
  const elapsedSeconds = Math.floor(swElapsedMs() / 1000);
  let session = null;
  if (elapsedSeconds > 0 && stopwatch.categoryId && stopwatch.categoryId !== '__none__') {
    session = {
      id: uuidv4(),
      categoryId:      stopwatch.categoryId,
      startTime:       stopwatch.startedAt,
      endTime:         new Date().toISOString(),
      durationSeconds: elapsedSeconds,
      note:            stopwatch.note,
      source:          source || 'stopwatch',
    };
    const data = read(DATA.logs);
    data.sessions.push(session);
    write(DATA.logs, data);
  }
  stopwatch = { status: 'idle', categoryId: null, note: '', startedAt: null, resumedAt: null, accumulatedMs: 0 };
  write(DATA.stopwatch, { status: 'idle' });
  broadcast({ type: 'stopwatch:stopped', session });
  return session;
}

// ── Multi-timer state ─────────────────────────────────────────────────────────
// Map<categoryId, timerObject>  — absent = idle for that category
// Invariant: at most ONE timer has status === 'running' at any time

const timers = new Map();
const justFinished = new Set();  // categories whose timer completed; next toggle dismisses
const pomodoroStates = new Map(); // categoryId → { phase, completedWorkSessions }

// Armed config: what the Timer screen has selected — used when no ?category= param
let armed = {
  categoryId: null,
  durationSeconds: 1500,
  note: '',
};

const lastToggleMap = new Map();  // categoryId → last toggle timestamp (per-category double-tap)
const DOUBLE_TAP_MS = 600;

const QUIET_EVENTS = new Set(['timer:tick', 'stopwatch:tick', 'trackers:updated', 'timer:finished']);
const startedVia = new Map(); // Diagnostic metadata only; never included in saved timers.

function broadcast(payload) {
  try {
    if (!QUIET_EVENTS.has(payload.type)) {
      const catId = payload.categoryId || payload.timer?.categoryId || payload.session?.categoryId || payload.stopwatch?.categoryId || payload.armed?.categoryId;
      const source = requestContext.getStore();
      const via = source?.via || 'countdown';
      if (payload.type === 'timer:started' && catId) startedVia.set(catId, via);
      logEvent(payload.type, {
        category: catName(catId),
        phase: payload.timer?.pomodoroPhase || payload.phase || payload.nextPhase,
        duration: payload.timer?.durationSeconds ?? payload.duration ?? payload.armed?.durationSeconds,
        auto: payload.auto ? 'yes' : undefined,
        via, route: source?.route, windows: wss.clients.size,
      });
      if (payload.type === 'timer:stopped' && catId) startedVia.delete(catId);
    }
  } catch (_) {}
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function safeTimerObj(t) {
  const { interval, ...rest } = t;
  return rest;
}

function allSafeTimers() {
  return Array.from(timers.values()).map(safeTimerObj);
}

function safeRegularTimers() {
  return allSafeTimers().filter(t => !t.pomodoroPhase);
}

function saveTimers() {
  const savedAt = new Date().toISOString();
  write(DATA.timers, allSafeTimers().map(t => ({ ...t, savedAt })));
}

function saveStopwatch() {
  if (stopwatch.status === 'idle') {
    write(DATA.stopwatch, { status: 'idle' });
    return;
  }
  write(DATA.stopwatch, {
    status: 'paused',
    categoryId: stopwatch.categoryId,
    note: stopwatch.note,
    startedAt: stopwatch.startedAt,
    accumulatedMs: stopwatch.status === 'running'
      ? stopwatch.accumulatedMs + (Date.now() - stopwatch.resumedAt)
      : stopwatch.accumulatedMs,
  });
}

function startSwTick() {
  swTickInterval = setInterval(() => requestContext.exit(() => {
    broadcast({ type: 'stopwatch:tick', stopwatch: safeStopwatch() });
    const elapsed = Math.floor(swElapsedMs() / 1000);
    if (elapsed > 0 && elapsed % 30 === 0) saveStopwatch();
  }), 1000);
}

// Each timer keeps a list of its pauses, so a session that was paused at 1:15 and
// resumed at 2:15 is logged as 1:00–3:00 with the 1:15–2:15 gap recorded.
function markPaused(t, at = new Date().toISOString()) {
  t.pausedAt = at;
  if (!Array.isArray(t.pauses)) t.pauses = [];
  const last = t.pauses[t.pauses.length - 1];
  if (!last || last.end) t.pauses.push({ start: at, end: null });
}

function markResumed(t) {
  t.pausedAt = null;
  const last = Array.isArray(t.pauses) ? t.pauses[t.pauses.length - 1] : null;
  if (last && !last.end) last.end = new Date().toISOString();
}

// Sessions shorter than this are dropped: a stop that quick means something else came up
const MIN_LOG_SECONDS = 60;

// Builds the log entry for a timer that finished or was stopped.
// Stopping while paused ends the session when the pause began, not when Stop was pressed.
function buildSession(t, source) {
  const pauses = (t.pauses || []).filter(p => p.start);
  const open   = pauses.length && !pauses[pauses.length - 1].end ? pauses.pop() : null;
  const session = {
    id: uuidv4(),
    categoryId: t.categoryId,
    startTime:  t.startedAt,
    endTime:    open ? open.start : new Date().toISOString(),
    durationSeconds: t.durationSeconds - t.remainingSeconds,
    note:   t.note,
    source,
  };
  const kept = pauses.filter(p => new Date(p.end) - new Date(p.start) >= 1000);
  if (kept.length) session.pauses = kept;
  return session;
}

// Why a timer's time wasn't logged, or null when it should be
function skipReason(t, categoryId) {
  const elapsed = t.durationSeconds - t.remainingSeconds;
  const isBreakPhase = t.pomodoroPhase === 'short-break' || t.pomodoroPhase === 'long-break';
  if (elapsed <= 0 || isBreakPhase) return 'nothing';
  if (categoryId === '__none__') return 'no-category';
  if (elapsed < MIN_LOG_SECONDS) return 'short';
  return null;
}

function saveSession(session) {
  const data = read(DATA.logs);
  data.sessions.push(session);
  write(DATA.logs, data);
}

// Pause any currently running timer (only one can run at a time)
function pauseRunning() {
  for (const t of timers.values()) {
    if (t.status === 'running') {
      clearInterval(t.interval);
      t.status   = 'paused';
      markPaused(t);
    }
  }
}

function makeTickFn(categoryId) {
  return function tick() {
    // Intervals inherit their creating request's async context. A later finish
    // belongs to the countdown, even when a shortcut originally started it.
    requestContext.exit(() => {
      const t = timers.get(categoryId);
      if (!t || t.status !== 'running') return;
      t.remainingSeconds = Math.max(0, t.remainingSeconds - 1);
      broadcast({ type: 'timer:tick', timer: safeTimerObj(t), timers: allSafeTimers() });
      if (t.remainingSeconds % 30 === 0 && t.remainingSeconds > 0) saveTimers();
      if (t.remainingSeconds === 0) finishTimerForCat(categoryId);
    });
  };
}

function getPomodoroSettings() {
  const s = read(DATA.settings);
  const p = s.pomodoro || {};
  return {
    workDuration:          p.workDuration          || 1500,
    shortBreakDuration:    p.shortBreakDuration    || 300,
    longBreakDuration:     p.longBreakDuration     || 900,
    cyclesBeforeLongBreak: p.cyclesBeforeLongBreak || 4,
    autoStartBreaks:       !!p.autoStartBreaks,
    autoStartFocus:        !!p.autoStartFocus,
  };
}

// Sets ps.phase to whatever follows the phase that just ended
function moveToNextPhase(ps, endedPhase, pSettings) {
  if (endedPhase === 'work') {
    ps.completedWorkSessions++;
    ps.phase = (ps.completedWorkSessions % pSettings.cyclesBeforeLongBreak === 0) ? 'long-break' : 'short-break';
  } else {
    ps.phase = 'work';
  }
}

function startPomodoroPhase(categoryId, phase, completedWorkSessions, pSettings, auto = false) {
  if (!pSettings) pSettings = getPomodoroSettings();
  const note = pomodoroStates.get(categoryId)?.note || '';
  const dur = { 'work': pSettings.workDuration, 'short-break': pSettings.shortBreakDuration, 'long-break': pSettings.longBreakDuration }[phase] || pSettings.workDuration;
  pauseRunning();
  const nt = {
    id: uuidv4(), categoryId,
    status: 'running',
    durationSeconds: dur, remainingSeconds: dur,
    startedAt: new Date().toISOString(), pausedAt: null,
    note, interval: null,
    pomodoroPhase: phase,
  };
  nt.interval = setInterval(makeTickFn(categoryId), 1000);
  timers.set(categoryId, nt);
  saveTimers();
  broadcast({ type: 'timer:started', timer: safeTimerObj(nt), timers: allSafeTimers() });
  broadcast({ type: 'timer:pomodoro-phase', categoryId, phase, completedWorkSessions, cyclesBeforeLongBreak: pSettings.cyclesBeforeLongBreak, duration: dur, note, auto });
}

function advancePomodoroPhase(categoryId, auto = false) {
  const ps = pomodoroStates.get(categoryId);
  if (!ps?.waitingForNext) return;
  ps.waitingForNext = false;
  const pSettings = getPomodoroSettings();
  startPomodoroPhase(categoryId, ps.phase, ps.completedWorkSessions, pSettings, auto);
}

function finishTimerForCat(categoryId) {
  const t = timers.get(categoryId);
  if (!t) return;
  clearInterval(t.interval);
  const pomodoroPhase = t.pomodoroPhase;
  let session = null;
  const skipped = skipReason(t, categoryId);
  if (!skipped) {
    session = buildSession(t, pomodoroStates.has(categoryId) ? 'pomodoro' : 'app');
    saveSession(session);
  }
  timers.delete(categoryId);
  logEvent('timer:finished', {
    category: catName(categoryId), phase: pomodoroPhase || 'timer',
    logged: session ? 'yes' : 'no', skipped: skipped || undefined,
    startedVia: startedVia.get(categoryId) || 'restored', windows: wss.clients.size,
  });
  startedVia.delete(categoryId);
  if (pomodoroPhase && pomodoroStates.has(categoryId)) {
    // Pomodoro: compute next phase but wait for user to press the button
    const ps = pomodoroStates.get(categoryId);
    const pSettings = getPomodoroSettings();
    moveToNextPhase(ps, pomodoroPhase, pSettings);
    ps.waitingForNext = true;
    saveTimers();
    broadcast({ type: 'timer:finished', session, timers: allSafeTimers() });
    const autoStart = ps.phase === 'work' ? pSettings.autoStartFocus : pSettings.autoStartBreaks;
    if (autoStart) {
      advancePomodoroPhase(categoryId, true);
    } else {
      broadcast({ type: 'timer:pomodoro-waiting', categoryId, nextPhase: ps.phase, completedWorkSessions: ps.completedWorkSessions, cyclesBeforeLongBreak: pSettings.cyclesBeforeLongBreak });
    }
  } else {
    if (categoryId !== '__none__') justFinished.add(categoryId);
    saveTimers();
    broadcast({ type: 'timer:finished', session, categoryId, skipped, timers: allSafeTimers() });
  }
}

// Stops the countdown and saves the time spent so far (breaks aren't logged)
function logStoppedTimer(t, categoryId, source) {
  clearInterval(t.interval);
  const skipped = skipReason(t, categoryId);
  if (skipped) return { session: null, skipped };
  const session = buildSession(t, pomodoroStates.has(categoryId) ? 'pomodoro' : source);
  saveSession(session);
  return { session, skipped: null };
}

function stopAndLogTimer(categoryId, source) {
  const t = timers.get(categoryId);
  if (!t) return null;
  const { session, skipped } = logStoppedTimer(t, categoryId, source);
  const wasPomodoro = pomodoroStates.has(categoryId);
  pomodoroStates.delete(categoryId);
  timers.delete(categoryId);
  saveTimers();
  broadcast({ type: 'timer:stopped', session, categoryId, skipped, timers: allSafeTimers() });
  if (wasPomodoro) broadcast({ type: 'timer:pomodoro-stopped', categoryId, timers: allSafeTimers() });
  return session;
}

// ── Restore timers on startup ─────────────────────────────────────────────────

if (fs.existsSync(DATA.timers)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA.timers, 'utf8'));
    if (Array.isArray(saved)) {
      saved.forEach(t => {
        // A timer that was running when the app closed counts as paused from that moment
        if (t.status === 'running') markPaused(t, t.savedAt || new Date().toISOString());
        t.status   = 'paused';  // always restore as paused
        t.interval = null;
        timers.set(t.categoryId, t);
      });
    }
  } catch (_) {}
}

// ── Restore stopwatch on startup ──────────────────────────────────────────────

if (fs.existsSync(DATA.stopwatch)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA.stopwatch, 'utf8'));
    if (saved && saved.status === 'paused' && saved.categoryId) {
      stopwatch = {
        status:        'paused',
        categoryId:    saved.categoryId,
        note:          saved.note || '',
        startedAt:     saved.startedAt || new Date().toISOString(),
        resumedAt:     null,
        accumulatedMs: saved.accumulatedMs || 0,
      };
    }
  } catch (_) {}
}

// Saves running time on quit or update; otherwise up to 30 seconds since the last save would be lost
process.on('exit', () => {
  logEvent('app:stopped');
  try {
    saveTimers();
    saveStopwatch();
  } catch (_) {}
});

// ── Timer API ─────────────────────────────────────────────────────────────────

// Returns all active timers + just-finished categories (used by Stream Deck plugin)
app.get('/api/timers', (req, res) => {
  const active   = safeRegularTimers();
  const finished = Array.from(justFinished).map(categoryId => ({
    categoryId,
    status: 'finished',
    remainingSeconds: 0,
  }));
  res.json([...active, ...finished]);
});

// Backward-compat: returns the running timer, or first paused, or idle
app.get('/api/timer/status', (req, res) => {
  const running = Array.from(timers.values()).find(t => t.status === 'running');
  const first   = running || Array.from(timers.values())[0];
  if (!first) return res.json({ status: 'idle', armed });
  res.json({ ...safeTimerObj(first), armed });
});

// Browser calls this when user changes category / duration / note on the Timer screen
app.post('/api/timer/arm', (req, res) => {
  const { categoryId, durationSeconds, note } = req.body;
  if (categoryId)      armed.categoryId      = categoryId;
  if (durationSeconds) armed.durationSeconds = durationSeconds;
  armed.note = note ?? armed.note;
  broadcast({ type: 'timer:armed', armed });
  res.json({ ok: true, armed });
});

// Toggle: single press = start/pause/resume for that category, double press = stop+log
function toggleResponse(res, action, extra = {}) {
  const accept = res.req.headers['accept'] || '';
  if (accept.includes('text/html')) {
    const icons  = { started: '▶', paused: '⏸', resumed: '▶', stopped: '⏹', dismissed: '✕', nothing: '—' };
    const colors = { started: '#22C55E', paused: '#F59E0B', resumed: '#22C55E', stopped: '#EF4444', dismissed: '#9090B0', nothing: '#9090B0' };
    const icon   = icons[action]  || '•';
    const color  = colors[action] || '#fff';
    const label  = action.charAt(0).toUpperCase() + action.slice(1);
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0C0D18;color:#fff;font-family:Inter,system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px}
.icon{font-size:48px;color:${color}} .label{font-size:18px;font-weight:600;color:${color}}
.sub{font-size:13px;color:#9090B0}</style></head>
<body><div class="icon">${icon}</div><div class="label">${label}</div>
<div class="sub">Closing...</div>
<script>setTimeout(()=>window.close(),800)</script></body></html>`);
  }
  res.json({ action, ...extra });
}

app.get('/api/timer/toggle', (req, res) => {
  const now        = Date.now();
  const categoryId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;

  if (!categoryId) return toggleResponse(res, 'nothing');

  // Timer just finished — first press dismisses instead of restarting
  if (justFinished.has(categoryId)) {
    justFinished.delete(categoryId);
    lastToggleMap.set(categoryId, now);
    broadcast({ type: 'timer:dismissed', categoryId, timers: allSafeTimers() });
    return toggleResponse(res, 'dismissed');
  }

  const lastMs    = lastToggleMap.get(categoryId) ?? 0;
  const isDouble  = (now - lastMs) < DOUBLE_TAP_MS;
  lastToggleMap.set(categoryId, now);

  // Double-tap → stop and log
  if (isDouble) {
    if (!timers.has(categoryId)) return toggleResponse(res, 'nothing');
    const session = stopAndLogTimer(categoryId, 'stream-deck');
    return toggleResponse(res, 'stopped', { session });
  }

  const t = timers.get(categoryId);

  // No timer for this category → start fresh
  if (!t) {
    const cats     = read(DATA.categories).categories;
    const cat      = cats.find(c => c.id === categoryId);
    const duration = (cat && cat.defaultDuration) ? cat.defaultDuration : 1800;
    pauseRunning();
    const nt = {
      id: uuidv4(), categoryId,
      status: 'running',
      durationSeconds: duration, remainingSeconds: duration,
      startedAt: new Date().toISOString(), pausedAt: null,
      note: armed.note || '', interval: null,
    };
    nt.interval = setInterval(makeTickFn(categoryId), 1000);
    timers.set(categoryId, nt);
    saveTimers();
    broadcast({ type: 'timer:started', timer: safeTimerObj(nt), timers: allSafeTimers() });
    return toggleResponse(res, 'started');
  }

  // Running → pause
  if (t.status === 'running') {
    clearInterval(t.interval);
    t.status   = 'paused';
    markPaused(t);
    saveTimers();
    broadcast({ type: 'timer:paused', timer: safeTimerObj(t), timers: allSafeTimers() });
    return toggleResponse(res, 'paused');
  }

  // Paused → resume (pause any other running timer first)
  if (t.status === 'paused') {
    pauseRunning();
    t.status   = 'running';
    markResumed(t);
    t.interval = setInterval(makeTickFn(categoryId), 1000);
    saveTimers();
    broadcast({ type: 'timer:started', timer: safeTimerObj(t), timers: allSafeTimers() });
    return toggleResponse(res, 'resumed');
  }

  res.json(safeTimerObj(t));
});

// Stream Deck direct URL start (GET form)
app.get('/api/timer/start', (req, res) => {
  const categoryId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  const duration   = parseInt(req.query.duration) || 1800;
  const existing   = timers.get(categoryId);

  if (existing && existing.status === 'paused') {
    pauseRunning();
    existing.status   = 'running';
    markResumed(existing);
    existing.interval = setInterval(makeTickFn(categoryId), 1000);
    saveTimers();
    broadcast({ type: 'timer:started', timer: safeTimerObj(existing), timers: allSafeTimers() });
    return res.json(safeTimerObj(existing));
  }

  if (existing && existing.status === 'running') {
    return res.json(safeTimerObj(existing));
  }

  pauseRunning();
  const nt = {
    id: uuidv4(), categoryId,
    status: 'running',
    durationSeconds: duration, remainingSeconds: duration,
    startedAt: new Date().toISOString(), pausedAt: null,
    note: '', interval: null,
  };
  nt.interval = setInterval(makeTickFn(categoryId), 1000);
  timers.set(categoryId, nt);
  saveTimers();
  broadcast({ type: 'timer:started', timer: safeTimerObj(nt), timers: allSafeTimers() });
  res.json(safeTimerObj(nt));
});

// Browser start/resume button (POST form)
app.post('/api/timer/start', (req, res) => {
  const { duration, categoryId, note } = req.body;
  const catId    = categoryId || armed.categoryId || read(DATA.settings).defaultCategory;
  const existing = timers.get(catId);

  // Category already has a timer → resume it
  if (existing) {
    if (existing.status === 'paused') {
      pauseRunning();
      existing.status   = 'running';
      markResumed(existing);
      existing.interval = setInterval(makeTickFn(catId), 1000);
      saveTimers();
      broadcast({ type: 'timer:started', timer: safeTimerObj(existing), timers: allSafeTimers() });
    }
    return res.json(safeTimerObj(existing));
  }

  // No timer for this category → start fresh
  pauseRunning();
  const dur = duration || armed.durationSeconds || 1800;

  // Persist chosen duration so Stream Dock uses the same value next time
  const catsData = read(DATA.categories);
  const catEntry = catsData.categories.find(c => c.id === catId);
  if (catEntry && catEntry.defaultDuration !== dur) {
    catEntry.defaultDuration = dur;
    write(DATA.categories, catsData);
  }

  const nt = {
    id: uuidv4(), categoryId: catId,
    status: 'running',
    durationSeconds: dur, remainingSeconds: dur,
    startedAt: new Date().toISOString(), pausedAt: null,
    note: note ?? armed.note ?? '', interval: null,
  };
  nt.interval = setInterval(makeTickFn(catId), 1000);
  timers.set(catId, nt);
  saveTimers();
  broadcast({ type: 'timer:started', timer: safeTimerObj(nt), timers: allSafeTimers() });
  res.json(safeTimerObj(nt));
});

app.get('/api/timer/pause', (req, res) => {
  const catId = req.query.category;
  let t;
  if (catId) {
    t = timers.get(catId);
  } else {
    t = Array.from(timers.values()).find(x => x.status === 'running');
  }
  if (!t || t.status !== 'running') return res.status(400).json({ error: 'No running timer' });
  clearInterval(t.interval);
  t.status   = 'paused';
  markPaused(t);
  saveTimers();
  broadcast({ type: 'timer:paused', timer: safeTimerObj(t), timers: allSafeTimers() });
  res.json(safeTimerObj(t));
});

app.get('/api/timer/stop', (req, res) => {
  const catId = req.query.category;
  if (catId) {
    if (!timers.has(catId)) return res.status(400).json({ error: 'No active timer for category' });
    const session = stopAndLogTimer(catId, 'app');
    return res.json({ status: 'idle', session, timers: allSafeTimers() });
  }
  const [firstCat] = timers.keys();
  if (!firstCat) return res.status(400).json({ error: 'No active timer' });
  const session = stopAndLogTimer(firstCat, 'app');
  res.json({ status: 'idle', session, timers: allSafeTimers() });
});

// ── Pomodoro API ──────────────────────────────────────────────────────────────

function pomodoroStartForCat(catId, note = '') {
  if (timers.has(catId)) stopAndLogTimer(catId, 'app');
  pomodoroStates.delete(catId);
  const ps = { phase: 'work', completedWorkSessions: 0, note };
  pomodoroStates.set(catId, ps);
  startPomodoroPhase(catId, 'work', 0);
}

app.post('/api/pomodoro/start', (req, res) => {
  const catId = req.body.categoryId || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId) return res.status(400).json({ error: 'No category' });
  pomodoroStartForCat(catId, req.body.note);
  res.json({ ok: true, phase: 'work', completedWorkSessions: 0 });
});

app.get('/api/pomodoro/start', (req, res) => {
  const catId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId) return toggleResponse(res, 'nothing');
  pomodoroStartForCat(catId);
  return toggleResponse(res, 'started', { phase: 'work' });
});

app.get('/api/pomodoro/skip', (req, res) => {
  const catId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId || !pomodoroStates.has(catId)) return res.status(400).json({ error: 'No active pomodoro' });
  const ps = pomodoroStates.get(catId);
  const t = timers.get(catId);
  // Skips the running phase, or the break that's waiting to start
  const skipped = t?.pomodoroPhase || ps.phase;
  let session = null;
  if (t) {
    const result = logStoppedTimer(t, catId, 'app');
    session = result.session;
    timers.delete(catId);
    saveTimers();
    broadcast({ type: 'timer:stopped', session, categoryId: catId, skipped: result.skipped, timers: allSafeTimers() });
  }
  moveToNextPhase(ps, skipped, getPomodoroSettings());
  ps.waitingForNext = true;
  advancePomodoroPhase(catId);
  res.json({ ok: true });
});

app.get('/api/pomodoro/stop', (req, res) => {
  const catId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId) return res.status(400).json({ error: 'No category' });
  if (timers.has(catId)) stopAndLogTimer(catId, 'app');
  pomodoroStates.delete(catId);
  broadcast({ type: 'timer:pomodoro-stopped', categoryId: catId, timers: allSafeTimers() });
  res.json({ ok: true });
});

app.get('/api/pomodoro/status', (req, res) => {
  const catId = req.query.category || armed.categoryId;
  if (!catId) return res.json({ active: false });
  const ps = pomodoroStates.get(catId);
  if (!ps) return res.json({ active: false });
  const t = timers.get(catId);
  res.json({ active: true, phase: ps.phase, completedWorkSessions: ps.completedWorkSessions, timer: t ? safeTimerObj(t) : null });
});

app.get('/api/pomodoro/next', (req, res) => {
  const catId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId) return res.status(400).json({ error: 'No category' });
  const ps = pomodoroStates.get(catId);
  if (!ps?.waitingForNext) return res.status(400).json({ error: 'Not waiting for next phase' });
  advancePomodoroPhase(catId);
  res.json({ ok: true });
});

app.get('/api/pomodoro/toggle', (req, res) => {
  const catId = req.query.category || armed.categoryId || read(DATA.settings).defaultCategory;
  if (!catId) return toggleResponse(res, 'nothing');
  const ps = pomodoroStates.get(catId);
  if (ps?.waitingForNext) {
    advancePomodoroPhase(catId);
    return toggleResponse(res, 'started', { phase: ps.phase });
  }
  if (pomodoroStates.has(catId)) {
    if (timers.has(catId)) stopAndLogTimer(catId, 'app');
    pomodoroStates.delete(catId);
    broadcast({ type: 'timer:pomodoro-stopped', categoryId: catId, timers: allSafeTimers() });
    return toggleResponse(res, 'stopped');
  }
  pomodoroStartForCat(catId);
  return toggleResponse(res, 'started', { phase: 'work' });
});

app.get('/api/pomodoro/statuses', (req, res) => {
  const settings = getPomodoroSettings();
  const sessions = [];
  for (const [catId, ps] of pomodoroStates) {
    const t = timers.get(catId);
    sessions.push({
      categoryId:            catId,
      phase:                 ps.phase,
      completedWorkSessions: ps.completedWorkSessions,
      cyclesBeforeLongBreak: settings.cyclesBeforeLongBreak,
      waitingForNext:        ps.waitingForNext || false,
      status:                t ? t.status : null,
      note:                  ps.note || '',
      remainingSeconds:      t ? t.remainingSeconds : 0,
      durationSeconds:       t ? t.durationSeconds  : 0,
    });
  }
  res.json({
    sessions,
    workDuration:          settings.workDuration,
    cyclesBeforeLongBreak: settings.cyclesBeforeLongBreak,
  });
});

// ── Categories API ────────────────────────────────────────────────────────────

app.get('/api/categories', (req, res) => {
  res.json(read(DATA.categories));
});

app.post('/api/categories', (req, res) => {
  const { name, color } = req.body;
  const data = read(DATA.categories);
  const category = {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    color: color || '#6366F1',
    targetValue: null,
    targetPeriod: null,
    lifetimeTarget: null,
    lifetimeDeadline: null,
    archived: false,
  };
  data.categories.push(category);
  write(DATA.categories, data);
  res.status(201).json(category);
});

app.put('/api/categories/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  const data = read(DATA.categories);
  const ordered = ids.map(id => data.categories.find(c => c.id === id)).filter(Boolean);
  const rest    = data.categories.filter(c => !ids.includes(c.id));
  data.categories = [...ordered, ...rest];
  write(DATA.categories, data);
  res.json({ ok: true });
});

app.put('/api/categories/:id', (req, res) => {
  const data = read(DATA.categories);
  const idx = data.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.categories[idx] = { ...data.categories[idx], ...req.body };
  write(DATA.categories, data);
  res.json(data.categories[idx]);
});

app.delete('/api/categories/:id', (req, res) => {
  const catId = req.params.id;

  // Remove category
  const catData = read(DATA.categories);
  catData.categories = catData.categories.filter(c => c.id !== catId);
  write(DATA.categories, catData);

  // Delete all sessions that belong to this category
  const logs = read(DATA.logs);
  logs.sessions = logs.sessions.filter(s => s.categoryId !== catId);
  write(DATA.logs, logs);

  // Stop and remove any active timer for this category
  if (timers.has(catId)) {
    const t = timers.get(catId);
    clearInterval(t.interval);
    timers.delete(catId);
    saveTimers();
    broadcast({ type: 'timer:stopped', session: null, timers: allSafeTimers() });
  }
  justFinished.delete(catId);

  res.json({ ok: true });
});

// ── Notes API ─────────────────────────────────────────────────────────────────

app.get('/api/notes', (req, res) => {
  res.json(read(DATA.notes));
});

app.post('/api/notes', (req, res) => {
  const { title, body, color, tags } = req.body;
  const data = read(DATA.notes);
  const now = new Date().toISOString();
  const note = {
    id: uuidv4(),
    title: title || 'Untitled',
    body: body || '',
    color: color || '#6366F1',
    tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()) : [],
    createdAt: now,
    updatedAt: now,
  };
  data.notes.push(note);
  write(DATA.notes, data);
  res.status(201).json(note);
});

app.put('/api/notes/:id', (req, res) => {
  const data = read(DATA.notes);
  const idx = data.notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.notes[idx] = { ...data.notes[idx], ...req.body, updatedAt: new Date().toISOString() };
  write(DATA.notes, data);
  res.json(data.notes[idx]);
});

app.delete('/api/notes/:id', (req, res) => {
  const data = read(DATA.notes);
  data.notes = data.notes.filter(n => n.id !== req.params.id);
  write(DATA.notes, data);
  res.json({ ok: true });
});

// ── Trackers API ("things that last") ─────────────────────────────────────────
// One model for three kinds. A cycle is one bag / one trial / one "did it":
//   countdown: cycles have a planned end date; "renew" adds the next one
//   runout:    the open cycle has end null; "new" closes it today and opens another
//   since:     each "done" closes the previous cycle today and starts a new one
const TRACKER_KINDS = ['countdown', 'runout', 'since'];

function readTrackers() {
  try { return read(DATA.trackers); } catch { return { trackers: [] }; }
}

// Dates are local calendar days (YYYY-MM-DD); the server runs on the user's own PC
function localToday() { return new Date().toLocaleDateString('sv'); }
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv');
}
function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const numOrNull = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);

function trackerId(name, existing) {
  const base = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tracker';
  let id = base, n = 2;
  while (existing.some(t => t.id === id)) id = `${base}-${n++}`;
  return id;
}

app.get('/api/trackers', (req, res) => {
  res.json(readTrackers());
});

app.post('/api/trackers', (req, res) => {
  const { name, kind, icon, color, intervalDays, remindDaysBefore, start, end, cost } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!TRACKER_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown kind' });
  const startDate = isDate(start) ? start : localToday();
  if (kind === 'countdown' && (!isDate(end) || end < startDate)) {
    return res.status(400).json({ error: 'A countdown needs an end date on or after its start' });
  }

  const data = readTrackers();
  const tracker = {
    id: trackerId(name, data.trackers),
    name: String(name).trim(),
    kind,
    icon: icon || 'hourglass',
    color: color || '#06B6D4',
    intervalDays: numOrNull(intervalDays),
    remindDaysBefore: numOrNull(remindDaysBefore),
    archived: false,
    createdAt: new Date().toISOString(),
    cycles: [{ id: uuidv4(), start: startDate, end: kind === 'countdown' ? end : null, cost: numOrNull(cost) }],
  };
  data.trackers.push(tracker);
  write(DATA.trackers, data);
  broadcast({ type: 'trackers:updated' });
  res.status(201).json(tracker);
});

// Edits a tracker. `cycles` may be sent whole (edit / delete one cycle from the history).
app.put('/api/trackers/:id', (req, res) => {
  const data = readTrackers();
  const t = data.trackers.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  if (b.name !== undefined && String(b.name).trim()) t.name = String(b.name).trim();
  if (b.icon !== undefined) t.icon = b.icon;
  if (b.color !== undefined) t.color = b.color;
  if (b.intervalDays !== undefined) t.intervalDays = numOrNull(b.intervalDays);
  if (b.remindDaysBefore !== undefined) t.remindDaysBefore = numOrNull(b.remindDaysBefore);
  if (b.archived !== undefined) t.archived = !!b.archived;
  if (Array.isArray(b.cycles)) {
    t.cycles = b.cycles
      .filter(c => isDate(c.start))
      .map(c => ({ id: c.id || uuidv4(), start: c.start, end: isDate(c.end) ? c.end : null, cost: numOrNull(c.cost), ...(c.note ? { note: String(c.note) } : {}) }))
      .sort((a, b2) => a.start.localeCompare(b2.start));
  }
  write(DATA.trackers, data);
  broadcast({ type: 'trackers:updated' });
  res.json(t);
});

app.delete('/api/trackers/:id', (req, res) => {
  const data = readTrackers();
  data.trackers = data.trackers.filter(t => t.id !== req.params.id);
  write(DATA.trackers, data);
  broadcast({ type: 'trackers:updated' });
  res.json({ ok: true });
});

// The one-click actions. GET works too, so a Stream Deck URL button can press them:
//   /api/trackers/cat-food/act?action=new     /api/trackers/plants/act?action=done
function trackerAction(req, res) {
  const action = req.body?.action || req.query.action;
  const date = isDate(req.body?.date) ? req.body.date : (isDate(req.query.date) ? req.query.date : localToday());
  const cost = numOrNull(req.body?.cost ?? req.query.cost);

  const data = readTrackers();
  const t = data.trackers.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const last = t.cycles[t.cycles.length - 1] || null;

  if (t.kind === 'countdown' && action === 'renew') {
    // Renewed early: the next period starts when this one ends. Renewed late: it starts today.
    const length = t.intervalDays || (last ? Math.max(1, daysBetween(last.start, last.end)) : 30);
    const start = last && last.end > date ? last.end : date;
    t.cycles.push({ id: uuidv4(), start, end: addDays(start, length), cost: cost ?? last?.cost ?? null });
    t.archived = false;
  } else if (t.kind === 'countdown' && action === 'end') {
    // Ended or cancelled: drop a renewal that hasn't started yet and archive it.
    // The end date stays as it was (a cancelled trial usually runs to its end anyway).
    while (t.cycles.length > 1 && t.cycles[t.cycles.length - 1].start > date) t.cycles.pop();
    t.archived = true;
  } else if (t.kind === 'runout' && (action === 'new' || action === 'finish')) {
    if (last && !last.end) last.end = date;
    if (action === 'new') t.cycles.push({ id: uuidv4(), start: date, end: null, cost: cost ?? last?.cost ?? null });
  } else if (t.kind === 'since' && action === 'done') {
    if (last && last.start === date) return res.json(t);   // already done today
    if (last && !last.end) last.end = date;
    t.cycles.push({ id: uuidv4(), start: date, end: null, cost });
  } else {
    return res.status(400).json({ error: `"${action}" doesn't apply to a ${t.kind} tracker` });
  }

  write(DATA.trackers, data);
  broadcast({ type: 'trackers:updated' });
  res.json(t);
}
app.post('/api/trackers/:id/act', trackerAction);
app.get('/api/trackers/:id/act', trackerAction);

// Saves the user's chosen preset duration so Stream Dock uses the same value
app.post('/api/categories/:id/default-duration', (req, res) => {
  const dur  = parseInt(req.body.duration);
  if (!dur || dur < 60) return res.status(400).json({ error: 'invalid duration' });
  const data = read(DATA.categories);
  const cat  = data.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'not found' });
  cat.defaultDuration = dur;
  write(DATA.categories, data);
  res.json({ ok: true });
});

app.post('/api/categories/:id/sound', (req, res) => {
  const { name, data: fileData } = req.body;
  if (!name || !fileData) return res.status(400).json({ error: 'name and data required' });
  const ext = path.extname(name).toLowerCase();
  if (!['.wav', '.mp3', '.ogg', '.m4a', '.flac'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported audio format' });
  }
  const soundsDir = SOUNDS_DIR;
  if (!fs.existsSync(soundsDir)) fs.mkdirSync(soundsDir, { recursive: true });
  const filename = `cat-${req.params.id}${ext}`;
  fs.writeFileSync(path.join(soundsDir, filename), Buffer.from(fileData, 'base64'));
  const catData = read(DATA.categories);
  const idx = catData.categories.findIndex(c => c.id === req.params.id);
  if (idx !== -1) {
    catData.categories[idx].soundPath = `/sounds/${filename}`;
    catData.categories[idx].soundName = name;
    write(DATA.categories, catData);
  }
  res.json({ soundPath: `/sounds/${filename}`, soundName: name });
});

app.delete('/api/categories/:id/sound', (req, res) => {
  const catData = read(DATA.categories);
  const idx = catData.categories.findIndex(c => c.id === req.params.id);
  if (idx !== -1) {
    delete catData.categories[idx].soundPath;
    delete catData.categories[idx].soundName;
    write(DATA.categories, catData);
  }
  res.json({ ok: true });
});

// ── Logs API ──────────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const data = read(DATA.logs);
  let sessions = data.sessions;
  if (req.query.category) sessions = sessions.filter(s => s.categoryId === req.query.category);
  if (req.query.from)     sessions = sessions.filter(s => s.startTime >= req.query.from);
  if (req.query.to)       sessions = sessions.filter(s => s.startTime <= req.query.to);
  res.json({ sessions });
});

app.post('/api/logs', (req, res) => {
  const data = read(DATA.logs);
  const session = { id: uuidv4(), ...req.body };
  data.sessions.push(session);
  write(DATA.logs, data);
  res.status(201).json(session);
});

app.put('/api/logs/:id', (req, res) => {
  const data = read(DATA.logs);
  const idx = data.sessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.sessions[idx] = { ...data.sessions[idx], ...req.body };
  write(DATA.logs, data);
  res.json(data.sessions[idx]);
});

app.delete('/api/logs/:id', (req, res) => {
  const data = read(DATA.logs);
  data.sessions = data.sessions.filter(s => s.id !== req.params.id);
  write(DATA.logs, data);
  res.json({ ok: true });
});

// ── Settings API ──────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(read(DATA.settings));
});

app.put('/api/settings', (req, res) => {
  const current = read(DATA.settings);
  const updated = { ...current, ...req.body };
  write(DATA.settings, updated);
  res.json(updated);
});

const DEFAULT_SOUND = { alertSound: 'chime.wav', alertSoundName: 'Default' };

app.post('/api/settings/sound', (req, res) => {
  const { name, data } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  const ext = path.extname(name).toLowerCase();
  if (!['.wav', '.mp3', '.ogg', '.m4a', '.flac'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported audio format' });
  }
  const soundsDir = SOUNDS_DIR;
  if (!fs.existsSync(soundsDir)) fs.mkdirSync(soundsDir, { recursive: true });
  const filename = `alert${ext}`;
  fs.writeFileSync(path.join(soundsDir, filename), Buffer.from(data, 'base64'));
  const settings = read(DATA.settings);
  settings.alertSound     = filename;
  settings.alertSoundName = name;
  write(DATA.settings, settings);
  res.json({ alertSound: filename, alertSoundName: name });
});

app.delete('/api/settings/sound', (req, res) => {
  const settings = read(DATA.settings);
  settings.alertSound     = DEFAULT_SOUND.alertSound;
  settings.alertSoundName = DEFAULT_SOUND.alertSoundName;
  write(DATA.settings, settings);
  res.json({ alertSound: DEFAULT_SOUND.alertSound, alertSoundName: DEFAULT_SOUND.alertSoundName });
});

// ── Stopwatch API ─────────────────────────────────────────────────────────────

app.get('/api/stopwatch/status', (req, res) => {
  res.json(safeStopwatch());
});

app.post('/api/stopwatch/arm', (req, res) => {
  if (stopwatch.status === 'idle') {
    const { categoryId, note } = req.body;
    if (categoryId) stopwatch.categoryId = categoryId;
    if (note !== undefined) stopwatch.note = note;
  }
  res.json({ ok: true });
});

app.get('/api/stopwatch/toggle', (req, res) => {
  const now    = Date.now();
  const isDbl  = (now - lastSwToggleMs) < 600;
  lastSwToggleMs = now;

  if (isDbl) {
    if (stopwatch.status === 'idle') return toggleResponse(res, 'nothing');
    const session = stopAndLogStopwatch('stream-deck');
    return toggleResponse(res, 'stopped', { session });
  }

  if (stopwatch.status === 'idle') {
    const categoryId = req.query.category || stopwatch.categoryId || read(DATA.settings).defaultCategory;
    if (!categoryId) return res.status(400).json({ error: 'No category selected' });
    stopwatch.status      = 'running';
    stopwatch.categoryId  = categoryId;
    stopwatch.startedAt   = new Date().toISOString();
    stopwatch.resumedAt   = Date.now();
    stopwatch.accumulatedMs = 0;
    startSwTick();
    broadcast({ type: 'stopwatch:started', stopwatch: safeStopwatch() });
    return toggleResponse(res, 'started');
  }

  if (stopwatch.status === 'running') {
    stopwatch.accumulatedMs += Date.now() - stopwatch.resumedAt;
    stopwatch.resumedAt = null;
    stopwatch.status    = 'paused';
    clearInterval(swTickInterval);
    swTickInterval = null;
    broadcast({ type: 'stopwatch:paused', stopwatch: safeStopwatch() });
    return toggleResponse(res, 'paused');
  }

  if (stopwatch.status === 'paused') {
    stopwatch.resumedAt = Date.now();
    stopwatch.status    = 'running';
    startSwTick();
    broadcast({ type: 'stopwatch:started', stopwatch: safeStopwatch() });
    return toggleResponse(res, 'resumed');
  }
});

app.get('/api/stopwatch/pause', (req, res) => {
  if (stopwatch.status !== 'running') return res.status(400).json({ error: 'Not running' });
  stopwatch.accumulatedMs += Date.now() - stopwatch.resumedAt;
  stopwatch.resumedAt = null;
  stopwatch.status    = 'paused';
  clearInterval(swTickInterval);
  swTickInterval = null;
  broadcast({ type: 'stopwatch:paused', stopwatch: safeStopwatch() });
  res.json(safeStopwatch());
});

app.get('/api/stopwatch/stop', (req, res) => {
  if (stopwatch.status === 'idle') return res.status(400).json({ error: 'No active stopwatch' });
  const session = stopAndLogStopwatch('app');
  res.json({ status: 'idle', session });
});

// ── Analytics API ─────────────────────────────────────────────────────────────

app.get('/api/analytics/summary', (req, res) => {
  const { sessions }   = read(DATA.logs);
  const { categories } = read(DATA.categories);
  const today = new Date().toLocaleDateString('sv');

  const todaySeconds = sessions
    .filter(s => new Date(s.startTime).toLocaleDateString('sv') === today)
    .reduce((sum, s) => sum + s.durationSeconds, 0);

  const byCategory = {};
  categories.forEach(c => { byCategory[c.id] = 0; });
  sessions.forEach(s => {
    if (byCategory[s.categoryId] !== undefined) byCategory[s.categoryId] += s.durationSeconds;
  });

  res.json({ todaySeconds, byCategory });
});

// ── Icons API (for Stream Dock plugin) ───────────────────────────────────────

app.get('/api/icons/:categoryId', (req, res) => {
  const id      = req.params.categoryId;
  const iconDir = path.join(__dirname, 'stream-deck', 'icons');
  const candidates = [
    `${id}.png`,
    `${id.split('-')[0]}.png`,
    `${id.replace(/-/g, '_')}.png`,
  ];
  for (const filename of candidates) {
    const fullPath = path.join(iconDir, filename);
    if (fs.existsSync(fullPath)) return res.sendFile(fullPath);
  }
  res.status(404).json({ error: 'Icon not found' });
});

// ── CSV Export ────────────────────────────────────────────────────────────────

app.get('/api/logs/export', (req, res) => {
  const { sessions }   = read(DATA.logs);
  const { categories } = read(DATA.categories);

  const catMap = {};
  categories.forEach(c => { catMap[c.id] = c.name; });

  const escape = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = 'Date,Start Time,End Time,Duration (min),Category,Note';
  const rows   = sessions.map(s => [
    new Date(s.startTime).toLocaleDateString('sv'),
    new Date(s.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    s.endTime ? new Date(s.endTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '',
    Math.round(s.durationSeconds / 60),
    escape(catMap[s.categoryId] || s.categoryId),
    escape(s.note || ''),
  ].join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="time-tracker-export.csv"');
  res.send([header, ...rows].join('\n'));
});

// Diagnostics accept only metadata: never serialize request bodies or notes.
app.post('/api/diag/sound', (req, res) => {
  const { action, trigger, reason, mode, win, visible } = req.body || {};
  const allowed = {
    action: ['play', 'stop'],
    trigger: ['unknown', 'timer-finished', 'pomodoro-waiting', 'pomodoro-auto'],
    reason: ['unknown', 'ended', 'duration-limit', 'replaced', 'stop-button', 'ws-dismissed', 'ws-pomodoro-stopped', 'ws-started', 'ws-stopped', 'ws-pomodoro-phase', 'timer-toggle', 'timer-stop', 'pomodoro-next', 'pomodoro-skip', 'today-control'],
    mode: ['loop', 'once', 'duration', 'once-auto'],
    visible: ['visible', 'hidden', 'prerender'],
  };
  if (!allowed.action.includes(action)) return res.status(400).json({ error: 'Unknown sound action' });
  logEvent(`sound:${action}`, {
    trigger: allowed.trigger.includes(trigger) ? trigger : undefined,
    reason: allowed.reason.includes(reason) ? reason : undefined,
    mode: allowed.mode.includes(mode) ? mode : undefined,
    win: typeof win === 'string' && /^[a-z0-9]{4,12}$/i.test(win) ? win : undefined,
    kind: (req.headers['user-agent'] || '').includes('Electron') ? 'app-window' : 'browser',
    visible: allowed.visible.includes(visible) ? visible : undefined,
  });
  res.json({ ok: true });
});

app.get('/api/diag/note', (req, res) => {
  if (!['pc:sleep', 'pc:resume'].includes(req.query.event)) return res.status(400).json({ error: 'Unknown diagnostic event' });
  logEvent(req.query.event);
  res.json({ ok: true });
});

// ── App info ──────────────────────────────────────────────────────────────────

app.get('/api/app/version', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({ version: pkg.version });
  } catch {
    res.json({ version: '1.0.0' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  let version = '?';
  let alertMode;
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (_) {}
  try { alertMode = read(DATA.settings).alertSoundMode || 'loop'; } catch (_) {}
  logEvent('app:started', { version, port: server.address().port, restoredTimers: timers.size, alertMode });
  console.log(`Time Tracker Pro running at http://localhost:${PORT}`);
});
