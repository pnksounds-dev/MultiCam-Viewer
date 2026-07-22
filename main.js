const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
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
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PID:${process.pid}] ${msg}\n`, 'utf8');
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
let isInitializing = false; // true during splash→main transition to suppress premature window-all-closed

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
// Checks if the UnityCapture DirectShow filter is registered by searching the
// CLSID registry for the filter's friendly name ("MultiCam"). The registration
// creates CLSID keys with GUID names like {5C2CD55C-...} whose default value
// is "MultiCam", so we must search recursively (/s) in values (not /k which
// only searches key names).
function isVcamInstalled() {
  const searchTerms = ['MultiCam', 'UnityCapture', 'Unity Video Capture'];
  return new Promise((resolve) => {
    let completed = 0;
    let found = false;
    for (const term of searchTerms) {
      execFile(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Classes\\CLSID', '/s', '/f', term],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 },
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

// Map regsvr32 HRESULTs to user-friendly messages. Returns null for success.
function mapRegsvr32Error(code) {
  if (code === 0) return null;
  if (code === 0x80070005) return 'Access denied — run as Administrator.';
  if (code === 0x8007007E) return 'DLL not found or a dependency is missing.';
  if (code === 0x80040111) return 'Cannot write to the registry — run as Administrator.';
  if (code === 0x80040201) return 'DllRegisterServer failed — the DLL may be corrupted or incompatible.';
  if (code === 0x8002801C) return 'ActiveX/COM registration failed — check DLL permissions.';
  return `Registration failed (error code 0x${(code >>> 0).toString(16).toUpperCase()}).`;
}

// Register a DLL via regsvr32 with elevation. Uses a temp batch file so the
// DLL path is never shell-parsed (no PowerShell string interpolation issues
// with spaces or special characters). Writes the regsvr32 exit code to a temp
// file because $p.ExitCode is unreliable when Start-Process uses -Verb RunAs
// (ShellExecute-launched processes don't reliably expose ExitCode on Win10).
function registerDllElevated(dllPath, use32BitRegsvr) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpBat = path.join(os.tmpdir(), `mcv-register-${stamp}.bat`);
  const tmpResult = path.join(os.tmpdir(), `mcv-register-result-${stamp}.txt`);
  const regsvr = use32BitRegsvr ? '"%WINDIR%\\SysWOW64\\regsvr32.exe"' : 'regsvr32';
  // Use \r\n line endings for cmd.exe compatibility. Write the exit code to a
  // temp file so we can read it after the elevated process completes.
  const cmd = `@echo off\r\n${regsvr} /s /i:UnityCaptureDevices=4 "${dllPath}"\r\necho %errorlevel% > "${tmpResult}"\r\n`;
  fs.writeFileSync(tmpBat, cmd, 'utf8');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Start-Process -FilePath "cmd.exe" -ArgumentList "/c","${tmpBat}" -Verb RunAs -Wait`
      ],
      { stdio: 'pipe', timeout: 60000 },
      (err) => {
        try { fs.unlinkSync(tmpBat); } catch {}
        if (err) {
          const msg = err.message || 'Registration failed';
          if (msg.includes('cancelled') || msg.includes('1223') || msg.includes('canceled')) {
            try { fs.unlinkSync(tmpResult); } catch {}
            resolve({ success: false, error: 'UAC prompt was cancelled. Please approve the admin request when prompted.' });
            return;
          }
          // PowerShell itself errored — but the batch may have run. Fall through
          // to read the result file before giving up.
        }
        // Read the exit code from the temp file (reliable across Win10/11)
        let exitCode = 0;
        try {
          const content = fs.readFileSync(tmpResult, 'utf8').trim();
          exitCode = parseInt(content, 10);
          if (isNaN(exitCode)) exitCode = 0;
        } catch {
          // Result file doesn't exist — the batch didn't run (UAC cancelled or failed)
          try { fs.unlinkSync(tmpResult); } catch {}
          resolve({ success: false, error: 'Registration did not complete. The admin prompt may have been cancelled.' });
          return;
        }
        try { fs.unlinkSync(tmpResult); } catch {}
        if (exitCode === 0) {
          resolve({ success: true });
        } else {
          const friendly = mapRegsvr32Error(exitCode);
          resolve({ success: false, error: friendly || `Registration failed (error code 0x${(exitCode >>> 0).toString(16).toUpperCase()}).` });
        }
      }
    );
  });
}

// Unregister a DLL via regsvr32 /u with elevation. Mirrors registerDllElevated.
function unregisterDllElevated(dllPath, use32BitRegsvr) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpBat = path.join(os.tmpdir(), `mcv-unregister-${stamp}.bat`);
  const tmpResult = path.join(os.tmpdir(), `mcv-unregister-result-${stamp}.txt`);
  const regsvr = use32BitRegsvr ? '"%WINDIR%\\SysWOW64\\regsvr32.exe"' : 'regsvr32';
  const cmd = `@echo off\r\n${regsvr} /u /s "${dllPath}"\r\necho %errorlevel% > "${tmpResult}"\r\n`;
  fs.writeFileSync(tmpBat, cmd, 'utf8');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Start-Process -FilePath "cmd.exe" -ArgumentList "/c","${tmpBat}" -Verb RunAs -Wait`
      ],
      { stdio: 'pipe', timeout: 60000 },
      (err) => {
        try { fs.unlinkSync(tmpBat); } catch {}
        if (err) {
          const msg = err.message || 'Unregistration failed';
          if (msg.includes('cancelled') || msg.includes('1223') || msg.includes('canceled')) {
            try { fs.unlinkSync(tmpResult); } catch {}
            resolve({ success: false, error: 'UAC prompt was cancelled.' });
            return;
          }
        }
        let exitCode = 0;
        try {
          const content = fs.readFileSync(tmpResult, 'utf8').trim();
          exitCode = parseInt(content, 10);
          if (isNaN(exitCode)) exitCode = 0;
        } catch {
          try { fs.unlinkSync(tmpResult); } catch {}
          resolve({ success: false, error: 'Unregistration did not complete. The admin prompt may have been cancelled.' });
          return;
        }
        try { fs.unlinkSync(tmpResult); } catch {}
        if (exitCode === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `Unregistration failed (error code 0x${(exitCode >>> 0).toString(16).toUpperCase()}).` });
        }
      }
    );
  });
}

// Track the last registration/unregistration error for the diagnostics panel.
let lastVcamError = null;

async function registerVcam() {
  const base = path.join(getResourcesPath(), 'vcam');
  const dll64 = path.join(base, 'UnityCaptureFilter64.dll');
  const dll32 = path.join(base, 'UnityCaptureFilter32.dll');

  logToFile('registerVcam: starting. base=' + base + ' dll64=' + dll64 + ' exists64=' + fs.existsSync(dll64));

  if (!fs.existsSync(dll64)) {
    lastVcamError = `64-bit DLL not found. Looked for: ${dll64}`;
    logToFile('registerVcam: ' + lastVcamError);
    return { success: false, error: lastVcamError };
  }

  // Register 64-bit first (primary)
  logToFile('registerVcam: registering 64-bit DLL...');
  const r64 = await registerDllElevated(dll64, false);
  logToFile('registerVcam: 64-bit result: ' + JSON.stringify(r64));
  if (!r64.success) {
    lastVcamError = r64.error;
    return r64;
  }

  // Register 32-bit if present (for 32-bit OBS compatibility)
  if (fs.existsSync(dll32)) {
    logToFile('registerVcam: registering 32-bit DLL...');
    const r32 = await registerDllElevated(dll32, true);
    logToFile('registerVcam: 32-bit result: ' + JSON.stringify(r32));
    if (!r32.success) {
      // 32-bit failure is non-fatal — 64-bit OBS will still work
      logToFile('32-bit vcam registration failed (non-fatal): ' + r32.error);
    }
  }

  // Verify the driver actually appears in the registry
  logToFile('registerVcam: verifying registration...');
  const verified = await isVcamInstalled();
  logToFile('registerVcam: verified=' + verified);
  if (!verified) {
    lastVcamError = 'Registration reported success but the driver was not found in the registry. The DLL may be corrupted or a dependency is missing.';
    return { success: false, error: lastVcamError };
  }

  lastVcamError = null;
  logToFile('registerVcam: success');
  return { success: true };
}

async function unregisterVcam() {
  const base = path.join(getResourcesPath(), 'vcam');
  const dll64 = path.join(base, 'UnityCaptureFilter64.dll');
  const dll32 = path.join(base, 'UnityCaptureFilter32.dll');

  // Unregister 64-bit first
  if (fs.existsSync(dll64)) {
    const r64 = await unregisterDllElevated(dll64, false);
    if (!r64.success) {
      lastVcamError = r64.error;
      return r64;
    }
  }

  // Unregister 32-bit if present
  if (fs.existsSync(dll32)) {
    const r32 = await unregisterDllElevated(dll32, true);
    if (!r32.success) {
      // 32-bit failure is non-fatal
      logToFile('32-bit vcam unregistration failed (non-fatal): ' + r32.error);
    }
  }

  // Verify the driver is gone
  const stillInstalled = await isVcamInstalled();
  if (stillInstalled) {
    lastVcamError = 'Unregistration reported success but the driver is still in the registry.';
    return { success: false, error: lastVcamError };
  }

  lastVcamError = null;
  return { success: true };
}

// ─── Window Factory ──────────────────────────────────────────────────────────
function createWindow(show = true) {
  logToFile('createWindow called with show=' + show);
  const slotIndex = windows.size % 4;
  const windowNumber = slotIndex + 1;
  const windowTitle = `MultiCam${windowNumber}`;

  const iconPath = path.join(__dirname, 'assets', 'app icon.png');
  const hasIcon = fs.existsSync(iconPath);

  const win = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 700,
    minHeight: 480,
    center: true,
    title: windowTitle,
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
  win.setTitle(windowTitle);

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

  // Deny all window.open calls — the output window feature has been removed
  // (the virtual camera driver now handles OBS integration directly).
  win.webContents.setWindowOpenHandler(({ url }) => {
    logToFile('Blocked window.open: ' + url);
    return { action: 'deny' };
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
    win.webContents.send('window-title', windowTitle);
    win.webContents.send('process-pid', process.pid);

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

ipcMain.handle('vcam-check',      async () => isVcamInstalled());
ipcMain.handle('vcam-register',   async () => registerVcam());
ipcMain.handle('vcam-unregister', async () => unregisterVcam());
ipcMain.handle('vcam:diagnostics', async () => {
  const installed = await isVcamInstalled();
  return {
    installed,
    lastError: lastVcamError,
    dllPath64: path.join(getResourcesPath(), 'vcam', 'UnityCaptureFilter64.dll'),
    dllPath32: path.join(getResourcesPath(), 'vcam', 'UnityCaptureFilter32.dll'),
    dll64Exists: fs.existsSync(path.join(getResourcesPath(), 'vcam', 'UnityCaptureFilter64.dll')),
    dll32Exists: fs.existsSync(path.join(getResourcesPath(), 'vcam', 'UnityCaptureFilter32.dll')),
    appVersion: app.getVersion(),
    resourcesPath: getResourcesPath(),
  };
});

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

ipcMain.handle('settings:get', async () => appSettings);
ipcMain.handle('settings:set', async (e, patch) => {
  if (patch && typeof patch === 'object') {
    appSettings = { ...appSettings, ...patch };
    saveSettings(appSettings);
  }
  return appSettings;
});

// Read an image file and return a base64 data URL. Used by the greenscreen
// recent-images list to reload a previously selected background image.
ipcMain.handle('image:read', async (e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: 'Invalid file path' };
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : 'image/png';
    return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to read image file' };
  }
});

// Save a background image (as data URL) to the userData directory and return
// the saved file path. Used by the greenscreen recent-images feature so that
// image paths persist across restarts. The renderer can't access file.path
// on File objects due to context isolation, so we save the image content here.
ipcMain.handle('image:save', async (e, dataUrl, originalName) => {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return { ok: false, error: 'Invalid data URL' };
    }
    // Parse the data URL: data:<mime>;base64,<data>
    const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
    if (!m) return { ok: false, error: 'Unsupported image format' };
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const ext = mime === 'image/png' ? '.png'
      : mime === 'image/jpeg' ? '.jpg'
      : mime === 'image/gif' ? '.gif'
      : mime === 'image/webp' ? '.webp'
      : mime === 'image/bmp' ? '.bmp'
      : '.png';
    const dir = path.join(app.getPath('userData'), 'bg-images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const base = (typeof originalName === 'string' && originalName)
      ? path.parse(originalName).name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40)
      : 'bg';
    const stamp = Date.now();
    const filePath = path.join(dir, `${base}-${stamp}${ext}`);
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to save image' };
  }
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

// Exit App — closes the calling window. If it's the last window, quits the app.
ipcMain.handle('app:quit', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  logToFile('Exit App requested from window: ' + (win ? win.getTitle() : 'unknown'));

  if (windows.size > 1 && win && !win.isDestroyed()) {
    // Multiple windows open — only close this one, stop its scrcpy streams.
    // Window title is "MultiCam{N}" where N = slot + 1; scrcpy titles end with _{slot}.
    const slotMatch = win.getTitle().match(/MultiCam(\d+)/);
    const slot = slotMatch ? parseInt(slotMatch[1], 10) - 1 : -1;
    for (const title of [...scrcpyProcs.keys()]) {
      if (slot >= 0 && title.endsWith(`_${slot}`)) {
        stopScrcpy(title);
      }
    }
    win.close();
    return;
  }

  // Last window — quit the entire app
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
app.setAppUserModelId('com.multicam.viewer.' + process.pid);

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
    isInitializing = true;
    createSplash();
    // Delay the main window slightly so the splash is visible first and
    // doesn't get interfered with by the main window being created.
    setTimeout(() => {
      logToFile('Delayed main window creation');
      createWindow(false);
      isInitializing = false;
    }, 400);
  } else {
    logToFile('Splash disabled');
    createWindow(true);
  }
});

app.on('before-quit', stopAllScrcpy);
app.on('window-all-closed', () => {
  if (isInitializing || windows.size > 0) return;
  stopAllScrcpy();
  app.quit();
});
