const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron:       true,
  setZoom:          (factor)    => webFrame.setZoomFactor(factor),
  setLoginItem:     (enable)    => ipcRenderer.invoke('set-login-item', enable),
  setShortcuts:     (shortcuts) => ipcRenderer.invoke('set-shortcuts', shortcuts),
  getLogPath:       ()          => ipcRenderer.invoke('get-log-path'),
  openLogFolder:    ()          => ipcRenderer.invoke('open-log-folder'),
  isUpdateSupported:  ()    => ipcRenderer.invoke('is-update-supported'),
  checkForUpdates:    ()    => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate:     ()    => ipcRenderer.invoke('download-update'),
  installUpdate:      ()    => ipcRenderer.invoke('install-update'),
  onUpdateAvailable:  (cb)  => ipcRenderer.on('update-available',     (_, info) => cb(info)),
  onUpdateProgress:   (cb)  => ipcRenderer.on('update-progress',      (_, percent) => cb(percent)),
  onUpdateDownloaded: (cb)  => ipcRenderer.on('update-downloaded',    () => cb()),
  onUpdateNotAvailable: (cb)=> ipcRenderer.on('update-not-available', () => cb()),
  onUpdateError:      (cb)  => ipcRenderer.on('update-error',         (_, kind) => cb(kind)),
});
