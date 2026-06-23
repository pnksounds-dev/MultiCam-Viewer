const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require('electron');
const path = require('path');
const { execSync, execFile, spawn } = require('child_process');
const fs = require('fs');

// ─── Settings persistence ────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  showSplash: true,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch {}
}

let appSettings = loadSettings();

// ─── Splash Window ───────────────────────────────────────────────────────────
let splashWindow = null;

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 420,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    center: true,
    show: true,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.loadFile('splash.html');

  splashWindow.on('closed', () => { splashWindow = null; });
}

// Allow multiple instances of this app simultaneously.
// NOTE: Do NOT call app.requestSingleInstanceLock() — we want multiple instances.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// Track all created windows
const windows = new Set();

// Track running scrcpy processes, keyed by their unique window title
// { title -> { proc, deviceId } }
const scrcpyProcs = new Map();

// ─── IPC input validation ────────────────────────────────────────────────────
// The renderer is local/trusted, but validating every IPC payload ensures a
// compromised or buggy renderer cannot pass malformed values into process
// spawning or window operations.
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ADB serials: alphanumeric, dot, colon, dash, underscore (covers USB serials
// and ip:port transport ids). Reject anything else to avoid argument injection.
function isValidSerial(serial) {
  return typeof serial === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(serial);
}

function isValidCameraId(id) {
  return /^\d{1,4}$/.test(String(id));
}

// scrcpy window titles are app-generated; keep them to a safe character set.
function isValidWindowTitle(title) {
  return typeof title === 'string' && /^[A-Za-z0-9 _.:#-]{1,128}$/.test(title);
}

// ─── Paths ─────────────────────────────────────────────────────────────────
function getResourcesPath() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function getToolPath(exe) {
  return path.join(getResourcesPath(), 'tools', exe);
}

const ADB    = () => getToolPath('adb.exe');
const SCRCPY = () => getToolPath('scrcpy.exe');

function getVcamDllPath() {
  const base = path.join(getResourcesPath(), 'vcam');
  const candidates = [
    path.join(base, 'UnityCaptureFilter64bit.dll'),
    path.join(base, 'UnityCaptureFilter64.dll'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// ─── ADB: list connected phones ───────────────────────────────────────────────
function listPhones() {
  try {
    const out = execFileSyncSafe(ADB(), ['devices', '-l'], 30000);
    const phones = [];
    const lines = out.split(/\r?\n/).slice(1); // skip "List of devices attached"
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: <serial>   device product:... model:Pixel_6a device:... transport_id:N
      const m = trimmed.match(/^(\S+)\s+device\b(.*)$/);
      if (!m) continue;
      const serial = m[1];
      const rest = m[2] || '';
      const modelMatch = rest.match(/model:(\S+)/);
      const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : serial;
      phones.push({ serial, model });
    }
    return { ok: true, phones };
  } catch (err) {
    return { ok: false, error: String(err.message || err), phones: [] };
  }
}

// ─── scrcpy: list cameras for a device ────────────────────────────────────────
function listCameras(serial) {
  try {
    // scrcpy prints camera list to stderr and exits
    const out = execFileSyncSafe(SCRCPY(), ['-s', serial, '--list-cameras'], 20000, true);
    const cameras = [];
    const re = /--camera-id=(\d+)\s+\((\w+),\s*(\d+x\d+)/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      cameras.push({ id: m[1], facing: m[2], maxRes: m[3] });
    }
    return { ok: true, cameras };
  } catch (err) {
    return { ok: false, error: String(err.message || err), cameras: [] };
  }
}

// execFile but synchronous-ish via execSync wrapper that captures stderr too
function execFileSyncSafe(file, args, timeout, includeStderr = false) {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync(file, args, {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', includeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });
    return out;
  } catch (err) {
    // scrcpy --list-cameras exits non-zero but still prints to stdout/stderr
    const combined = (err.stdout || '') + (err.stderr || '');
    if (combined) return combined;
    throw err;
  }
}

// ─── scrcpy: start camera mirroring ───────────────────────────────────────────
// IMPORTANT capture findings (Windows Graphics Capture):
//  - The scrcpy window MUST NOT be minimized
//  - It CAN be fully occluded or moved off-screen and still be captured
//  - --window-borderless removes its title bar so the header isn't captured
// So we start it borderless and off-screen to keep the user's desktop clean.
function startScrcpyCamera({ serial, cameraId, maxSize, fps, windowTitle, bounds }) {
  stopScrcpy(windowTitle);

  // Default placement if bounds unknown
  const b = bounds || { x: 60, y: 60, width: 960, height: 600 };

  // Position the scrcpy capture window off-screen so the user only sees the
  // main MultiCam window. Windows Graphics Capture still works for off-screen
  // windows as long as they are not minimized. --window-borderless removes the
  // title bar so it doesn't appear in the captured feed.
  const offX = -10000;
  const offY = -10000;

  const args = [
    '-s', serial,
    '--video-source=camera',
    `--camera-id=${cameraId}`,
    '--no-audio',
    '--no-control',
    `--window-title=${windowTitle}`,
    `--window-x=${offX}`,
    `--window-y=${offY}`,
    `--window-width=${b.width}`,
    `--window-height=${b.height}`,
    '--window-borderless',
  ];
  if (maxSize) args.push(`--max-size=${maxSize}`);
  if (fps)     args.push(`--max-fps=${fps}`);

  try {
    const proc = spawn(SCRCPY(), args, { windowsHide: false });
    scrcpyProcs.set(windowTitle, { proc, serial });

    let outBuf = '';
    const onData = (d) => {
      const text = d.toString();
      outBuf += text;
      // Forward each line to renderers for live diagnostics
      for (const w of windows) {
        if (!w.isDestroyed()) w.webContents.send('scrcpy-log', { windowTitle, text });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      scrcpyProcs.delete(windowTitle);
      for (const w of windows) {
        if (!w.isDestroyed()) {
          w.webContents.send('scrcpy-exited', { windowTitle, code, stderr: outBuf.slice(-600) });
        }
      }
    });

    return { ok: true, windowTitle };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function stopScrcpy(windowTitle) {
  const entry = scrcpyProcs.get(windowTitle);
  if (entry && entry.proc && !entry.proc.killed) {
    try { entry.proc.kill(); } catch {}
  }
  scrcpyProcs.delete(windowTitle);
}

function stopAllScrcpy() {
  for (const title of [...scrcpyProcs.keys()]) stopScrcpy(title);
}

// ─── Virtual Camera (UnityCapture) ────────────────────────────────────────────
function isVcamInstalled() {
  try {
    const result = execSync(
      'reg query "HKLM\\SOFTWARE\\Classes\\CLSID" /f "UnityCapture" /k',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
    );
    return result.includes('UnityCapture');
  } catch {
    try {
      const result2 = execSync(
        'reg query "HKLM\\SOFTWARE\\Classes\\CLSID" /f "Unity Video Capture" /k',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
      );
      return result2.length > 20;
    } catch {
      return false;
    }
  }
}

function registerVcam() {
  const dllPath = getVcamDllPath();
  if (!fs.existsSync(dllPath)) {
    return {
      success: false,
      error: `DLL not found in vcam/ folder.\nLooked for: UnityCaptureFilter64bit.dll or UnityCaptureFilter64.dll\nvcam folder: ${path.join(getResourcesPath(), 'vcam')}`
    };
  }
  try {
    execSync(
      `powershell -Command "Start-Process regsvr32 -ArgumentList '/s \\"${dllPath}\\"' -Verb RunAs -Wait"`,
      { stdio: 'pipe', timeout: 30000 }
    );
    return { success: true };
  } catch (err) {
    const msg = err.message || 'Registration failed';
    if (msg.includes('cancelled') || msg.includes('1223') || msg.includes('canceled')) {
      return { success: false, error: 'UAC prompt was cancelled. Please approve the admin request when prompted.' };
    }
    return { success: false, error: msg };
  }
}

// ─── Window Factory ──────────────────────────────────────────────────────────
function createWindow(show = true) {
  const slotIndex = windows.size % 4;

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const hasIcon = fs.existsSync(iconPath);

  const win = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 700,
    minHeight: 480,
    center: true,
    title: 'MultiCam Viewer',
    backgroundColor: '#0f0f1a',
    show,
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      nativeWindowOpen: true,
    },
  });

  // Only grant the permissions this app actually needs (camera/mic + screen
  // capture). Everything else is denied so injected/remote content cannot
  // silently gain sensitive access.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Block navigation away from the local app files. Any attempt to navigate to
  // an external/remote origin is prevented.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile('index.html');

  // Make the output window (opened via window.open from the renderer) borderless
  // so the whole body can be used to drag it. Only allow opening the local
  // output.html — deny any other URL.
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    let isOutput = false;
    try {
      isOutput = url.startsWith('file://') && /\/output\.html(?:[?#]|$)/.test(url);
    } catch { isOutput = false; }
    if (!isOutput) return { action: 'deny' };

    const parsed = new URLSearchParams((features || '').replace(/,/g, '&'));
    const width = parseInt(parsed.get('width'), 10) || 960;
    const height = parseInt(parsed.get('height'), 10) || 540;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        width,
        height,
        backgroundColor: '#000000',
      },
    };
  });

  // Offset additional windows from the center so they don't fully overlap.
  if (windows.size > 0) {
    const offset = windows.size * 40;
    const b = win.getBounds();
    win.setBounds({ x: b.x + offset, y: b.y + offset, width: b.width, height: b.height });
  }

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('vcam-slot', slotIndex);
    win.webContents.send('vcam-dll-path', getVcamDllPath());

    // Close the splash screen once the main window is ready to show.
    if (splashWindow && !splashWindow.isDestroyed()) {
      // Small delay so the loading bar animation completes.
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close();
          splashWindow = null;
        }
        win.show();
      }, 1800);
    } else {
      win.show();
    }
  });

  windows.add(win);
  win.on('closed', () => windows.delete(win));

  return win;
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────
ipcMain.handle('phones:list',    async () => listPhones());
ipcMain.handle('phones:cameras', async (e, serial) => {
  if (!isValidSerial(serial)) return { ok: false, error: 'Invalid device serial', cameras: [] };
  return listCameras(serial);
});

ipcMain.handle('scrcpy:start', async (e, opts) => {
  const o = opts || {};
  if (!isValidSerial(o.serial))        return { ok: false, error: 'Invalid device serial' };
  if (!isValidCameraId(o.cameraId))    return { ok: false, error: 'Invalid camera id' };
  if (!isValidWindowTitle(o.windowTitle)) return { ok: false, error: 'Invalid window title' };

  const safeOpts = {
    serial: o.serial,
    cameraId: String(o.cameraId),
    windowTitle: o.windowTitle,
    maxSize: o.maxSize != null ? clampInt(o.maxSize, 320, 7680, 0) : 0,
    fps:     o.fps != null ? clampInt(o.fps, 1, 240, 0) : 0,
  };

  const appWin = BrowserWindow.fromWebContents(e.sender);
  const bounds = appWin ? appWin.getBounds() : null;
  return startScrcpyCamera({ ...safeOpts, bounds });
});
ipcMain.handle('scrcpy:stop',  async (e, windowTitle) => {
  if (!isValidWindowTitle(windowTitle)) return { ok: false, error: 'Invalid window title' };
  stopScrcpy(windowTitle);
  return { ok: true };
});

// Find the desktopCapturer source id for a given scrcpy window title
ipcMain.handle('capture:findWindow', async (e, windowTitle) => {
  if (!isValidWindowTitle(windowTitle)) return { ok: false };
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const match = sources.find(s => s.name === windowTitle);
  return match ? { ok: true, id: match.id, name: match.name } : { ok: false };
});

ipcMain.handle('vcam-check',    async () => isVcamInstalled());
ipcMain.handle('vcam-register', async () => registerVcam());

ipcMain.handle('open-new-window', async () => { createWindow(); return true; });

ipcMain.handle('output:close', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

ipcMain.handle('output:move', async (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    // Clamp per-move deltas to a sane range so a runaway renderer can't fling
    // the window arbitrarily far in a single call.
    const dx = clampInt(payload && payload.dx, -4000, 4000, 0);
    const dy = clampInt(payload && payload.dy, -4000, 4000, 0);
    const b = win.getBounds();
    win.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
  }
  return { ok: true };
});

ipcMain.handle('settings:get', async () => appSettings);
ipcMain.handle('settings:set', async (e, patch) => {
  if (patch && typeof patch === 'object') {
    appSettings = { ...appSettings, ...patch };
    saveSettings(appSettings);
  }
  return appSettings;
});

ipcMain.handle('show-dialog', async (e, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const o = opts || {};
  // Only pass through known-safe message box fields.
  const ALLOWED_TYPES = new Set(['none', 'info', 'error', 'question', 'warning']);
  const safe = {
    type: ALLOWED_TYPES.has(o.type) ? o.type : 'info',
    title: typeof o.title === 'string' ? o.title.slice(0, 256) : undefined,
    message: typeof o.message === 'string' ? o.message.slice(0, 2000) : '',
    detail: typeof o.detail === 'string' ? o.detail.slice(0, 4000) : undefined,
    buttons: Array.isArray(o.buttons)
      ? o.buttons.slice(0, 8).map(b => String(b).slice(0, 128))
      : undefined,
    defaultId: Number.isInteger(o.defaultId) ? o.defaultId : undefined,
    cancelId: Number.isInteger(o.cancelId) ? o.cancelId : undefined,
  };
  return dialog.showMessageBox(win, safe);
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Start the ADB server in the background so the first phone scan doesn't
  // time out waiting for the daemon to launch (common after a PC reboot).
  spawn(ADB(), ['start-server'], { windowsHide: true, stdio: 'ignore' });

  // Re-enable the splash screen if it was previously disabled.
  if (!appSettings.showSplash) {
    appSettings.showSplash = true;
    saveSettings(appSettings);
  }

  // Show splash screen first (unless disabled in settings).
  if (appSettings.showSplash) {
    createSplash();
  }

  // Hide the main window initially when splash is shown; it will be revealed
  // after did-finish-load fires and the splash loading bar animation completes.
  createWindow(!appSettings.showSplash);
});

app.on('before-quit', stopAllScrcpy);
app.on('window-all-closed', () => {
  stopAllScrcpy();
  app.quit();
});
