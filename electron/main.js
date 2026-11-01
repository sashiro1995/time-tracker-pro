const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, shell, dialog } = require('electron');
const { classifyPort, killPort, portOwnerName } = require('./portCheck');
const path = require('path');
const net  = require('net');
const http = require('http');
const fs   = require('fs');
const log  = require('electron-log');
const { autoUpdater } = require('electron-updater');

// Route console.error to the log file
log.transports.file.level = 'warn';
console.error = log.error;
autoUpdater.logger = log;

process.on('uncaughtException', err => {
  log.error('Uncaught exception:', err);
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

// ── App icon: loaded from file, resized as needed ─────────────────────────
const ICON_PATH = path.join(ROOT, 'public', 'icons', 'icon.png');

function buildAppIcon(size = 256) {
  const img = nativeImage.createFromPath(ICON_PATH);
  return size < 256 ? img.resize({ width: size, height: size }) : img;
}

// ── Make sure port 3000 is ours to use ────────────────────────────────────
// Stream Dock buttons are fixed to this port, so we can't move to another one.
// A leftover copy of this app gets closed; any other program is left alone.
async function ensurePortAvailable() {
  while (true) {
    const state = await classifyPort(PORT);
    if (state === 'free') return true;
    if (state === 'ours') {
      killPort(PORT);
      await new Promise(resolve => setTimeout(resolve, 300));
      return true;
    }
    const owner = portOwnerName(PORT) || 'another program';
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Time Tracker Pro',
      message: `Port ${PORT} is being used by ${owner}`,
      detail: `Time Tracker Pro needs this port to run, and your Stream Dock buttons use it too. Close ${owner}, then choose Try again.`,
      buttons: ['Try again', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return false;
  }
}

// ── Start the Express + WebSocket server in-process ───────────────────────
function startServer() {
  const packed = app.isPackaged;
  process.env.DATA_DIR   = process.env.DATA_DIR   || (packed ? path.join(app.getPath('userData'), 'data')   : path.join(ROOT, 'data'));
  process.env.SOUNDS_DIR = process.env.SOUNDS_DIR || (packed ? path.join(app.getPath('userData'), 'sounds') : path.join(ROOT, 'public', 'sounds'));
  require(path.join(ROOT, 'server.js'));
}

// ── Poll until port 3000 is accepting connections (max ~9 s) ──────────────
function waitForServer(resolve, attempts = 0) {
  if (attempts > 30) { resolve(); return; }
  const sock = net.createConnection(PORT, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(); });
  sock.once('error', () => setTimeout(() => waitForServer(resolve, attempts + 1), 300));
}

// ── Fire an Express API endpoint from main process ────────────────────────
function callAPI(route) {
  http.get(`http://localhost:${PORT}${route}`, res => { res.resume(); }).on('error', () => {});
}

// ── Global shortcut actions ───────────────────────────────────────────────
function handleShortcut(action) {
  if (action === 'toggleWindow') {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    return;
  }
  const routes = {
    startTimer: '/api/timer/toggle',
    pauseTimer: '/api/timer/pause',
    stopTimer:  '/api/timer/stop',
  };
  const route = routes[action];
  if (route) callAPI(route);
}

// ── Register shortcuts from a shortcuts object ────────────────────────────
function registerShortcuts(shortcuts) {
  globalShortcut.unregisterAll();
  const conflicts = [];
  for (const [action, combo] of Object.entries(shortcuts)) {
    if (!combo) continue;
    const ok = globalShortcut.register(combo, () => handleShortcut(action));
    if (!ok) conflicts.push(action);
  }
  return conflicts;
}

// ── Read settings.json (from DATA_DIR or dev fallback) ───────────────────
function readSettings() {
  try {
    const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ── Main window ───────────────────────────────────────────────────────────
function createWindow() {
  const startHidden = process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Time Tracker Pro',
    backgroundColor: readSettings().appearance?.baseColor || '#0C0D18',
    icon: buildAppIcon(256),
    show: false,
  });

  // The menu bar is gone, so keep reload and dev tools when running from source
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control) return;
      const key = input.key.toLowerCase();
      if (key === 'r') { mainWindow.webContents.reload(); event.preventDefault(); }
      if (key === 'i' && input.shift) { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    });
  }

  mainWindow.loadURL(SERVER_URL);

  if (!startHidden) {
    // ready-to-show never fires when the page loads from cache, so a finished load also shows the window
    const showWindow = () => {
      mainWindow.show();
      mainWindow.moveTop(); // the launch can take a moment, and another window may have taken over by then
    };
    mainWindow.once('ready-to-show', showWindow);
    mainWindow.webContents.once('did-finish-load', showWindow);
    mainWindow.webContents.once('did-fail-load', showWindow);
  }

  // X button hides to tray instead of quitting
  mainWindow.on('close', e => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── System tray ───────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(buildAppIcon(16));
  tray.setToolTip('Time Tracker Pro');

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Time Tracker',
      click: () => { mainWindow.show(); mainWindow.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]));

  // Left-click tray icon → show/focus window
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────
ipcMain.handle('set-login-item', (_, enable) => {
  app.setLoginItemSettings({
    openAtLogin: !!enable,
    args: enable ? ['--hidden'] : [],
  });
  return { ok: true };
});

ipcMain.handle('set-shortcuts', (_, shortcuts) => {
  const conflicts = registerShortcuts(shortcuts);
  return { ok: conflicts.length === 0, conflicts };
});

// ── Auto-updater ──────────────────────────────────────────────────────────
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
let updateCheckIsManual = false;
let updateDownloadStarted = false;

function sendUpdateEvent(channel, payload) {
  if (mainWindow) mainWindow.webContents.send(channel, payload);
}

// Only the Check button reports a failed check; a background one fails quietly and tries again later
function checkForUpdates(manual) {
  if (updateDownloadStarted) return;
  updateCheckIsManual = manual;
  autoUpdater.checkForUpdates().catch(() => {});
}

function updateErrorKind(err) {
  const text = `${err.code || ''} ${err.message || ''}`;
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONN|EAI_AGAIN/.test(text)) return 'connection';
  if (updateDownloadStarted) return 'download';
  if (/NOT_FOUND|NO_PUBLISHED|HTTP_ERROR_404|INVALID_RELEASE_FEED|status 404/i.test(text)) return 'release';
  return 'unknown';
}

function setupAutoUpdater() {
  // The app only tells the user about a new version: nothing downloads or installs until they choose to
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  if (!app.isPackaged) return; // only runs in the installed app, not dev mode

  autoUpdater.on('update-available', info => {
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map(entry => entry.note).join('\n')
      : info.releaseNotes;
    sendUpdateEvent('update-available', { version: info.version, notes: notes || '' });
  });

  autoUpdater.on('update-not-available', () => {
    if (updateCheckIsManual) sendUpdateEvent('update-not-available');
  });

  autoUpdater.on('download-progress', progress => {
    sendUpdateEvent('update-progress', Math.round(progress.percent));
  });

  autoUpdater.on('update-downloaded', () => {
    sendUpdateEvent('update-downloaded');
  });

  autoUpdater.on('error', err => {
    log.warn('Update failed:', err);
    if (!updateCheckIsManual && !updateDownloadStarted) return;
    sendUpdateEvent('update-error', updateErrorKind(err));
    updateDownloadStarted = false;
  });

  setTimeout(() => checkForUpdates(false), 5000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL);
}

ipcMain.handle('is-update-supported', () => app.isPackaged);

ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) checkForUpdates(true);
});

ipcMain.handle('download-update', () => {
  updateDownloadStarted = true;
  autoUpdater.downloadUpdate().catch(() => {});
});

ipcMain.handle('install-update', () => {
  // Silent: no installer wizard. Then reopen the app once it's done.
  autoUpdater.quitAndInstall(true, true);
});

// ── IPC: diagnostics ─────────────────────────────────────────────────────
ipcMain.handle('get-log-path', () => {
  return log.transports.file.getFile().path;
});

ipcMain.handle('open-log-folder', () => {
  const logFile = log.transports.file.getFile().path;
  shell.openPath(path.dirname(logFile));
});

// ── Lifecycle ─────────────────────────────────────────────────────────────
// Same id as build.appId, so Windows groups the window and taskbar under one icon
app.setAppUserModelId('com.timetracker.pro');

// A second launch would close this app's server on port 3000, so focus this window instead
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!isFirstInstance) return;
  log.info('App started, version:', app.getVersion());
  Menu.setApplicationMenu(null);
  if (!(await ensurePortAvailable())) {
    app.quit();
    return;
  }
  startServer();
  new Promise(resolve => waitForServer(resolve)).then(() => {
    createWindow();
    createTray();
    setupAutoUpdater();

    // Apply saved settings
    const settings = readSettings();
    if (settings.shortcuts) registerShortcuts(settings.shortcuts);
    if (settings.launchAtStartup != null) {
      app.setLoginItemSettings({
        openAtLogin: !!settings.launchAtStartup,
        args: settings.launchAtStartup ? ['--hidden'] : [],
      });
    }
  });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

// Tray app — don't quit when the last window closes
app.on('window-all-closed', () => {});
