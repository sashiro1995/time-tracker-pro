// Run with: node --test scripts/diagnostics.test.js
// Uses a disposable data folder and an OS-assigned port; never touches personal data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(30);
  }
  assert.fail('Timed out waiting for diagnostic event');
}

test('server records causes without changing timer/session behavior', async t => {
  const tempRoot = path.join(root, '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'diagnostics-'));
  fs.cpSync(path.join(root, 'defaults'), dir, { recursive: true });
  const save = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  save('categories.json', { categories: [{ id: 'test', name: 'Test category' }] });
  save('timers.json', [{ id: 'restored', categoryId: 'test', durationSeconds: 60,
    remainingSeconds: 1, status: 'paused', startedAt: new Date(Date.now() - 59000).toISOString(),
    note: 'PRIVATE_NOTE', pauses: [] }]);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  settings.alertSoundMode = 'loop';
  settings.pomodoro = { workDuration: 1, shortBreakDuration: 1, longBreakDuration: 1,
    cyclesBeforeLongBreak: 2, autoStartBreaks: false, autoStartFocus: false };
  save('settings.json', settings);
  const child = spawn(process.execPath, ['-e',
    "require('./server'); process.on('message', msg => { if (msg === 'quit') process.exit(0); });"],
  { cwd: root, env: { ...process.env, PORT: '0', DATA_DIR: dir, SOUNDS_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const logFile = path.join(dir, 'events.log');
  const oldFile = path.join(dir, 'events.old.log');
  const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (child.exitCode === null) {
      const ended = once(child, 'exit');
      child.send('quit');
      await ended;
    }
    // dir was created directly under this workspace's .tmp by mkdtempSync.
    assert.equal(path.dirname(dir), tempRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const startup = await until(() => log().match(/app:started.*port=(\d+)/));
  const port = Number(startup[1]);
  assert.match(log(), /restoredTimers=1.*alertMode=loop/);
  async function request(route, body, ua = 'Mozilla/5.0 Electron/42') {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = { ...(ua ? { 'User-Agent': ua } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
      const req = http.request({ hostname: '127.0.0.1', port, path: route,
        method: data ? 'POST' : 'GET', headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  for (const [win, ua] of [['app00001', 'Mozilla/5.0 Electron/42'], ['web00001', 'Mozilla/5.0']]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?win=${win}`, { headers: { 'User-Agent': ua } });
    sockets.push(ws);
    await once(ws, 'open');
  }
  assert.match(log(), /window:connected.*win=web00001.*kind=browser.*windows=2/);
  assert.equal((await request('/api/timer/start', { categoryId: 'test' })).status, 200);
  await until(() => /timer:finished.*phase=timer.*logged=yes.*startedVia=app-window.*windows=2/.test(log()));
  assert.equal((await request('/api/logs')).body.sessions.length, 1);
  assert.equal((await request('/api/logs')).body.sessions[0].note, 'PRIVATE_NOTE');
  for (const [win, visible, ua] of [['app00001', 'visible', 'Mozilla Electron'], ['web00001', 'hidden', 'Mozilla']]) {
    await request('/api/diag/sound', { action: 'play', trigger: 'timer-finished', mode: 'loop', win, visible }, ua);
  }
  await request('/api/diag/sound', { action: 'stop', reason: 'stop-button', win: 'app00001' });
  assert.match(log(), /sound:play.*win=web00001.*kind=browser.*visible=hidden/);
  assert.match(log(), /sound:stop.*reason=stop-button.*win=app00001/);
  await request('/api/timer/start?src=shortcut&note=PRIVATE_QUERY', { categoryId: 'test', duration: 1 }, null);
  await until(() => /timer:finished.*startedVia=shortcut/.test(log()));
  assert.match(log(), /timer:started.*via=shortcut.*route=POST_\/api\/timer\/start\?src=shortcut/);
  await request('/api/pomodoro/start', { categoryId: 'test' }, 'Mozilla/5.0');
  await until(() => /timer:pomodoro-waiting.*via=countdown/.test(log()));
  await request('/api/pomodoro/next?category=test&src=streamdock', undefined, null);
  await until(() => /timer:finished.*phase=short-break.*logged=no.*skipped=nothing.*startedVia=streamdock/.test(log()));
  await request('/api/pomodoro/next?category=test', undefined, null);
  await until(() => /timer:pomodoro-waiting.*phase=long-break/.test(log()));
  await request('/api/pomodoro/next?category=test', undefined, null);
  await until(() => /timer:finished.*phase=long-break.*logged=no.*startedVia=electron-main/.test(log()));
  await request('/api/pomodoro/stop?category=test');
  settings.pomodoro.autoStartBreaks = true;
  save('settings.json', settings);
  await request('/api/pomodoro/start', { categoryId: 'test' });
  await until(() => /timer:pomodoro-phase.*phase=short-break.*auto=yes.*via=countdown/.test(log()));
  await request('/api/pomodoro/stop?category=test');
  await request('/api/diag/note?event=pc:sleep');
  await request('/api/diag/note?event=pc:resume');
  assert.match(log(), /pc:resume/);
  assert.doesNotMatch(log(), /PRIVATE_|timer:tick|stopwatch:tick/);
  assert.equal((await request('/api/diag/note?event=PRIVATE_EVENT')).status, 400);
  assert.equal((await request('/api/diag/sound', { action: 'INVALID' })).status, 400);
  sockets[1].close();
  await once(sockets[1], 'close');
  await until(() => /window:disconnected.*win=web00001/.test(log()));
  // Force two rotations to prove an existing backup is replaced (including on Windows).
  for (let i = 0; i < 2; i++) {
    fs.appendFileSync(logFile, 'x'.repeat(1024 * 1024));
    assert.equal((await request('/api/diag/note?event=pc:resume')).status, 200);
    assert.ok(fs.statSync(oldFile).size >= 1024 * 1024);
    assert.ok(fs.statSync(logFile).size < 1024 * 1024);
  }
  // Simulate an unwritable log path: timer APIs must still work.
  fs.renameSync(logFile, path.join(dir, 'saved.log'));
  fs.mkdirSync(logFile);
  assert.equal((await request('/api/timer/start', { categoryId: 'test', duration: 10 })).status, 200);
  assert.equal((await request('/api/timer/stop?category=test')).status, 200);
  fs.rmdirSync(logFile);
  const exited = once(child, 'exit');
  child.send('quit');
  assert.equal((await exited)[0], 0);
  assert.match(log(), /app:stopped/);
  assert.equal(errors, '');
});

function soundWindow(visible = 'visible', failReporting = false) {
  const reports = [];
  const sounds = [];
  const buttons = new Map();
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const document = {
    visibilityState: visible,
    querySelector: () => null,
    getElementById: id => elements.get(id) || null,
    createElement: () => ({ setAttribute() {}, querySelector: () => ({
      addEventListener: (type, fn) => buttons.set('stop', fn),
    }) }),
    body: { appendChild: el => elements.set(el.id, el) },
  };
  const context = vm.createContext({ document, navigator: { userAgent: 'Mozilla/5.0' }, window: {},
    API: { settings: { get: async () => ({ alertSound: 'test.wav', alertSoundMode: 'loop' }) } },
    fetch: (_url, options) => {
      if (failReporting) throw new Error('offline');
      reports.push(JSON.parse(options.body));
      return Promise.resolve();
    },
    Audio: function () {
      this.listeners = {};
      this.addEventListener = (type, cb) => { this.listeners[type] = cb; };
      this.play = () => Promise.resolve();
      this.pause = () => { this.paused = true; };
      sounds.push(this);
    },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id), console,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/alertSound.js'), 'utf8'), context);
  return { alert: vm.runInContext('AlertSound', context), reports, sounds, buttons, timers };
}

test('each window reports playback and stop causes; diagnostics cannot block sound', async () => {
  const first = soundWindow();
  const second = soundWindow('hidden');
  await first.alert.reload();
  await second.alert.reload();
  first.alert.play('timer-finished');
  second.alert.play('pomodoro-waiting');
  assert.notEqual(first.reports[0].win, second.reports[0].win);
  assert.equal(second.reports[0].visible, 'hidden');
  assert.equal(first.sounds[0].loop, true);
  first.buttons.get('stop')();
  assert.equal(first.reports.at(-1).reason, 'stop-button');
  assert.equal(first.sounds[0].paused, true);
  assert.equal(second.reports.length, 1); // Stopping stays local, as before.
  first.alert.playOnce('pomodoro-auto');
  assert.equal(first.reports.at(-1).mode, 'once-auto');
  first.sounds.at(-1).listeners.ended({ type: 'ended' });
  assert.equal(first.reports.at(-1).reason, 'ended');
  first.alert.playOnce('pomodoro-auto');
  [...first.timers.values()][0]();
  assert.equal(first.reports.at(-1).reason, 'duration-limit');
  const offline = soundWindow('visible', true);
  await offline.alert.reload();
  assert.doesNotThrow(() => offline.alert.play('timer-finished'));
  assert.equal(offline.sounds[0].loop, true);
  assert.doesNotThrow(() => offline.alert.stop('stop-button'));
});
