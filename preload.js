const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Phone (ADB) detection ──
  listPhones:        () => ipcRenderer.invoke('phones:list'),
  listPhoneCameras:  (serial) => ipcRenderer.invoke('phones:cameras', serial),

  // ── scrcpy camera capture ──
  startScrcpy:       (opts) => ipcRenderer.invoke('scrcpy:start', opts),
  stopScrcpy:        (windowTitle) => ipcRenderer.invoke('scrcpy:stop', windowTitle),
  findCaptureWindow: (windowTitle) => ipcRenderer.invoke('capture:findWindow', windowTitle),
  onScrcpyExited:    (cb) => ipcRenderer.on('scrcpy-exited', (e, data) => cb(data)),
  onScrcpyLog:       (cb) => ipcRenderer.on('scrcpy-log', (e, data) => cb(data)),

  // ── Virtual camera driver ──
  checkVcam:    () => ipcRenderer.invoke('vcam-check'),
  registerVcam: () => ipcRenderer.invoke('vcam-register'),

  // ── Windows / dialogs ──
  openNewWindow:  () => ipcRenderer.invoke('open-new-window'),
  closeOutputWindow: () => ipcRenderer.invoke('output:close'),
  moveOutputWindow: (dx, dy) => ipcRenderer.invoke('output:move', { dx, dy }),
  showDialog:     (opts) => ipcRenderer.invoke('show-dialog', opts),

  // ── Slot assignment ──
  onVcamSlot:    (cb) => ipcRenderer.on('vcam-slot', (e, slot) => cb(slot)),
  onVcamDllPath: (cb) => ipcRenderer.on('vcam-dll-path', (e, p) => cb(p)),

});
