'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

const APP  = 'http://localhost:3000';
const SIZE = 72;
const DEFAULT_TIMER_FONT = 16;

// ── State ─────────────────────────────────────────────────────────────────────

const contexts = {};  // contextId → { action, settings }

let ws;
let timersList   = [];   // array of active timer objects from /api/timers
let swStatus     = null;
let pomoStatuses = [];   // active pomodoro sessions from /api/pomodoro/statuses
let pomoSettings = { workDuration: 1500, cyclesBeforeLongBreak: 4 };
let online       = false;
let flashTick    = 0;    // increments every poll; drives finished-button flash

// ── Entry point (called by Stream Dock) ───────────────────────────────────────

function connectElgatoStreamDeckSocket(port, pluginUUID, registerEvent) {
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.onopen = () => {
    send({ event: registerEvent, uuid: pluginUUID });
    startPolling();
  };

  ws.onmessage = (evt) => { try { dispatch(JSON.parse(evt.data)); } catch (_) {} };

  ws.onclose = () =>
    setTimeout(() => connectElgatoStreamDeckSocket(port, pluginUUID, registerEvent), 3000);
}

// ── Event dispatch ────────────────────────────────────────────────────────────

function dispatch({ event, context, action, payload }) {
  switch (event) {
    case 'willAppear':
      contexts[context] = { action, settings: payload?.settings ?? {} };
      renderAndSend(context);
      break;

    case 'willDisappear':
      delete contexts[context];
      break;

    case 'didReceiveSettings':
      if (!contexts[context]) break;
      contexts[context].settings = payload?.settings ?? {};
      renderAndSend(context);
      break;

    case 'keyDown':
      onKeyDown(context, action);
      break;
  }
}

// ── Key press ─────────────────────────────────────────────────────────────────

async function onKeyDown(context, action) {
  if (!online) { flashAlert(context); return; }

  const { categoryId } = contexts[context]?.settings ?? {};
  const cat = categoryId ? `?category=${encodeURIComponent(categoryId)}` : '';

  let url;
  if (action === 'com.timetracker.pro.stopwatch') {
    url = `${APP}/api/stopwatch/toggle${cat}`;
  } else if (action === 'com.timetracker.pro.pomodoro') {
    url = `${APP}/api/pomodoro/toggle${cat}`;
  } else {
    url = `${APP}/api/timer/toggle${cat}`;
  }

  try {
    await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (_) {
    flashAlert(context);
    return;
  }

  await pollOnce();
  renderAllButtons();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAndSend(context) {
  const ctx = contexts[context];
  if (!ctx) return;

  const { action, settings } = ctx;
  const { categoryId, timerFontSize } = settings;
  const tfs = timerFontSize ?? DEFAULT_TIMER_FONT;

  // ── Pomodoro ──
  if (action === 'com.timetracker.pro.pomodoro') {
    const ps = online && pomoStatuses.find(p => p.categoryId === categoryId);
    if (!ps) {
      setImage(context, drawPomodoroIdle({ ...pomoSettings, timerFontSize: tfs }));
      return;
    }
    setImage(context, drawPomodoroActive({ ...ps, timerFontSize: tfs }));
    return;
  }

  // ── Stopwatch ──
  if (action === 'com.timetracker.pro.stopwatch') {
    const active = online && swStatus && swStatus.status !== 'idle' && swStatus.categoryId === categoryId;
    if (!active) { setImage(context, ''); return; }
    const state = { type: swStatus.status, time: fmtTime(swStatus.elapsedSeconds) };
    setImage(context, drawActiveButton({ state, timerFontSize: tfs }));
    return;
  }

  // ── Timer (countdown) ──
  const timerForCat = online && timersList.find(t => t.categoryId === categoryId);
  if (!timerForCat) { setImage(context, ''); return; }

  if (timerForCat.status === 'finished') {
    setImage(context, drawFinishedButton());
    return;
  }

  const secs  = timerForCat.remainingSeconds;
  const state = { type: timerForCat.status, time: fmtTime(secs) };
  setImage(context, drawActiveButton({ state, timerFontSize: tfs }));
}

function renderAllButtons() {
  Object.keys(contexts).forEach(ctx => renderAndSend(ctx));
}

// ── drawFinishedButton — flashes crimson ↔ dark every poll tick ───────────────

function drawFinishedButton() {
  const cv  = document.createElement('canvas');
  cv.width  = SIZE;
  cv.height = SIZE;
  const ctx = cv.getContext('2d');

  const bright = flashTick % 2 === 0;

  ctx.fillStyle = bright ? '#E63950' : '#0C0D18';
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = bright ? '#FFFFFF' : '#E63950';
  ctx.font      = 'bold 18px system-ui, sans-serif';
  ctx.fillText('DONE', SIZE / 2, SIZE / 2);

  return cv.toDataURL('image/png');
}

// ── drawActiveButton — running/paused, countdown only ────────────────────────

function drawActiveButton({ state, timerFontSize }) {
  const cv  = document.createElement('canvas');
  cv.width  = SIZE;
  cv.height = SIZE;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#0C0D18';
  ctx.fillRect(0, 0, SIZE, SIZE);

  if (state.type === 'running') {
    ctx.fillStyle    = '#FFFFFF';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = `bold ${timerFontSize}px system-ui, sans-serif`;
    ctx.fillText(state.time, SIZE / 2, SIZE / 2, SIZE - 4);

  } else if (state.type === 'paused') {
    const labelSize = Math.max(9, Math.round(timerFontSize * 0.58));
    const gap       = Math.round(timerFontSize * 0.55);
    const midY      = SIZE / 2;

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#F59E0B';
    ctx.font      = `bold ${labelSize}px system-ui, sans-serif`;
    ctx.fillText('PAUSED', SIZE / 2, midY - gap, SIZE - 4);

    ctx.fillStyle = '#FFFFFF';
    ctx.font      = `bold ${timerFontSize}px system-ui, sans-serif`;
    ctx.fillText(state.time, SIZE / 2, midY + labelSize * 0.6, SIZE - 4);
  }

  return cv.toDataURL('image/png');
}

// ── drawPomodoroIdle — shows first work session ready to start ───────────────

function drawPomodoroIdle({ workDuration, cyclesBeforeLongBreak, timerFontSize }) {
  return drawPomodoroActive({
    phase:                 'work',
    completedWorkSessions: 0,
    cyclesBeforeLongBreak: cyclesBeforeLongBreak || 4,
    remainingSeconds:      workDuration || 1500,
    timerFontSize,
    dim: true,
  });
}

// ── drawPomodoroActive — work / short-break / long-break ─────────────────────

function drawPomodoroActive({ phase, completedWorkSessions, cyclesBeforeLongBreak, remainingSeconds, timerFontSize, dim = false }) {
  const cv  = document.createElement('canvas');
  cv.width  = SIZE;
  cv.height = SIZE;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#0C0D18';
  ctx.fillRect(0, 0, SIZE, SIZE);

  if (dim) ctx.globalAlpha = 0.70;

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  const tfs       = timerFontSize ?? DEFAULT_TIMER_FONT;
  const labelSize = Math.max(9, Math.round(tfs * 0.58));
  const cycles    = Math.max(1, cyclesBeforeLongBreak || 4);
  const timeStr   = fmtTime(remainingSeconds);

  const CRIMSON = '#E63950';
  const GREEN   = '#22C55E';
  const PURPLE  = '#7B4FCA';

  if (phase === 'work') {
    // Cycle dots across top
    const dotR    = cycles <= 4 ? 4   : cycles <= 6 ? 3.5 : 2.5;
    const gap     = cycles <= 4 ? 13  : cycles <= 6 ? 11  : 8;
    const totalW  = (cycles - 1) * gap;
    const startX  = SIZE / 2 - totalW / 2;
    const filled  = completedWorkSessions % cycles;

    for (let i = 0; i < cycles; i++) {
      const x = startX + i * gap;
      ctx.beginPath();
      ctx.arc(x, 9, dotR, 0, Math.PI * 2);
      if (i < filled) {
        ctx.fillStyle = CRIMSON;
        ctx.fill();
      } else {
        ctx.fillStyle = '#1D1E30';
        ctx.fill();
        ctx.strokeStyle = '#3A3B55';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // "WORK N/M" label
    ctx.fillStyle = CRIMSON;
    ctx.font      = `bold ${labelSize}px system-ui, sans-serif`;
    ctx.fillText(`WORK ${completedWorkSessions + 1}/${cycles}`, SIZE / 2, 24, SIZE - 4);

    // Countdown time
    ctx.fillStyle = '#FFFFFF';
    ctx.font      = `bold ${tfs}px system-ui, sans-serif`;
    ctx.fillText(timeStr, SIZE / 2, 44, SIZE - 4);

  } else {
    const isLong = phase === 'long-break';
    const color  = isLong ? PURPLE : GREEN;
    const label  = isLong ? 'LONG BRK' : 'SHORT BRK';

    ctx.fillStyle = color;
    ctx.font      = `bold ${labelSize}px system-ui, sans-serif`;
    ctx.fillText(label, SIZE / 2, 20, SIZE - 4);

    ctx.fillStyle = color;
    ctx.font      = `bold ${tfs}px system-ui, sans-serif`;
    ctx.fillText(timeStr, SIZE / 2, 44, SIZE - 4);
  }

  return cv.toDataURL('image/png');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(secs) {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = secs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setImage(context, image) {
  send({ event: 'setImage', context, payload: { image, target: 0 } });
  send({ event: 'setTitle', context, payload: { title: '', target: 0 } });
}

function flashAlert(context) {
  send({ event: 'showAlert', context });
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollOnce() {
  try {
    const [tList, sw, pomo] = await Promise.all([
      fetch(`${APP}/api/timers`,             { signal: AbortSignal.timeout(1500) }).then(r => r.json()),
      fetch(`${APP}/api/stopwatch/status`,   { signal: AbortSignal.timeout(1500) }).then(r => r.json()),
      fetch(`${APP}/api/pomodoro/statuses`,  { signal: AbortSignal.timeout(1500) }).then(r => r.json()),
    ]);
    timersList   = Array.isArray(tList) ? tList : [];
    swStatus     = sw;
    pomoStatuses = Array.isArray(pomo?.sessions) ? pomo.sessions : [];
    if (pomo?.workDuration) pomoSettings = { workDuration: pomo.workDuration, cyclesBeforeLongBreak: pomo.cyclesBeforeLongBreak };
    online       = true;
  } catch (_) {
    online       = false;
    timersList   = [];
    swStatus     = null;
    pomoStatuses = [];
  }
}

function startPolling() {
  pollOnce().then(() => renderAllButtons());

  setInterval(async () => {
    await pollOnce();
    flashTick++;
    renderAllButtons();
  }, 1000);
}
