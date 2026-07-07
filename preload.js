const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ÔöÇÔöÇ Phone (ADB) detection ÔöÇÔöÇ
  listPhones:        () => ipcRenderer.invoke('phones:list'),
  listPhoneCameras:  (serial) => ipcRenderer.invoke('phones:cameras', serial),

  // ÔöÇÔöÇ scrcpy camera capture ÔöÇÔöÇ
  startScrcpy:       (opts) => ipcRenderer.invoke('scrcpy:start', opts),
  stopScrcpy:        (windowTitle) => ipcRenderer.invoke('scrcpy:stop', windowTitle),
  findCaptureWindow: (windowTitle) => ipcRenderer.invoke('capture:findWindow', windowTitle),
  onScrcpyExited:    (cb) => ipcRenderer.on('scrcpy-exited', (e, data) => cb(data)),
  onScrcpyLog:       (cb) => ipcRenderer.on('scrcpy-log', (e, data) => cb(data)),

  // ÔöÇÔöÇ Virtual camera driver ÔöÇÔöÇ
  checkVcam:    () => ipcRenderer.invoke('vcam-check'),
  registerVcam: () => ipcRenderer.invoke('vcam-register'),
  vcamAvailable: () => ipcRenderer.invoke('vcam:available'),
  vcamInit:     (opts) => ipcRenderer.invoke('vcam:init', opts),
  vcamFrame:    (opts) => ipcRenderer.invoke('vcam:frame', opts),
  vcamStop:     (opts) => ipcRenderer.invoke('vcam:stop', opts),

  // ÔöÇÔöÇ Windows / dialogs ÔöÇÔöÇ
  openNewWindow:  () => ipcRenderer.invoke('open-new-window'),
  closeOutputWindow: () => ipcRenderer.invoke('output:close'),
  moveOutputWindow: (dx, dy) => ipcRenderer.invoke('output:move', { dx, dy }),
  showDialog:     (opts) => ipcRenderer.invoke('show-dialog', opts),
  openExternal:   (url) => ipcRenderer.invoke('open-external', url),

  // ÔöÇÔöÇ Window controls (custom title bar in frameless mode) ÔöÇÔöÇ
  windowMinimize:        () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize:  () => ipcRenderer.invoke('window:toggleMaximize'),
  windowIsMaximized:     () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (cb) => {
    const listener = (_e, isMaximized) => cb(isMaximized);
    ipcRenderer.on('window:maximizeChange', listener);
    return () => ipcRenderer.removeListener('window:maximizeChange', listener);
  },

  // ÔöÇÔöÇ Slot assignment ÔöÇÔöÇ
  onVcamSlot:    (cb) => ipcRenderer.on('vcam-slot', (e, slot) => cb(slot)),
  onVcamDllPath: (cb) => ipcRenderer.on('vcam-dll-path', (e, p) => cb(p)),
  onWindowIndex: (cb) => ipcRenderer.on('window-index', (e, idx) => cb(idx)),

  // ÔöÇÔöÇ Settings ÔöÇÔöÇ
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ÔöÇÔöÇ License (verified in main process) ÔöÇÔöÇ
  verifyLicenseKey: (key) => ipcRenderer.invoke('license:verify', key),
  checkLicense:     ()  => ipcRenderer.invoke('license:check'),

  // ÔöÇÔöÇ Forum account (login runs in main process, JWT stored via safeStorage) ÔöÇÔöÇ
  forumLogin:       (email, password) => ipcRenderer.invoke('forum:login', { email, password }),
  forumLogout:      () => ipcRenderer.invoke('forum:logout'),
  forumGetSession:  () => ipcRenderer.invoke('forum:getSession'),
  forumGetRegisterUrl: () => ipcRenderer.invoke('forum:getRegisterUrl'),
  forumGetResetUrl:    () => ipcRenderer.invoke('forum:getResetUrl'),
  forumCheckPremium:   () => ipcRenderer.invoke('forum:checkPremium'),

  // ÔöÇÔöÇ App info ÔöÇÔöÇ
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  quitApp:       () => ipcRenderer.invoke('app:quit'),

});
