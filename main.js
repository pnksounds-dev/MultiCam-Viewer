const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session, shell, Menu } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const {
  parseAdbDevices,
  parseScrcpyCameras,
  clampInt,
  isValidSerial,
  isValidCameraId,
  isValidWindowTitle,
  isValidResolution,
} = require('./lib/parsers');
const { checkBundleIntegrity } = require('./lib/integrity');
const {
  forumLogin,
  restoreSession,
  getCachedSession,
  storeSession,
  clearForumSession,
  isJwtExpired,
  checkPremiumEntitlement,
  verifyToken,
  FORUM_REGISTER_URL,
  FORUM_PASSWORD_RESET_URL,
  PRICING_URL,
  ACCOUNT_URL,
} = require('./lib/forumAuth');

// ─── Settings persistence ────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  showSplash: true,
  resolution: '1280x720',
  lastDeviceIndex: '',
  greenscreenEnabled: false,
  gsThreshold: 50,
  gsGap: 0,
  bgColor: '#00ff00',
  exposure: 0,
  contrast: 0,
  saturation: 0,
};

const LOG_FILE = path.join(app.getPath('userData'), 'app.log');
function logToFile(msg) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {}
}

// ─── Settings encryption ─────────────────────────────────────────────────────
// Encrypt sensitive fields (license key) at rest so the settings file is not
// a trivially copy-pasteable credential. The key is derived from machine/user
// context, binding the encrypted value to this PC/account.
const SETTINGS_IV = Buffer.alloc(16, 0); // deterministic IV for this use case

function deriveSettingsKey() {
  const salt = process.env.USERNAME || process.env.USER || 'user';
  const info = `${app.name}|${app.getPath('userData')}|${process.env.COMPUTERNAME || 'host'}`;
  return crypto.pbkdf2Sync(info, salt, 10000, 32, 'sha256');
}

function encryptSetting(plaintext) {
  if (!plaintext) return plaintext;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveSettingsKey(), SETTINGS_IV);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${Buffer.concat([encrypted, tag]).toString('base64')}`;
  } catch { return plaintext; }
}

function decryptSetting(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith('enc:')) return ciphertext;
  try {
    const combined = Buffer.from(ciphertext.slice(4), 'base64');
    if (combined.length < 17) return '';
    const encrypted = combined.slice(0, -16);
    const tag = combined.slice(-16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveSettingsKey(), SETTINGS_IV);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      logToFile('Loaded settings: ' + JSON.stringify(parsed));
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (err) { logToFile('Error loading settings: ' + (err.message || err)); }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toSave = { ...settings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch {}
}

let appSettings = loadSettings();

// ─── License verification (main process — not exposed to DevTools) ───────────
// License keys are RSA-signed payloads verified against the bundled public key.
// The private key is kept outside the repository and is never shipped with the app.

let VcamAddon = null;
const vcamInstances = new Map(); // slot → VcamNative instance
try {
  VcamAddon = require('./vcam-native/index.js');
  logToFile('vcam-native addon loaded successfully');
} catch (err) {
  logToFile('Failed to load vcam-native addon: ' + err.message);
}

function getVcamForSlot(slot) {
  if (!VcamAddon) return null;
  if (!vcamInstances.has(slot)) {
    vcamInstances.set(slot, new VcamAddon());
  }
  return vcamInstances.get(slot);
}

// ─── Splash Window ───────────────────────────────────────────────────────────
let splashWindow = null;

function createSplash() {
  logToFile('Creating splash window');
  splashWindow = new BrowserWindow({
    width: 640,
    height: 540,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.webContents.on('console-message', (event, level, message) => {
    logToFile('Splash console [' + level + ']: ' + message);
  });
  splashWindow.on('ready-to-show', () => {
    logToFile('Splash window ready-to-show');
    const b = splashWindow.getBounds();
    logToFile('Splash bounds: ' + JSON.stringify(b));
    splashWindow.setAlwaysOnTop(true);
    splashWindow.moveTop();
    splashWindow.focus();
  });
  splashWindow.on('closed', () => {
    logToFile('Splash window closed');
    splashWindow = null;
  });
}

// Allow multiple instances of this app simultaneously.
// NOTE: Do NOT call app.requestSingleInstanceLock() — we want multiple instances.
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,CalculateWindowOcclusion,WinOcclusion'
);

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

// Input validation/clamping helpers (clampInt, isValidSerial, isValidCameraId,
// isValidWindowTitle, isValidResolution) now live in ./lib/parsers and are
// imported at the top of this file so they can be unit-tested in isolation.

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
// Parsing of `adb devices -l` and `scrcpy --list-cameras` output lives in
// ./lib/parsers (parseAdbDevices / parseScrcpyCameras) so it can be unit-tested
// without spawning processes. These wrappers handle the process invocation.
//
// Both run ASYNC (execFileAsyncSafe) so a slow ADB daemon or scrcpy enumeration
// can no longer block the Electron main process and freeze every window. The
// IPC handlers (phones:list / phones:cameras) already await these.
async function listPhones() {
  try {
    const out = await execFileAsyncSafe(ADB(), ['devices', '-l'], 30000);
    const { phones, issues } = parseAdbDevices(out);
    return { ok: true, phones, issues };
  } catch (err) {
    return { ok: false, error: String(err.message || err), phones: [], issues: [] };
  }
}

// ─── scrcpy: list cameras for a device ────────────────────────────────────────
async function listCameras(serial) {
  try {
    // scrcpy prints camera list to stderr and exits non-zero but still emits
    // useful output — execFileAsyncSafe surfaces that output as success.
    const out = await execFileAsyncSafe(SCRCPY(), ['-s', serial, '--list-cameras'], 20000, true);
    return { ok: true, cameras: parseScrcpyCameras(out) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), cameras: [] };
  }
}

// execFile but synchronous-ish via execSync wrapper that captures stderr too.
// Retained for any remaining synchronous call sites; the hot enumeration paths
// above use the async variant to avoid blocking the main process.
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

// Async equivalent of execFileSyncSafe. Resolves with captured stdout (+stderr
// when includeStderr is set). Mirrors the sync version's key behaviour: a
// non-zero exit that still produced output is treated as success, because
// scrcpy --list-cameras writes the camera list to stderr and exits non-zero.
function execFileAsyncSafe(file, args, timeout, includeStderr = false) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const combined = (stdout || '') + (includeStderr ? (stderr || '') : (err.stderr || ''));
        if (combined) return resolve(combined);
        return reject(err);
      }
      resolve(includeStderr ? (stdout || '') + (stderr || '') : (stdout || ''));
    });
  });
}

// ─── scrcpy: start camera mirroring ───────────────────────────────────────────
// IMPORTANT capture findings (Windows Graphics Capture):
//  - The scrcpy window MUST NOT be minimized
//  - It CAN be fully occluded or moved off-screen and still be captured
//  - --window-borderless removes its title bar so the header isn't captured
// So we start it borderless and off-screen to keep the user's desktop clean.
function startScrcpyCamera({ serial, cameraId, resolution, maxSize, fps, windowTitle, bounds }) {
  stopScrcpy(windowTitle);

  // Default placement if bounds unknown
  const b = bounds || { x: 60, y: 60, width: 960, height: 600 };

  // Use the selected resolution's aspect ratio for the scrcpy capture window
  // so the camera feed is not cropped to the main window's aspect ratio.
  const [resW, resH] = (resolution || '1280x720').split('x').map(Number);
  let winW = resW;
  let winH = resH;
  // Cap the capture window to a reasonable off-screen size while keeping ratio.
  const maxCap = 1920;
  const scale = Math.min(1, maxCap / Math.max(winW, winH));
  winW = Math.round(winW * scale);
  winH = Math.round(winH * scale);
  // Ensure a minimum useful size.
  winW = Math.max(winW, 320);
  winH = Math.max(winH, 320);

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
    `--window-width=${winW}`,
    `--window-height=${winH}`,
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
  const searchTerms = ['UnityCapture', 'Unity Video Capture', 'MultiCam'];
  return new Promise((resolve) => {
    let completed = 0;
    let found = false;
    for (const term of searchTerms) {
      execFile(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Classes\\CLSID', '/f', term, '/k'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 },
        (err, stdout) => {
          if (!found && !err && stdout && stdout.length > 20) {
            found = true;
            resolve(true);
          }
          completed++;
          if (completed === searchTerms.length && !found) resolve(false);
        }
      );
    }
  });
}

function registerVcam() {
  const dllPath = getVcamDllPath();
  if (!fs.existsSync(dllPath)) {
    return Promise.resolve({
      success: false,
      error: `DLL not found in vcam/ folder.\nLooked for: UnityCaptureFilter64bit.dll or UnityCaptureFilter64.dll\nvcam folder: ${path.join(getResourcesPath(), 'vcam')}`
    });
  }

  return new Promise((resolve) => {
    // Register 4 capture devices so OBS sees MultiCam, MultiCam 2, MultiCam 3, MultiCam 4.
    // Use execFile with an argument array so the DLL path is never interpreted by a shell.
    execFile(
      'powershell.exe',
      [
        '-Command',
        'Start-Process',
        'regsvr32',
        '-ArgumentList',
        `/s /i:UnityCaptureDevices=4 "${dllPath}"`,
        '-Verb',
        'RunAs',
        '-Wait',
      ],
      { stdio: 'pipe', timeout: 30000 },
      (err) => {
        if (err) {
          const msg = err.message || 'Registration failed';
          if (msg.includes('cancelled') || msg.includes('1223') || msg.includes('canceled')) {
            resolve({ success: false, error: 'UAC prompt was cancelled. Please approve the admin request when prompted.' });
          } else {
            resolve({ success: false, error: msg });
          }
        } else {
          resolve({ success: true });
        }
      }
    );
  });
}

// ─── Window Factory ──────────────────────────────────────────────────────────
function createWindow(show = true) {
  logToFile('createWindow called with show=' + show);
  const slotIndex = windows.size % 4;

  const iconPath = path.join(__dirname, 'assets', 'app icon.png');
  const hasIcon = fs.existsSync(iconPath);

  const win = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 700,
    minHeight: 480,
    center: true,
    title: 'MultiCam Viewer',
    backgroundColor: '#0f0f1a',
    frame: false,
    show,
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      nativeWindowOpen: true,
      backgroundThrottling: false,
    },
  });

  // Notify the renderer when the window is maximized/unmaximized so the
  // title bar can swap its maximize/restore icon (covers keyboard shortcuts
  // and double-click title bar, not just the custom button).
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximizeChange', true);
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximizeChange', false);
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

  win.loadFile(path.join(__dirname, 'index.html'));

  // Explicitly set the window title after creation. With frame:false, Windows
  // may not reliably use the title from the BrowserWindow options, causing OBS
  // window capture to see the wrong name.
  win.setTitle('MultiCam Viewer');

  // Block DevTools in production builds to hinder tampering.
  if (app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' ||
          (input.control && input.shift && (input.key === 'I' || input.key === 'J' || input.key === 'C'))) {
        event.preventDefault();
      }
    });
    win.webContents.on('devtools-opened', () => {
      win.webContents.closeDevTools();
    });
  }

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
    win.webContents.send('window-index', slotIndex);

    // Close the splash screen once the main window is ready to show.
    if (splashWindow && !splashWindow.isDestroyed()) {
      // Small delay so the loading bar animation completes.
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) {
          logToFile('Closing splash window');
          splashWindow.close();
          splashWindow = null;
        }
        logToFile('Showing main window');
        win.show();
      }, 3000);
    } else {
      win.show();
    }
  });

  windows.add(win);
  win.on('closed', () => windows.delete(win));

  return win;
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────
ipcMain.handle('phones:list',    async () => await listPhones());
ipcMain.handle('phones:cameras', async (e, serial) => {
  if (!isValidSerial(serial)) return { ok: false, error: 'Invalid device serial', cameras: [] };
  return await listCameras(serial);
});

ipcMain.handle('scrcpy:start', async (e, opts) => {
  const o = opts || {};
  if (!isValidSerial(o.serial))        return { ok: false, error: 'Invalid device serial' };
  if (!isValidCameraId(o.cameraId))    return { ok: false, error: 'Invalid camera id' };
  if (!isValidWindowTitle(o.windowTitle)) return { ok: false, error: 'Invalid window title' };

  const resolution = isValidResolution(o.resolution) ? o.resolution : '1280x720';
  const [resW, resH] = resolution.split('x').map(Number);
  const maxSize = Math.max(resW, resH);

  const safeOpts = {
    serial: o.serial,
    cameraId: String(o.cameraId),
    windowTitle: o.windowTitle,
    resolution,
    maxSize: clampInt(maxSize, 320, 7680, 0),
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

// ─── Virtual camera native frame writing ─────────────────────────────────────
ipcMain.handle('vcam:available', async () => {
  return { available: VcamAddon !== null };
});

ipcMain.handle('vcam:init', async (e, opts) => {
  if (!VcamAddon) return { ok: false, error: 'Native addon not loaded' };
  const o = opts || {};
  const slot = Math.max(0, Math.min(9, parseInt(o.slot, 10) || 0));
  const width = Math.max(16, Math.min(3840, parseInt(o.width, 10) || 1280));
  const height = Math.max(16, Math.min(2160, parseInt(o.height, 10) || 720));
  const vcam = getVcamForSlot(slot);
  if (!vcam) return { ok: false, error: 'Failed to create vcam instance' };
  const ok = vcam.init(slot, width, height);
  return { ok, slot, width, height };
});

ipcMain.handle('vcam:frame', async (e, opts) => {
  const o = opts || {};
  const slot = Math.max(0, Math.min(9, parseInt(o.slot, 10) || 0));
  const vcam = vcamInstances.get(slot);
  if (!vcam) return { ok: false };
  let buf;
  if (Buffer.isBuffer(o.data)) {
    buf = o.data;
  } else if (o.data instanceof ArrayBuffer) {
    buf = Buffer.from(o.data);
  } else if (o.data && o.data.buffer instanceof ArrayBuffer) {
    buf = Buffer.from(o.data.buffer);
  } else {
    return { ok: false, error: 'Expected Buffer or ArrayBuffer' };
  }
  const ok = vcam.writeFrame(buf);
  return { ok };
});

ipcMain.handle('vcam:stop', async (e, opts) => {
  const o = opts || {};
  const slot = Math.max(0, Math.min(9, parseInt(o.slot, 10) || 0));
  const vcam = vcamInstances.get(slot);
  if (vcam) vcam.close();
  return { ok: true };
});

ipcMain.handle('open-new-window', async () => { createWindow(); return true; });
// Only allow external links to the app's official domains.
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'pnksounds.dev',
  'discord.gg',
]);

function isAllowedExternalUrl(url) {
  try {
    if (typeof url !== 'string') return false;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch { return false; }
}

ipcMain.handle('open-external', async (e, url) => {
  if (!isAllowedExternalUrl(url)) {
    return { ok: false, error: 'URL not in allowlist' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

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

// ─── Forum account IPC (login runs in main process) ─────────────────────────
// The forum at pnksounds.dev is the identity provider. The JWT + user blob is
// persisted encrypted via Electron safeStorage (OS keychain). The renderer
// never sees the raw JWT unless it needs it for Supabase queries.

ipcMain.handle('forum:login', async (e, creds) => {
  const email = creds && typeof creds.email === 'string' ? creds.email.trim() : '';
  const password = creds && typeof creds.password === 'string' ? creds.password : '';
  if (!email || !password) {
    return { ok: false, error: 'Enter your forum email and password.' };
  }
  if (email.length > 256 || password.length > 256) {
    return { ok: false, error: 'Invalid input.' };
  }
  try {
    const result = await forumLogin(email, password);
    storeSession(result.token, result.user);
    logToFile('Forum login success for user: ' + result.user.username +
      ' (isAdmin=' + !!result.user.isAdmin + ', isStaff=' + !!result.user.isStaff + ')');
    return { ok: true, user: result.user };
  } catch (err) {
    logToFile('Forum login failed: ' + (err.message || err));
    return { ok: false, error: err.message || 'Login failed.' };
  }
});

ipcMain.handle('forum:logout', async () => {
  clearForumSession();
  logToFile('Forum logout');
  return { ok: true };
});

ipcMain.handle('forum:getSession', async () => {
  const session = restoreSession();
  if (!session) return { ok: false };
  return { ok: true, user: session.user };
});

ipcMain.handle('forum:verifyToken', async () => {
  try {
    const user = await verifyToken();
    if (user) {
      logToFile('Token verified for user: ' + user.username + ' (isAdmin=' + !!user.isAdmin + ', isStaff=' + !!user.isStaff + ')');
      return { ok: true, user };
    }
    return { ok: false };
  } catch (err) {
    logToFile('Token verify failed: ' + (err.message || err));
    return { ok: false };
  }
});

ipcMain.handle('forum:getRegisterUrl', async () => FORUM_REGISTER_URL);
ipcMain.handle('forum:getResetUrl', async () => FORUM_PASSWORD_RESET_URL);
ipcMain.handle('forum:getPricingUrl', async () => PRICING_URL);
ipcMain.handle('forum:getAccountUrl', async () => ACCOUNT_URL);

// Check whether the logged-in forum user has premium for this app.
// Calls GET /api/entitlements/multicam on the PNKSOUNDS API with the JWT.
ipcMain.handle('forum:checkPremium', async () => {
  try {
    const result = await checkPremiumEntitlement();
    return result;
  } catch (err) {
    logToFile('Forum premium check failed: ' + (err.message || err));
    return { premium: false, source: 'none', authenticated: true };
  }
});

ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
});

// Deliberate app quit — used by the "Exit App" button in Settings so the
// user doesn't accidentally close the app via the taskbar/window X.
ipcMain.handle('app:quit', async () => {
  logToFile('App quit requested via IPC');
  stopAllScrcpy();
  app.quit();
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

// ─── Window Control IPC (for custom title bar in frameless mode) ─────────────
// The renderer calls these from the minimize/maximize buttons in the top bar.
// Each handler finds the BrowserWindow that sent the request via the event's
// sender, so it works correctly for multi-window mode.
ipcMain.handle('window:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
  return true;
});

ipcMain.handle('window:toggleMaximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMaximized()) {
    w.unmaximize();
    return false;
  }
  w.maximize();
  return true;
});

ipcMain.handle('window:isMaximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? w.isMaximized() : false;
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.setAppUserModelId('com.multicam.viewer');

app.whenReady().then(async () => {
  logToFile('App ready. userData: ' + app.getPath('userData'));
  logToFile('Initial appSettings: ' + JSON.stringify(appSettings));

  // Verify critical bundled binaries are present and non-empty.
  const integrity = checkBundleIntegrity(getResourcesPath());
  for (const item of integrity) {
    if (!item.ok) {
      logToFile(`Integrity warning: ${item.name} missing or too small (size=${item.size})`);
    }
  }

  // Remove the default application menu (File/Edit/View/Window/Help) for a
  // clean, headless look — the custom top bar handles all window controls.
  Menu.setApplicationMenu(null);

  // Clear the disk cache so updated image assets (logo, splash) are always
  // loaded fresh instead of served from an old cache.
  await session.defaultSession.clearCache();
  logToFile('Cache cleared');

  // Start the ADB server in the background so the first phone scan doesn't
  // time out waiting for the daemon to launch (common after a PC reboot).
  spawn(ADB(), ['start-server'], { windowsHide: true, stdio: 'ignore' });

  // Persist the merged settings so any new default keys are written to disk
  // without overwriting existing user values.
  saveSettings(appSettings);
  logToFile('Settings saved');

  // Show splash screen first (unless disabled in settings).
  if (appSettings.showSplash) {
    logToFile('Splash enabled, creating splash');
    createSplash();
    // Delay the main window slightly so the splash is visible first and
    // doesn't get interfered with by the main window being created.
    setTimeout(() => {
      logToFile('Delayed main window creation');
      createWindow(false);
    }, 400);
  } else {
    logToFile('Splash disabled');
    createWindow(true);
  }
});

app.on('before-quit', stopAllScrcpy);
app.on('window-all-closed', () => {
  stopAllScrcpy();
  app.quit();
});
