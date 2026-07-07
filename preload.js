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
  vcamAvailable: () => ipcRenderer.invoke('vcam:available'),
  vcamInit:     (opts) => ipcRenderer.invoke('vcam:init', opts),
  vcamFrame:    (opts) => ipcRenderer.invoke('vcam:frame', opts),
  vcamStop:     (opts) => ipcRenderer.invoke('vcam:stop', opts),

  // ── Windows / dialogs ──
  openNewWindow:  () => ipcRenderer.invoke('open-new-window'),
  closeOutputWindow: () => ipcRenderer.invoke('output:close'),
  moveOutputWindow: (dx, dy) => ipcRenderer.invoke('output:move', { dx, dy }),
  showDialog:     (opts) => ipcRenderer.invoke('show-dialog', opts),
  openExternal:   (url) => ipcRenderer.invoke('open-external', url),

  // ── Window controls (custom title bar in frameless mode) ──
  windowMinimize:        () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize:  () => ipcRenderer.invoke('window:toggleMaximize'),
  windowIsMaximized:     () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (cb) => {
    const listener = (_e, isMaximized) => cb(isMaximized);
    ipcRenderer.on('window:maximizeChange', listener);
    return () => ipcRenderer.removeListener('window:maximizeChange', listener);
  },

  // ── Slot assignment ──
  onVcamSlot:    (cb) => ipcRenderer.on('vcam-slot', (e, slot) => cb(slot)),
  onVcamDllPath: (cb) => ipcRenderer.on('vcam-dll-path', (e, p) => cb(p)),
  onWindowIndex: (cb) => ipcRenderer.on('window-index', (e, idx) => cb(idx)),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ── Forum account (login runs in main process, JWT stored via safeStorage) ──
  forumLogin:       (email, password) => ipcRenderer.invoke('forum:login', { email, password }),
  forumLogout:      () => ipcRenderer.invoke('forum:logout'),
  forumGetSession:  () => ipcRenderer.invoke('forum:getSession'),
  forumGetRegisterUrl: () => ipcRenderer.invoke('forum:getRegisterUrl'),
  forumGetResetUrl:    () => ipcRenderer.invoke('forum:getResetUrl'),
  forumGetPricingUrl:  () => ipcRenderer.invoke('forum:getPricingUrl'),
  forumGetAccountUrl:  () => ipcRenderer.invoke('forum:getAccountUrl'),
  forumCheckPremium:   () => ipcRenderer.invoke('forum:checkPremium'),

  // ── App info ──
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  quitApp:       () => ipcRenderer.invoke('app:quit'),

});
