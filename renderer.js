/**
 * MultiCam Viewer — Renderer Process
 *
 * Detects Android phones over USB (ADB) and captures their camera directly
 * via scrcpy — no companion app installed on the phone. The captured feed is:
 *   1. Shown in this window's preview
 *   2. Pushed to a UnityCapture virtual camera so OBS / Discord / etc. can use it
 *
 * Also lists any real UVC webcams (e.g. an Android 14+ phone in native
 * "USB Webcam" mode shows up here too).
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const deviceSelect       = document.getElementById('device-select');
const resSelect          = document.getElementById('res-select');
const cameraVideo        = document.getElementById('camera-video');
const videoWrap          = document.getElementById('video-wrap');
const cameraGrid         = document.getElementById('camera-grid');
const cameraPaneTemplate = document.getElementById('camera-pane-template');
const btnClosePane0      = document.getElementById('btn-close-pane-0');
const noCameraMsg        = document.getElementById('no-camera-msg');
const statusText         = document.getElementById('status-text');
const fpsDisplay         = document.getElementById('fps-display');
const vcamSlotDisplay    = document.getElementById('vcam-slot-display');
const vcamDot            = document.getElementById('vcam-dot');
const vcamStatusText     = document.getElementById('vcam-status-text');
const vcamBadge          = document.getElementById('vcam-badge');
const btnInstallVcam     = document.getElementById('btn-install-vcam');
const btnNewWindow       = document.getElementById('btn-new-window');
const btnNewWindowMenu   = document.getElementById('btn-new-window-menu');
const newCameraDropdown  = document.getElementById('new-camera-dropdown');
const btnNewSameWindow   = document.getElementById('btn-new-same-window');
const btnNewSeparate     = document.getElementById('btn-new-separate');
const btnRotate          = document.getElementById('btn-rotate');
const btnFlipCamera      = document.getElementById('btn-flip-camera');
const btnRefresh         = document.getElementById('btn-refresh');
const btnSettings        = document.getElementById('btn-settings');
const settingsOverlay    = document.getElementById('settings-overlay');
const btnCloseSettings   = document.getElementById('btn-close-settings');
const btnExitApp         = document.getElementById('btn-exit-app');
const helpToggle         = document.getElementById('help-toggle');
const helpContent        = document.getElementById('help-content');
const btnViewChangelog   = document.getElementById('btn-view-changelog');
const changelogOverlay   = document.getElementById('changelog-overlay');
const btnCloseChangelog  = document.getElementById('btn-close-changelog');
const hotkeysOverlay     = document.getElementById('hotkeys-overlay');
const btnCloseHotkeys    = document.getElementById('btn-close-hotkeys');
const btnViewHotkeys     = document.getElementById('btn-view-hotkeys');
const hotkeysTbody       = document.getElementById('hotkeys-tbody');
const keybindCustomizeList = document.getElementById('keybind-customize-list');
const btnResetKeybinds   = document.getElementById('btn-reset-keybinds');
const btnMinimize        = document.getElementById('btn-minimize');
const btnMaximize        = document.getElementById('btn-maximize');
const maximizeIcon       = document.getElementById('maximize-icon');
const restoreIcon        = document.getElementById('restore-icon');
const vcamCanvas         = document.getElementById('vcam-canvas');
const vcamInstallStatus  = document.getElementById('vcam-install-status');
const btnInstallVcamSettings   = document.getElementById('btn-install-vcam-settings');
const btnUninstallVcamSettings = document.getElementById('btn-uninstall-vcam-settings');
const btnVcamDiagnostics       = document.getElementById('btn-vcam-diagnostics');
const vcamDiagnosticsOutput    = document.getElementById('vcam-diagnostics-output');
const currentSlotDisplay = document.getElementById('current-slot-display');
const settingShowSplash  = document.getElementById('setting-show-splash');
const settingTheme       = document.getElementById('setting-theme');
const premiumStatusText = document.getElementById('premium-status-text');

// ─── Forum account DOM refs ──────────────────────────────────────────────────
const forumLoginForm    = document.getElementById('forum-login-form');
const forumProfile      = document.getElementById('forum-profile');
const forumEmailInput   = document.getElementById('forum-email-input');
const forumPasswordInput = document.getElementById('forum-password-input');
const btnForumLogin     = document.getElementById('btn-forum-login');
const btnForumRegister  = document.getElementById('btn-forum-register');
const btnForumLogout    = document.getElementById('btn-forum-logout');
const forumLoginStatus  = document.getElementById('forum-login-status');
const forumAvatar       = document.getElementById('forum-avatar');
const forumUsername     = document.getElementById('forum-username');
const forumEmailLabel   = document.getElementById('forum-email');
const forumRoleBadge    = document.getElementById('forum-role-badge');
const forumPremiumBadge = document.getElementById('forum-premium-badge');
const linkForumReset    = document.getElementById('link-forum-reset');

// ─── About / social DOM refs ─────────────────────────────────────────────────
const appVersionDisplay = document.getElementById('app-version-display');
const linkGithub        = document.getElementById('link-github');
const linkWebsite       = document.getElementById('link-website');
const linkDiscord       = document.getElementById('link-discord');

// ─── Green screen DOM refs ──────────────────────────────────────────────────
const btnGreenscreen     = document.getElementById('btn-greenscreen');
const btnGsOptions       = document.getElementById('btn-gs-options');
const gsBtnLabel         = document.getElementById('gs-btn-label');
const greenscreenControls = document.getElementById('greenscreen-controls');
const bgColorInput       = document.getElementById('bg-color');
const bgImageInput       = document.getElementById('bg-image');
const btnClearBg         = document.getElementById('btn-clear-bg');
const greenscreenBadge   = document.getElementById('greenscreen-badge');
const gsRecentImages     = document.getElementById('gs-recent-images');
const gsRecentList       = document.getElementById('gs-recent-list');
const stExposure         = document.getElementById('settings-exposure');
const stExposureVal      = document.getElementById('settings-exposure-val');
const stContrast         = document.getElementById('settings-contrast');
const stContrastVal      = document.getElementById('settings-contrast-val');
const stSaturation       = document.getElementById('settings-saturation');
const stSaturationVal    = document.getElementById('settings-saturation-val');
const settingsPreviewCanvas = document.getElementById('settings-preview-canvas');
const settingsPreviewEmpty  = document.getElementById('settings-preview-empty');
const settingsPreviewCtx = settingsPreviewCanvas
  ? settingsPreviewCanvas.getContext('2d', { alpha: false })
  : null;
let settingsPreviewRaf = null;

// ─── State ────────────────────────────────────────────────────────────────────
let currentStream    = null;
let vcamSlot         = 0;
let vcamDriverReady  = false;
let fpsInterval      = null;
let lastFpsTime      = Date.now();
let frameHandle      = null;    // id from requestVideoFrameCallback or requestAnimationFrame
let vcamCtx          = null;
let cameraRotation   = 0;        // user-facing rotation (rotate button cycles 0→90→180→270)
// The browser's <video> element applies the stream's orientation metadata
// automatically, so it displays correctly. But canvas.drawImage() does NOT
// apply that metadata — it draws raw sensor pixels, which for phone cameras
// are upside-down relative to the <video> view. This offset is added to
// cameraRotation only for the canvas draw path so the vcam/output matches the
// <video> preview without flipping the preview itself.
const CANVAS_ROTATION_OFFSET = 180;

// ─── Phase 1 frame-pipeline instrumentation ───────────────────────────────────
// Prefer requestVideoFrameCallback so we only do a GPU readback + IPC send when
// the source actually delivers a new video frame (instead of on every display
// refresh, which wastes work on high-refresh-rate monitors). Falls back to
// requestAnimationFrame where rVFC is unavailable.
const supportsRVFC = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let perfFrameCount = 0;         // frames actually delivered to the vcam since last sample
let perfReadbackMs = 0;         // EMA of getImageData() time (ms)
const PERF_HUD = false;         // flip to true to show readback timing in the FPS badge

// ─── Phase 2: WebGL2 GPU compositor (feature-flagged) ──────────────────────────
// When enabled AND available, the raw (non-greenscreen) frame path renders the
// video through a WebGL2 shader instead of the 2D canvas. The video is uploaded
// as a GPU texture (no CPU copy for the draw) and brightness/contrast/saturation
// are applied in the fragment shader (GPU) rather than via a 2D-canvas CSS filter
// (CPU composite). This is the foundation for the Phase 4 GPU effects (chroma
// key, LUTs, multi-layer). Greenscreen still uses the 2D canvas path for now.
//
// DEFAULTS TO OFF — the 2D path remains the safe default until this is verified
// end-to-end on Windows with a real camera + OBS. Flip to true to opt in.
const USE_WEBGL_COMPOSITOR = false;
let glCompositor = null;        // active GlCompositor instance, or null when 2D path in use

let frameUsedRVFC = false;
// useRVFC defaults to true (raw preview path, where the video is visible). The
// greenscreen path passes false because cameraVideo is hidden (display:none)
// during segmentation, and rVFC may not fire for non-composited video elements.
function scheduleFrame(cb, useRVFC = true) {
  const canRVFC = useRVFC && supportsRVFC && cameraVideo &&
    typeof cameraVideo.requestVideoFrameCallback === 'function';
  frameUsedRVFC = canRVFC;
  if (canRVFC) {
    frameHandle = cameraVideo.requestVideoFrameCallback(() => cb());
  } else {
    frameHandle = requestAnimationFrame(() => cb());
  }
}
function cancelFrame() {
  if (frameHandle == null) return;
  try {
    if (frameUsedRVFC) {
      cameraVideo.cancelVideoFrameCallback(frameHandle);
    } else {
      cancelAnimationFrame(frameHandle);
    }
  } catch {}
  frameHandle = null;
}
let activeScrcpyTitle = null;   // currently running scrcpy window title (if any)
let sourceOptions    = [];      // metadata for each dropdown option (by value)
let lastScrcpyError  = '';      // last error line from scrcpy output
let windowIndex      = 0;       // 0-based window index (0 = first window)
let processPid       = 0;       // PID of the Electron main process (for unique scrcpy titles)
let vcamNativeReady  = false;   // true when the shared-memory frame bridge is active

// ─── Same-window additional camera panes (CCTV grid) ──────────────────────────
const secondaryPanes = []; // { id, element, select, video, stream, scrcpyTitle }
let nextPaneId = 1;

// ─── Premium state ─────────────────────────────────────────────────────────────────────
let forumPremium = false; // true when the user has premium via PNKSOUNDS subscription
let forumPremiumSource = 'none'; // 'stripe', 'admin', or 'none'
let forumSubscription = null; // subscription details from entitlement check
let entitlementCheckTimer = null;

// ─── Green screen state ───────────────────────────────────────────────────────
let greenscreenEnabled = false;
let bgColorValue       = '#00ff00';
let bgImageElement     = null;
let selfieSegmentation = null;
let segmentationReady  = false;
let isSegmenting       = false;
let recentBgImages     = [];  // array of { path, name, thumbDataUrl } — max 5
let activeRecentIdx    = -1;  // index in recentBgImages currently loaded, or -1
let gsExposureValue    = 0;
let gsContrastValue    = 0;
let gsSaturationValue  = 0;

// ─── Video adjustment API ─────────────────────────────────────────────────────
function setVideoAdjustment(name, value) {
  const val = parseInt(value, 10);
  if (name === 'exposure') gsExposureValue = val;
  if (name === 'contrast') gsContrastValue = val;
  if (name === 'saturation') gsSaturationValue = val;
  // Keep the main settings panel in sync
  syncSlider(stExposure, stExposureVal, gsExposureValue);
  syncSlider(stContrast, stContrastVal, gsContrastValue);
  syncSlider(stSaturation, stSaturationVal, gsSaturationValue);
}
window.getVideoAdjustment = (name) => {
  if (name === 'exposure') return gsExposureValue;
  if (name === 'contrast') return gsContrastValue;
  if (name === 'saturation') return gsSaturationValue;
  return 0;
};
window.setVideoAdjustment = setVideoAdjustment;

function applySettings(settings) {
  if (settings.resolution && resSelect.querySelector(`option[value="${settings.resolution}"]`)) {
    resSelect.value = settings.resolution;
  }
  if (settings.greenscreenEnabled && isPremium()) {
    greenscreenEnabled = true;
    updateGreenscreenUI();
    initSegmentation();
  }
  if (settings.bgColor) {
    bgColorValue = settings.bgColor;
    bgColorInput.value = settings.bgColor;
  }
  if (settings.recentBgImagePaths) {
    initRecentBgImages(settings.recentBgImagePaths);
  }
  if (typeof settings.exposure === 'number') setVideoAdjustment('exposure', settings.exposure);
  if (typeof settings.contrast === 'number') setVideoAdjustment('contrast', settings.contrast);
  if (typeof settings.saturation === 'number') setVideoAdjustment('saturation', settings.saturation);
  if (typeof settings.showSplash === 'boolean') {
    settingShowSplash.checked = settings.showSplash;
  }
  if (settings.theme) {
    settingTheme.value = settings.theme;
    document.documentElement.setAttribute('data-theme', settings.theme);
    updateHeaderLogoForTheme(settings.theme);
  }
  // Merge saved hotkey bindings with defaults (so new actions in future
  // versions get their defaults without overwriting user customizations).
  if (settings.hotkeys && typeof settings.hotkeys === 'object') {
    activeHotkeys = { ...DEFAULT_HOTKEYS, ...settings.hotkeys };
  } else {
    // First launch — persist the defaults so customization is ready later
    activeHotkeys = { ...DEFAULT_HOTKEYS };
    saveSettingsDebounced({ hotkeys: activeHotkeys });
  }
}

// Swap the header wordmark logo for a light-mode variant when the light theme
// is active, so it stays legible on a light background.
function updateHeaderLogoForTheme(theme) {
  const appTitle = document.getElementById('app-title');
  if (!appTitle) return;
  if (theme === 'light') {
    appTitle.src = 'assets/MCVLOGO-header-lightmode.png?v=' + Date.now();
  } else {
    appTitle.src = 'assets/MCVLOGO-header.png?v=' + Date.now();
  }
}

let saveSettingsTimer = null;
function saveSettingsDebounced(patch) {
  if (!window.electronAPI) return;
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    window.electronAPI.setSettings(patch);
  }, 150);
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function init() {
  if (window.electronAPI) {
    window.electronAPI.onVcamSlot((slot) => {
      vcamSlot = slot;
      const label = slotLabel(slot);
      vcamSlotDisplay.textContent = `→ ${label}`;
      currentSlotDisplay.textContent = label;
    });
    window.electronAPI.onWindowIndex((idx) => {
      windowIndex = idx;
    });
    window.electronAPI.onProcessPid((pid) => {
      processPid = pid;
    });
    window.electronAPI.onWindowTitle((title) => {
      document.title = title;
    });
    window.electronAPI.onScrcpyExited((data) => {
      if (data.windowTitle === activeScrcpyTitle) {
        statusText.textContent = 'Phone capture stopped' +
          (data.code ? ` (scrcpy: ${(data.stderr || '').trim().split('\n').pop() || 'code ' + data.code})` : '');
        stopCamera();
      }
    });
    window.electronAPI.onScrcpyLog((data) => {
      if (data.windowTitle !== activeScrcpyTitle) return;
      const t = (data.text || '').toLowerCase();
      // Capture meaningful error lines for display
      if (t.includes('error') || t.includes('exception') || t.includes('could not') ||
          t.includes('failed') || t.includes('denied')) {
        lastScrcpyError = data.text.trim().split('\n').filter(Boolean).pop();
      }
    });

    // Load saved settings
    try {
      const settings = await window.electronAPI.getSettings();
      if (settings) applySettings(settings);
    } catch {}
    // Restore forum session (if still valid)
    checkForumSession();
  }

  await refreshSources();
  // Only auto-select the last used camera in the first window.
  // Additional windows start with no camera selected to avoid grabbing
  // the same device that is already in use by window 1.
  if (windowIndex === 0) {
    try {
      const settings = await window.electronAPI.getSettings();
      if (settings && settings.lastDeviceIndex !== '' &&
          [...deviceSelect.options].some(o => o.value === String(settings.lastDeviceIndex))) {
        deviceSelect.value = String(settings.lastDeviceIndex);
        startSelected();
      }
    } catch {}
  }
  await checkVirtualCameraDriver();

  // Auto-refresh when a UVC device is plugged/unplugged.
  // Use the debounced wrapper so a burst of devicechange events (common when
  // scrcpy starts or another window opens/closes a camera) only triggers one
  // refresh cycle instead of many concurrent ones.
  navigator.mediaDevices.addEventListener('devicechange', refreshSourcesDebounced);

  // If no phones were found on the first scan, retry periodically — the ADB
  // daemon may still be starting up after a cold reboot.
  if (sourceOptions.filter(s => s.kind === 'phone').length === 0) {
    let retries = 0;
    const retryScan = setInterval(async () => {
      await refreshSources();
      if (sourceOptions.filter(s => s.kind === 'phone').length > 0 || ++retries >= 6) {
        clearInterval(retryScan);
      }
    }, 5000);
  }
}

function slotLabel(slotIdx) {
  return slotIdx === 0 ? 'MultiCam' : `MultiCam ${slotIdx + 1}`;
}

// ─── Source Enumeration (phones via ADB + real UVC cameras) ───────────────────
const VIRTUAL_OUTPUT_ONLY = [
  'unity video capture', 'multicam', 'obs virtual camera', 'obs-camera',
  'manycam virtual', 'xsplit vcam', 'nvidia broadcast', 'snap camera',
];
function isVirtualOutputOnly(label) {
  if (!label) return false;
  const l = label.toLowerCase();
  return VIRTUAL_OUTPUT_ONLY.some(v => l.includes(v));
}

// Concurrency + debounce guard for refreshSources.
// Without this, rapid devicechange events (fired when scrcpy starts or when
// another window opens/closes a camera) cause multiple concurrent refreshSources
// calls, each making its own getUserMedia probe.  On Windows, concurrent
// getUserMedia calls that touch an in-use camera can deadlock the Chromium media
// pipeline, freezing every window — even after the problematic window is closed.
let refreshSourcesRunning = false;
let refreshSourcesQueued   = false;
let deviceLabelsObtained   = false; // true after the first successful getUserMedia probe

// Debounced wrapper used by the devicechange listener and retry timer.
let refreshSourcesTimer = null;
function refreshSourcesDebounced() {
  if (refreshSourcesTimer) clearTimeout(refreshSourcesTimer);
  refreshSourcesTimer = setTimeout(() => {
    refreshSourcesTimer = null;
    refreshSources();
  }, 500);
}

async function refreshSources() {
  // Concurrency guard — if a scan is already in progress, mark a re-run and
  // return.  The in-progress call will pick up the queued flag when it finishes.
  if (refreshSourcesRunning) {
    refreshSourcesQueued = true;
    return;
  }
  refreshSourcesRunning = true;
  try {
    await _refreshSourcesInner();
  } finally {
    refreshSourcesRunning = false;
    if (refreshSourcesQueued) {
      refreshSourcesQueued = false;
      // Run one more time to pick up the latest device state.
      refreshSources();
    }
  }
}

async function _refreshSourcesInner() {
  statusText.textContent = 'Scanning for phones…';
  sourceOptions = [];

  // 1) Phones over USB (ADB)
  let phones = [];
  let adbIssues = [];
  if (window.electronAPI) {
    const res = await window.electronAPI.listPhones();
    if (res.ok) {
      phones = res.phones || [];
      adbIssues = res.issues || [];
    } else {
      statusText.textContent = 'ADB error: ' + (res.error || 'unknown');
    }
  }

  // For each phone, list its cameras.  Only ONE dropdown entry is created per
  // phone ("Phone Camera"); front/back switching is handled by the flip button
  // in the toolbar (and its 'F' hotkey), which cycles the active camera within
  // the phone's `cameras` array rather than picking a separate list entry.
  for (const ph of phones) {
    let cams = [];
    const cr = await window.electronAPI.listPhoneCameras(ph.serial);
    if (cr.ok && cr.cameras.length) cams = cr.cameras;
    // Fallback if camera listing failed: assume one back camera
    if (!cams.length) cams = [{ id: '0', facing: 'back', maxRes: '' }];

    sourceOptions.push({
      kind: 'phone',
      serial: ph.serial,
      model: ph.model,
      cameras: cams,          // [{ id, facing, maxRes }, ...]
      currentCamIndex: 0,     // which entry in `cameras` is active
      label: ph.model || ph.serial || 'Phone Camera',
    });
  }

  // Rebuild main camera dropdown
  const prevValue = deviceSelect.value;
  while (deviceSelect.options.length > 1) deviceSelect.remove(1);
  sourceOptions.forEach((opt, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = opt.label;
    deviceSelect.appendChild(o);
  });

  if (prevValue && [...deviceSelect.options].some(o => o.value === prevValue)) {
    deviceSelect.value = prevValue;
  }

  // Rebuild every secondary pane's camera dropdown
  secondaryPanes.forEach(pane => populatePaneSelect(pane.select));

  if (sourceOptions.length === 0) {
    if (adbIssues.length) {
      statusText.textContent = adbIssues[0].message;
      showConnectionGuide();
    } else {
      statusText.textContent = 'No phone found — see guide below';
      showConnectionGuide();
    }
  } else {
    const nPhones = sourceOptions.length;
    const countMsg = `${nPhones} phone camera${nPhones > 1 ? 's' : ''} ready`;
    statusText.textContent = adbIssues.length
      ? `${countMsg} · ${adbIssues[0].message}`
      : countMsg;
    hideConnectionGuide();
  }
}

// ─── Connection Guide ─────────────────────────────────────────────────────────
function showConnectionGuide() {
  document.getElementById('connection-guide')?.classList.remove('hidden');
}
function hideConnectionGuide() {
  document.getElementById('connection-guide')?.classList.add('hidden');
}

// ─── Camera Start / Stop ──────────────────────────────────────────────────────
async function startSelected() {
  const idx = deviceSelect.value;
  if (idx === '' || idx === null) { await stopCamera(); return; }
  const opt = sourceOptions[Number(idx)];
  if (!opt) return;

  await stopCamera();
  // Brief pause to let the phone release the camera before we re-acquire it
  // with a new scrcpy process (e.g., on flip or resolution change). Without
  // this, the old scrcpy may still hold the camera and the new one fails or
  // hangs, crashing the preview.
  await new Promise(r => setTimeout(r, 400));
  hideConnectionGuide();

  if (opt.kind === 'phone') {
    await startPhoneCamera(opt);
  } else {
    await startUvcCamera(opt);
  }
  updateCameraControlButtons(opt);
}

// ── Phone camera via scrcpy + desktop capture ──
// `opt` is a one-per-phone entry; the active front/back camera is resolved from
// `opt.cameras[opt.currentCamIndex]`.  The flip button mutates currentCamIndex
// and re-enters here to restart scrcpy with the other camera.
async function startPhoneCamera(opt) {
  const cam = opt.cameras[opt.currentCamIndex] || opt.cameras[0];
  const resolution = resSelect.value || '1280x720';
  const windowTitle = `MultiCamCap_${processPid}_${opt.serial}_${cam.id}_${vcamSlot}`;
  activeScrcpyTitle = windowTitle;
  lastScrcpyError = '';

  statusText.textContent = `[1/3] Launching scrcpy for ${opt.model || opt.serial} (${cam.facing})…`;

  const start = await window.electronAPI.startScrcpy({
    serial: opt.serial,
    cameraId: cam.id,
    resolution,
    fps: 30,
    windowTitle,
  });

  if (!start.ok) {
    statusText.textContent = 'scrcpy failed to launch: ' + (start.error || 'unknown');
    return;
  }

  // Wait for the scrcpy window to appear, then capture it
  statusText.textContent = '[2/3] Waiting for phone video window…';
  const found = await waitForCaptureWindow(windowTitle, 15000);
  if (activeScrcpyTitle !== windowTitle) {
    // Selection changed mid-wait — the new selection manages its own scrcpy;
    // make sure this orphaned one is cleaned up.
    window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
    return;
  }
  if (!found) {
    // The scrcpy process is still running but produced no capturable window —
    // kill it so it doesn't linger invisibly off-screen.
    window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
    activeScrcpyTitle = null;
    statusText.textContent = lastScrcpyError
      ? 'scrcpy error: ' + lastScrcpyError
      : 'Phone video window did not appear. Watch the phone for a camera/permission prompt, then ↻ Refresh.';
    return;
  }

  // Capture the window via Windows Graphics Capture, with one retry
  statusText.textContent = '[3/3] Connecting to video…';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: found,
            maxFrameRate: 60,
          },
        },
      });
      attachStream(`${opt.model || opt.serial} · ${cam.facing}`);
      return;
    } catch (err) {
      if (attempt === 2) {
        // Never attached — tear down the scrcpy process we started.
        window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
        activeScrcpyTitle = null;
        statusText.textContent = 'Capture error: ' + err.message;
      } else {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
}

async function waitForCaptureWindow(title, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await window.electronAPI.findCaptureWindow(title);
    if (res.ok) return res.id;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ── Real UVC camera via getUserMedia ──
async function startUvcCamera(opt) {
  activeScrcpyTitle = null;
  const [w, h] = (resSelect.value || '1280x720').split('x').map(Number);
  statusText.textContent = 'Connecting to camera…';
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: opt.deviceId },
        width:  { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: 60, max: 60 },
      },
    });
    attachStream(opt.label.replace(/^­ƒÄÑ\s*/, ''));
  } catch (err) {
    statusText.textContent = 'Error: ' + err.message +
      (err.name === 'NotAllowedError' ? ' — check Windows Camera privacy settings' : '');
  }
}

// Apply the current cameraRotation to the main <video> element via CSS transform.
// For 90°/270°, the rotated video won't fill the container without a scale factor
// computed from the container and video aspect ratios.
function applyVideoRotation() {
  const deg = cameraRotation;
  if (deg === 0) {
    cameraVideo.style.transform = '';
  } else if (deg === 180) {
    cameraVideo.style.transform = 'rotate(180deg)';
  } else {
    // 90/270: compute scale so the rotated video fills the container
    const container = cameraVideo.parentElement;
    const cw = container ? container.clientWidth  : 0;
    const ch = container ? container.clientHeight : 0;
    const vw = cameraVideo.videoWidth  || cw || 1;
    const vh = cameraVideo.videoHeight || ch || 1;
    const scale = (cw && ch) ? Math.max(cw / vh, ch / vw) : 1;
    cameraVideo.style.transform = `rotate(${deg}deg) scale(${scale.toFixed(3)})`;
  }
  // The vcam canvas pixels include CANVAS_ROTATION_OFFSET (for correct output),
  // but when displayed as the greenscreen preview the canvas needs a CSS
  // counter-rotation so the preview matches the <video> element's orientation.
  // captureStream()/getImageData() read raw pixels, so the output is unaffected.
  applyCanvasCounterRotation();
}

// Apply a CSS counter-rotation to vcamCanvas so its display matches cameraVideo.
// The canvas pixels are rotated by (cameraRotation + OFFSET) for correct output;
// the CSS removes the OFFSET portion for display only.
function applyCanvasCounterRotation() {
  const deg = (CANVAS_ROTATION_OFFSET) % 360;
  if (deg === 0) {
    vcamCanvas.style.transform = '';
    return;
  }
  if (deg === 180) {
    vcamCanvas.style.transform = 'rotate(180deg)';
    return;
  }
  // 90/270: compute scale so the rotated canvas fills the container
  const container = vcamCanvas.parentElement;
  const cw = container ? container.clientWidth  : 0;
  const ch = container ? container.clientHeight : 0;
  const vw = vcamCanvas.width  || cw || 1;
  const vh = vcamCanvas.height || ch || 1;
  const scale = (cw && ch) ? Math.max(cw / vh, ch / vw) : 1;
  vcamCanvas.style.transform = `rotate(${deg}deg) scale(${scale.toFixed(3)})`;
}

// ── Common: attach a stream to the preview + start outputs ──
function attachStream(name) {
  cameraVideo.srcObject = currentStream;
  cameraVideo.classList.add('active');
  noCameraMsg.style.display = 'none';
  applyVideoRotation();

  cameraVideo.onloadedmetadata = () => {
    const vt = currentStream.getVideoTracks()[0];
    const s  = vt.getSettings();
    statusText.textContent = `Live: ${s.width || '?'}×${s.height || '?'} · ${name}`;
    updateGreenscreenUI();
  };
  cameraVideo.onplaying = () => {
    startVcamOutput();
  };
  cameraVideo.onresize = () => {
    if (currentStream) startVcamOutput();
  };
  startFpsCounter();
}

async function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (activeScrcpyTitle && window.electronAPI) {
    await window.electronAPI.stopScrcpy(activeScrcpyTitle);
    activeScrcpyTitle = null;
  }
  cameraVideo.srcObject = null;
  cameraVideo.classList.remove('active');
  cameraVideo.style.transform = '';
  vcamCanvas.style.transform = '';
  noCameraMsg.style.display = 'flex';
  stopFpsCounter();
  stopVcamOutput();
  updateGreenscreenUI();
  updateCameraControlButtons(null);
}

// Enable/disable the rotate and flip buttons based on the active camera.
// Rotate is enabled for any active camera. Flip is enabled only for phone
// cameras that expose more than one camera (front + back) in their `cameras` array.
function updateCameraControlButtons(opt) {
  if (!opt) {
    btnRotate.disabled = true;
    btnFlipCamera.disabled = true;
    return;
  }
  btnRotate.disabled = false;
  if (opt.kind !== 'phone') {
    btnFlipCamera.disabled = true;
    return;
  }
  btnFlipCamera.disabled = opt.cameras.length < 2;
}

// ─── Same-window additional camera panes (CCTV grid) ──────────────────────────
function getSecondaryPane(id) {
  return secondaryPanes.find(p => p.id === id);
}

function populatePaneSelect(select) {
  const prevValue = select.value;
  while (select.options.length > 1) select.remove(1);
  sourceOptions.forEach((opt, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = opt.label;
    select.appendChild(o);
  });
  if (prevValue && [...select.options].some(o => o.value === prevValue)) {
    select.value = prevValue;
  }
}

function updateCameraGrid() {
  const count = 1 + secondaryPanes.length;
  cameraGrid.className = 'camera-grid grid-' + Math.min(count, 4);
}

function addSecondaryPane() {
  newCameraDropdown.classList.add('hidden');
  const total = 1 + secondaryPanes.length;
  const maxPanes = isPremium() ? 4 : 2; // 2 free, 4 with premium
  if (total >= maxPanes) {
    if (!isPremium()) {
      statusText.textContent = 'Upgrade to Premium to add more than 2 cameras';
      settingsOverlay.classList.remove('hidden');
    } else {
      statusText.textContent = 'Maximum 4 cameras per window reached';
    }
    return;
  }

  const id = nextPaneId++;
  const clone = cameraPaneTemplate.content.cloneNode(true);
  const pane = clone.querySelector('.camera-pane');
  pane.dataset.pane = String(id);
  pane.id = 'camera-pane-' + id;
  const select = pane.querySelector('.camera-pane-select');
  select.id = 'device-select-' + id;
  const video = pane.querySelector('video');
  video.id = 'camera-video-' + id;
  const closeBtn = pane.querySelector('.btn-close-pane');
  closeBtn.id = 'btn-close-pane-' + id;

  populatePaneSelect(select);
  select.value = '';
  select.addEventListener('change', () => startSecondaryPaneCamera(id));
  closeBtn.addEventListener('click', () => removeSecondaryPane(id));

  cameraGrid.appendChild(pane);
  secondaryPanes.push({ id, element: pane, select, video, stream: null, scrcpyTitle: null });
  updateCameraGrid();
  statusText.textContent = 'Select a camera for the new pane';
}

function removeSecondaryPane(id) {
  const pane = getSecondaryPane(id);
  if (!pane) return;
  stopSecondaryPaneCamera(id);
  pane.element.remove();
  const idx = secondaryPanes.findIndex(p => p.id === id);
  if (idx !== -1) secondaryPanes.splice(idx, 1);
  updateCameraGrid();
}

function startSecondaryPaneCamera(id) {
  const pane = getSecondaryPane(id);
  if (!pane) return;
  const idx = pane.select.value;
  if (idx === '' || idx === null) { stopSecondaryPaneCamera(id); return; }
  const opt = sourceOptions[Number(idx)];
  if (!opt) return;

  stopSecondaryPaneCamera(id);

  if (opt.kind === 'phone') {
    startSecondaryPhoneCamera(pane, opt);
  } else {
    startSecondaryUvcCamera(pane, opt);
  }
}

async function startSecondaryPhoneCamera(pane, opt) {
  const cam = opt.cameras[opt.currentCamIndex] || opt.cameras[0];
  const resolution = resSelect.value || '1280x720';
  const windowTitle = `MultiCamCap${processPid}_${pane.id}_${opt.serial}_${cam.id}_${vcamSlot}`;
  pane.scrcpyTitle = windowTitle;

  const start = await window.electronAPI.startScrcpy({
    serial: opt.serial,
    cameraId: cam.id,
    resolution,
    fps: 30,
    windowTitle,
  });

  if (!start.ok) {
    statusText.textContent = `Camera ${pane.id} failed: ` + (start.error || 'unknown');
    pane.scrcpyTitle = null;
    return;
  }

  const found = await waitForCaptureWindow(windowTitle, 15000);
  if (pane.scrcpyTitle !== windowTitle) {
    // Pane selection changed mid-wait — clean up this orphaned scrcpy.
    window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
    return;
  }
  if (!found) {
    // No capturable window appeared — kill the lingering scrcpy process.
    window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
    pane.scrcpyTitle = null;
    statusText.textContent = `Camera ${pane.id} window did not appear`;
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      pane.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: found,
            maxFrameRate: 60,
          },
        },
      });
      pane.video.srcObject = pane.stream;
      return;
    } catch (err) {
      if (attempt === 2) {
        // Never attached — tear down the scrcpy process we started.
        window.electronAPI?.stopScrcpy(windowTitle).catch(() => {});
        pane.scrcpyTitle = null;
        statusText.textContent = `Camera ${pane.id} capture error: ` + err.message;
      } else {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
}

async function startSecondaryUvcCamera(pane, opt) {
  const [w, h] = (resSelect.value || '1280x720').split('x').map(Number);
  try {
    pane.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: opt.deviceId },
        width:  { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: 60, max: 60 },
      },
    });
    pane.video.srcObject = pane.stream;
  } catch (err) {
    statusText.textContent = `Camera ${pane.id} error: ` + err.message;
  }
}

function stopSecondaryPaneCamera(id) {
  const pane = getSecondaryPane(id);
  if (!pane) return;
  if (pane.stream) {
    pane.stream.getTracks().forEach(t => t.stop());
    pane.stream = null;
  }
  if (pane.scrcpyTitle && window.electronAPI) {
    window.electronAPI.stopScrcpy(pane.scrcpyTitle);
    pane.scrcpyTitle = null;
  }
  pane.video.srcObject = null;
}

function closeAllSecondaryPanes() {
  [...secondaryPanes].forEach(p => removeSecondaryPane(p.id));
}

function isPremium() {
  return forumPremium;
}

function updatePremiumUI() {
  if (!premiumStatusText) return;
  if (isPremium()) {
    let label = 'Premium active: up to 4 cameras';
    if (forumPremiumSource === 'stripe') {
      label += ' (subscription)';
    } else if (forumPremiumSource === 'admin') {
      label += ' (admin grant)';
    }
    premiumStatusText.textContent = label;
    premiumStatusText.style.color = 'var(--green)';
  } else {
    premiumStatusText.textContent = 'Free plan: up to 2 cameras';
    premiumStatusText.style.color = 'var(--text-muted)';
  }
  updatePremiumGating();
}

function showPremiumUpgrade(message) {
  statusText.textContent = message || 'Premium feature — sign in with your PNKSOUNDS account to unlock';
  settingsOverlay.classList.remove('hidden');
}

function updatePremiumGating() {
  const premium = isPremium();
  const gated = document.querySelectorAll('.premium-gated');
  gated.forEach(el => {
    el.classList.toggle('premium-locked', !premium);
    el.querySelectorAll('input, button').forEach(input => { input.disabled = !premium; });
  });
}

// Forum account
// The forum at pnksounds.dev is the identity provider. Login runs in the main
// process; the JWT is persisted there via Electron safeStorage. The renderer
// only receives the public user profile (never the raw token) unless a future
// Supabase integration needs it.

let forumUser = null; // current ForumUser or null

function renderForumProfile(user) {
  forumUser = user;
  if (!user) {
    forumLoginForm.classList.remove('hidden');
    forumProfile.classList.add('hidden');
    forumEmailInput.value = '';
    forumPasswordInput.value = '';
    forumLoginStatus.textContent = '';
    forumLoginStatus.classList.remove('error', 'success');
    return;
  }
  forumLoginForm.classList.add('hidden');
  forumProfile.classList.remove('hidden');
  forumUsername.textContent = user.username || 'Forum user';
  forumEmailLabel.textContent = user.email || '';
  if (user.avatar) {
    forumAvatar.src = user.avatar;
    forumAvatar.hidden = false;
  } else {
    forumAvatar.hidden = true;
    forumAvatar.removeAttribute('src');
  }
  // Role badge
  let role = '';
  if (user.isAdmin) role = 'Admin';
  else if (user.isStaff) role = 'Staff';
  if (role) {
    forumRoleBadge.textContent = role;
    forumRoleBadge.classList.remove('hidden');
  } else {
    forumRoleBadge.classList.add('hidden');
    forumRoleBadge.textContent = '';
  }
}

async function checkForumSession() {
  if (!window.electronAPI || !window.electronAPI.forumGetSession) return;
  try {
    const result = await window.electronAPI.forumGetSession();
    if (result && result.ok && result.user) {
      renderForumProfile(result.user);
      // Check premium entitlement now that we have a session.
      await checkForumPremium(result.user);
    } else {
      renderForumProfile(null);
      forumPremium = false;
      forumPremiumSource = 'none';
      forumSubscription = null;
      updatePremiumUI();
    }
  } catch (err) {
    console.warn('[forum] session restore failed:', err);
  }
}

// Query the PNKSOUNDS API to see if the user has premium for this app.
// Admin/staff users automatically get premium. Otherwise, a Stripe subscription
// or admin grant unlocks premium.
async function checkForumPremium(sessionUser) {
  if (!window.electronAPI || !window.electronAPI.forumCheckPremium) return;

  // If admin/staff flags aren't in the session user, try verifying the token
  // to fetch the full user object with admin flags from the API.
  if (sessionUser && !sessionUser.isAdmin && !sessionUser.isStaff && window.electronAPI.forumVerifyToken) {
    try {
      const verified = await window.electronAPI.forumVerifyToken();
      if (verified && verified.ok && verified.user) {
        sessionUser = verified.user;
        renderForumProfile(sessionUser);
      }
    } catch {}
  }

  // Auto-grant premium for admin/staff users (owner/dev access)
  if (sessionUser && (sessionUser.isAdmin || sessionUser.isStaff)) {
    const wasPremium = isPremium();
    forumPremium = true;
    forumPremiumSource = 'admin';
    forumSubscription = null;
    if (forumPremiumBadge) forumPremiumBadge.classList.remove('hidden');
    updatePremiumUI();
    if (!wasPremium && isPremium() && greenscreenEnabled) {
      initSegmentation();
    }
    return;
  }

  try {
    const result = await window.electronAPI.forumCheckPremium();
    const wasPremium = isPremium();

    // If not authenticated, the session expired — show login form
    if (result && !result.authenticated) {
      forumPremium = false;
      forumPremiumSource = 'none';
      forumSubscription = null;
      if (forumPremiumBadge) forumPremiumBadge.classList.add('hidden');
      renderForumProfile(null);
      updatePremiumUI();
      return;
    }

    forumPremium = !!(result && result.premium);
    forumPremiumSource = (result && result.source) || 'none';
    forumSubscription = (result && result.subscription) || null;
    if (forumPremiumBadge) forumPremiumBadge.classList.toggle('hidden', !forumPremium);
    updatePremiumUI();
    // If premium was just granted via forum, make sure greenscreen can be used.
    if (!wasPremium && isPremium() && greenscreenEnabled) {
      initSegmentation();
    }
  } catch (err) {
    console.warn('[forum] premium check failed:', err);
  }
}

async function doForumLogin() {
  const email = forumEmailInput.value.trim();
  const password = forumPasswordInput.value;
  if (!email || !password) {
    forumLoginStatus.textContent = 'Enter your email and password.';
    forumLoginStatus.classList.add('error');
    forumLoginStatus.classList.remove('success');
    return;
  }
  btnForumLogin.disabled = true;
  forumLoginStatus.textContent = 'Signing in…';
  forumLoginStatus.classList.remove('error', 'success');
  try {
    const result = await window.electronAPI.forumLogin(email, password);
    if (result && result.ok && result.user) {
      forumLoginStatus.textContent = '';
      forumPasswordInput.value = '';
      renderForumProfile(result.user);
      // Check premium entitlement immediately after login.
      await checkForumPremium(result.user);
    } else {
      forumLoginStatus.textContent = (result && result.error) || 'Login failed.';
      forumLoginStatus.classList.add('error');
    }
  } catch (err) {
    forumLoginStatus.textContent = err.message || 'Login failed.';
    forumLoginStatus.classList.add('error');
  } finally {
    btnForumLogin.disabled = false;
  }
}

async function doForumLogout() {
  try {
    await window.electronAPI.forumLogout();
  } catch {}
  forumPremium = false;
  forumPremiumSource = 'none';
  forumSubscription = null;
  if (forumPremiumBadge) forumPremiumBadge.classList.add('hidden');
  updatePremiumUI();
  renderForumProfile(null);
}

async function openForumRegister() {
  try {
    const url = await window.electronAPI.forumGetRegisterUrl();
    if (url) window.electronAPI.openExternal(url);
  } catch {}
}

async function openForumReset() {
  try {
    const url = await window.electronAPI.forumGetResetUrl();
    if (url) window.electronAPI.openExternal(url);
  } catch {}
}

function toggleNewCameraDropdown() {
  newCameraDropdown.classList.toggle('hidden');
}

function openNewCameraSeparate() {
  newCameraDropdown.classList.add('hidden');
  if (!isPremium()) {
    showPremiumUpgrade('Opening a separate MultiCam window is a Premium feature — sign in with your PNKSOUNDS account to unlock');
    return;
  }
  window.electronAPI?.openNewWindow();
}

// ─── FPS Counter ──────────────────────────────────────────────────────────────
function startFpsCounter() {
  perfFrameCount = 0;
  lastFpsTime    = Date.now();
  if (fpsInterval) clearInterval(fpsInterval);
  // Report the number of frames actually pushed to the virtual camera (counted
  // in the frame loops below), not the number of display refreshes. This gives
  // a truthful FPS reading and reflects the source's real cadence.
  fpsInterval = setInterval(() => {
    const dt = (Date.now() - lastFpsTime) / 1000;
    const fps = dt > 0 ? Math.round(perfFrameCount / dt) : 0;
    fpsDisplay.textContent = PERF_HUD
      ? `${fps} FPS · ${perfReadbackMs.toFixed(1)}ms rb`
      : `${fps} FPS`;
    perfFrameCount = 0;
    lastFpsTime    = Date.now();
  }, 1000);
}
function stopFpsCounter() {
  if (fpsInterval) { clearInterval(fpsInterval); fpsInterval = null; }
  fpsDisplay.textContent = '';
}

// ─── Phase 2: WebGL2 GPU compositor ───────────────────────────────────────────
// Renders a video element to the vcam canvas via a full-screen textured quad
// with a brightness/contrast/saturation fragment shader, then reads the pixels
// back into a reusable top-down RGBA buffer for the virtual camera.
//
// Correctness notes (the fiddly WebGL Y-convention):
//  - UNPACK_FLIP_Y_WEBGL=true on upload → the canvas renders the video
//    right-side up (important because the output window captures this canvas).
//  - gl.readPixels reads bottom-up (OpenGL origin is bottom-left), so the
//    returned buffer is flipped in place to top-down row order, which is what
//    UnityCapture expects (matching the 2D-canvas getImageData output).
//
// This is only used for the raw frame path. Greenscreen still composites on the
// 2D canvas (see startSegmentationLoop / onSegmentationResults).
const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_brightness; // 1.0 = neutral
uniform float u_contrast;   // 1.0 = neutral
uniform float u_saturation; // 1.0 = neutral
in vec2 v_uv;
out vec4 frag;
vec3 adjust(vec3 c) {
  c *= u_brightness;
  c = (c - 0.5) * u_contrast + 0.5;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, u_saturation);
  return clamp(c, 0.0, 1.0);
}
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  frag = vec4(adjust(c), 1.0);
}`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

// In-place vertical row flip of an RGBA8 buffer (bottom-up → top-down).
function flipRowsVertical(buf, width, height) {
  const rowBytes = width * 4;
  const tmp = new Uint8Array(rowBytes);
  for (let i = 0, j = height - 1; i < j; i++, j--) {
    const a = i * rowBytes, b = j * rowBytes;
    tmp.set(buf.subarray(a, a + rowBytes));
    buf.copyWithin(a, b, b + rowBytes);
    buf.set(tmp, b);
  }
}

// Create a GlCompositor for the given canvas + dimensions. Returns null if
// WebGL2 is unavailable or context/program creation fails (caller falls back to
// the 2D canvas path).
function tryCreateGlCompositor(canvas, width, height) {
  let gl;
  try {
    gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  } catch { gl = null; }
  if (!gl) return null;
  try {
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    // Full-screen quad (two triangles)
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const uBrightness = gl.getUniformLocation(prog, 'u_brightness');
    const uContrast   = gl.getUniformLocation(prog, 'u_contrast');
    const uSaturation = gl.getUniformLocation(prog, 'u_saturation');

    const readBuf = new Uint8Array(width * height * 4);

    return {
      _gl: gl,
      _prog: prog,
      _vao: vao,
      _vbo: vbo,
      _tex: tex,
      _uB: uBrightness, _uC: uContrast, _uS: uSaturation,
      _w: width, _h: height,
      _readBuf: readBuf,
      setAdjust(exposure, contrast, saturation) {
        // Match the 2D path: 1 + value/100 (value range -100..100).
        this._brightness = 1 + (exposure / 100);
        this._contrast   = 1 + (contrast / 100);
        this._saturation = 1 + (saturation / 100);
      },
      draw(video) {
        const gl = this._gl;
        gl.viewport(0, 0, this._w, this._h);
        gl.useProgram(this._prog);
        gl.bindTexture(gl.TEXTURE_2D, this._tex);
        // texImage2D from a video element uploads the current frame to the GPU.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this._w, this._h, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.uniform1f(this._uB, this._brightness || 1);
        gl.uniform1f(this._uC, this._contrast || 1);
        gl.uniform1f(this._uS, this._saturation || 1);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
      },
      readPixels() {
        const gl = this._gl;
        gl.readPixels(0, 0, this._w, this._h, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);
        flipRowsVertical(this._readBuf, this._w, this._h);
        return this._readBuf.buffer;
      },
      dispose() {
        try {
          this._gl.deleteTexture(this._tex);
          this._gl.deleteBuffer(this._vbo);
          this._gl.deleteVertexArray(this._vao);
          this._gl.deleteProgram(this._prog);
          const ext = this._gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
        } catch {}
      },
    };
  } catch (err) {
    console.error('WebGL2 compositor init failed, falling back to 2D:', err);
    try {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch {}
    return null;
  }
}

// ─── Virtual Camera Output (UnityCapture) ─────────────────────────────────────
let vcamNativeAvailable = false;
let vcamRgbaTemp = null; // reusable RGBA buffer for conversion

async function startVcamOutput() {
  if (!currentStream) return;
  // Use actual video element dimensions if available, fall back to track settings
  const s = currentStream.getVideoTracks()[0].getSettings();
  const vw = cameraVideo.videoWidth  || s.width  || 1280;
  const vh = cameraVideo.videoHeight || s.height || 720;
  // For 90°/270° effective canvas rotations, the output canvas dimensions are
  // swapped so the rotated frame fills the canvas without cropping. Uses the
  // effective rotation (cameraRotation + offset) since that's what drawVideoRotated applies.
  const effRot = (cameraRotation + CANVAS_ROTATION_OFFSET) % 360;
  const rotated = (effRot === 90 || effRot === 270);
  const w = rotated ? vh : vw;
  const h = rotated ? vw : vh;

  vcamCanvas.width = w; vcamCanvas.height = h;

  // Phase 2: prefer the WebGL2 GPU compositor for the raw path when enabled.
  // Greenscreen still composites on the 2D canvas, so don't create the GL
  // compositor when greenscreen is active — startFrameLoop will acquire a 2D
  // context instead. tryCreateGlCompositor returns null if WebGL2 is missing,
  // in which case we fall back to the 2D canvas path.
  // Also bypass the GL compositor when the effective canvas rotation is non-zero
  // — the 2D path handles rotation via drawVideoRotated(); adding rotation to
  // the shader is not worth the complexity for a user-applied effect.
  const effRotZero = ((cameraRotation + CANVAS_ROTATION_OFFSET) % 360) === 0;
  if (USE_WEBGL_COMPOSITOR && !greenscreenEnabled && effRotZero) {
    glCompositor = tryCreateGlCompositor(vcamCanvas, w, h);
  } else {
    glCompositor = null;
  }
  if (!glCompositor) {
    vcamCtx = vcamCanvas.getContext('2d', { willReadFrequently: true });
  } else {
    vcamCtx = null; // GL path owns the canvas; 2D context not needed
  }

  if (vcamDriverReady) {
    // Check if the native addon is available
    try {
      const avail = await window.electronAPI.vcamAvailable();
      vcamNativeAvailable = !!avail.available;
    } catch { vcamNativeAvailable = false; }

    if (vcamNativeAvailable) {
      // Initialize shared memory via the native addon in the main process
      try {
        const result = await window.electronAPI.vcamInit({ slot: vcamSlot, width: w, height: h });
        if (result.ok) {
          vcamNativeReady = true;
          vcamBadge.classList.remove('hidden');
          setVcamStatus('green', `Virtual Camera active — ${slotLabel(vcamSlot)}`);
        } else {
          vcamNativeReady = false;
          vcamBadge.classList.add('hidden');
          setVcamStatus('yellow', 'Driver registered but shared memory init failed — use OBS Window Capture');
        }
      } catch (err) {
        vcamNativeReady = false;
        vcamBadge.classList.add('hidden');
        setVcamStatus('yellow', 'Virtual cam init error — use OBS Window Capture');
      }
    } else {
      vcamNativeReady = false;
      vcamBadge.classList.add('hidden');
      setVcamStatus('yellow', 'Native addon not built — use OBS Window Capture');
    }
    startFrameLoop(w, h);
  } else {
    // No driver installed yet: still run the preview loop so green screen works
    startFrameLoop(w, h);
  }
}

function startFrameLoop(w, h) {
  cancelFrame();
  if (greenscreenEnabled && segmentationReady) {
    // Greenscreen composites on the 2D canvas. If the GL compositor was active
    // for the raw path, release it and acquire a 2D context for segmentation.
    if (glCompositor) { glCompositor.dispose(); glCompositor = null; }
    if (!vcamCtx) vcamCtx = vcamCanvas.getContext('2d', { willReadFrequently: true });
    startSegmentationLoop();
  } else if (glCompositor) {
    startGlRawFrameLoop(w, h);
  } else {
    startRawFrameLoop(w, h);
  }
}

function startGlRawFrameLoop(w, h) {
  function draw() {
    if (!currentStream || !glCompositor) return;
    glCompositor.setAdjust(gsExposureValue, gsContrastValue, gsSaturationValue);
    glCompositor.draw(cameraVideo);
    sendFrameToVcam(w, h);
    perfFrameCount++;
    scheduleFrame(draw);
  }
  scheduleFrame(draw);
}

function setVideoFilters(ctx) {
  const exposure = 1 + (gsExposureValue / 100);
  const contrast = 1 + (gsContrastValue / 100);
  const saturation = 1 + (gsSaturationValue / 100);
  ctx.filter = `brightness(${exposure}) contrast(${contrast}) saturate(${saturation})`;
}

// ─── Settings live preview ────────────────────────────────────────────────────
// Draws a small live feed under Video Adjustments so users can tune exposure /
// contrast / saturation without the main camera being fully obscured.
function stopSettingsPreview() {
  if (settingsPreviewRaf != null) {
    cancelAnimationFrame(settingsPreviewRaf);
    settingsPreviewRaf = null;
  }
}

function drawSettingsPreviewFrame() {
  if (!settingsPreviewCanvas || !settingsPreviewCtx) return;

  const hasCamera = !!(currentStream && cameraVideo && cameraVideo.readyState >= 2);
  if (settingsPreviewEmpty) {
    settingsPreviewEmpty.classList.toggle('hidden', hasCamera);
    settingsPreviewEmpty.textContent = hasCamera ? '' : 'No camera selected';
  }
  if (!hasCamera) {
    settingsPreviewCtx.clearRect(0, 0, settingsPreviewCanvas.width || 1, settingsPreviewCanvas.height || 1);
    return;
  }

  // Prefer the processed output canvas when green screen is active (already filtered).
  const useProcessed = greenscreenEnabled && vcamCanvas && vcamCanvas.width > 0 && vcamCanvas.classList.contains('active');
  const src = useProcessed ? vcamCanvas : cameraVideo;
  const srcW = useProcessed ? vcamCanvas.width : (cameraVideo.videoWidth || 1280);
  const srcH = useProcessed ? vcamCanvas.height : (cameraVideo.videoHeight || 720);
  if (!srcW || !srcH) return;

  // Keep preview canvas resolution modest for performance.
  const maxW = 480;
  const scale = Math.min(1, maxW / srcW);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  if (settingsPreviewCanvas.width !== w || settingsPreviewCanvas.height !== h) {
    settingsPreviewCanvas.width = w;
    settingsPreviewCanvas.height = h;
  }

  settingsPreviewCtx.save();
  if (useProcessed) {
    // Processed path already includes exposure/contrast/saturation + GS.
    settingsPreviewCtx.filter = 'none';
  } else {
    setVideoFilters(settingsPreviewCtx);
  }
  settingsPreviewCtx.drawImage(src, 0, 0, w, h);
  settingsPreviewCtx.restore();
  settingsPreviewCtx.filter = 'none';
}

function settingsPreviewLoop() {
  if (!settingsOverlay || settingsOverlay.classList.contains('hidden')) {
    settingsPreviewRaf = null;
    return;
  }
  drawSettingsPreviewFrame();
  settingsPreviewRaf = requestAnimationFrame(settingsPreviewLoop);
}

function startSettingsPreview() {
  if (!settingsPreviewCanvas || !settingsPreviewCtx) return;
  stopSettingsPreview();
  settingsPreviewRaf = requestAnimationFrame(settingsPreviewLoop);
}

function openSettings() {
  settingsOverlay.classList.remove('hidden');
  populateKeybindCustomizeList();
  startSettingsPreview();
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  if (capturingAction) cancelKeybindCapture();
  stopSettingsPreview();
}

// Send RGBA frame data to the virtual camera via IPC
// UnityCapture expects RGBA8 (format=0), top-down row order
// The DirectShow filter converts RGBA→BGRA and handles bottom-up output internally
//
// Backpressure: if the previous frame's IPC hasn't been consumed by the main
// process yet, we DROP this frame rather than queuing another multi-MB readback
// + clone. This keeps memory and latency bounded under load and lets the source
// cadence (rVFC) naturally throttle us. The virtual camera keeps the most
// recently written frame until the next one arrives, so dropping is the right
// policy (drop-old would be wrong here — we want the freshest frame to win).
let vcamFrameInFlight = false;
function sendFrameToVcam(width, height) {
  if (!vcamNativeReady) return;
  if (vcamFrameInFlight) return; // main process still writing the previous frame
  vcamFrameInFlight = true;
  const t0 = performance.now();
  // Phase 2: read back from the WebGL2 compositor's reusable buffer when active
  // (single readPixels + in-place Y-flip), otherwise from the 2D canvas.
  let buf;
  if (glCompositor) {
    buf = glCompositor.readPixels();
  } else {
    const img = vcamCtx.getImageData(0, 0, width, height);
    buf = img.data.buffer;
  }
  // Exponential moving average of the GPU→CPU readback cost (dev perf HUD).
  perfReadbackMs += (performance.now() - t0 - perfReadbackMs) * 0.1;
  window.electronAPI
    .vcamFrame({ slot: vcamSlot, data: buf })
    .catch(() => {})
    .finally(() => { vcamFrameInFlight = false; });
}

// Draw a video element to a 2D canvas context with the effective canvas
// rotation (cameraRotation + CANVAS_ROTATION_OFFSET). The offset corrects for
// the phone sensor orientation that the <video> element handles automatically
// but canvas.drawImage does not.
// w/h are the canvas dimensions (already swapped for 90/270 in startVcamOutput).
function drawVideoRotated(ctx, video, w, h) {
  const deg = (cameraRotation + CANVAS_ROTATION_OFFSET) % 360;
  if (deg === 0) {
    ctx.drawImage(video, 0, 0, w, h);
    return;
  }
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(deg * Math.PI / 180);
  if (deg === 90 || deg === 270) {
    // After rotating 90/270, the video's w/h are swapped relative to the canvas
    ctx.drawImage(video, -h / 2, -w / 2, h, w);
  } else {
    // 180: same dimensions
    ctx.drawImage(video, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

function startRawFrameLoop(w, h) {
  function draw() {
    if (!currentStream || !vcamCtx) return;
    setVideoFilters(vcamCtx);
    drawVideoRotated(vcamCtx, cameraVideo, w, h);
    vcamCtx.filter = 'none';
    sendFrameToVcam(w, h);
    perfFrameCount++;
    scheduleFrame(draw);
  }
  scheduleFrame(draw);
}

function startSegmentationLoop() {
  async function loop() {
    if (!currentStream || !vcamCtx || !greenscreenEnabled) return;
    if (isSegmenting) {
      scheduleFrame(loop, false);
      return;
    }
    isSegmenting = true;
    try {
      await selfieSegmentation.send({ image: cameraVideo });
    } catch (e) {
      console.error('Segmentation error:', e);
    }
    isSegmenting = false;
    scheduleFrame(loop, false);
  }
  scheduleFrame(loop, false);
}

function stopVcamOutput() {
  cancelFrame();
  vcamFrameInFlight = false; // clear so a restart isn't blocked by a stale flag
  if (glCompositor) { glCompositor.dispose(); glCompositor = null; }
  if (vcamNativeReady) {
    window.electronAPI?.vcamStop({ slot: vcamSlot }).catch(() => {});
  }
  vcamCtx = null;
  vcamNativeReady = false;
  vcamBadge.classList.add('hidden');
}

// ─── Green Screen (AI background removal) ───────────────────────────────────────
async function initSegmentation() {
  if (selfieSegmentation) return;
  if (!window.SelfieSegmentation) {
    console.error('MediaPipe SelfieSegmentation not loaded');
    return;
  }
  try {
    selfieSegmentation = new window.SelfieSegmentation({
      locateFile: (file) => {
        // Load MediaPipe assets from the bundled local copy so green screen
        // works offline and inside the packaged app (no CDN dependency).
        return `vendor/mediapipe/selfie_segmentation/${file}`;
      }
    });
    selfieSegmentation.setOptions({
      modelSelection: 0, // general model (balanced for most webcam framing)
    });
    selfieSegmentation.onResults(onSegmentationResults);
    await selfieSegmentation.initialize();
    segmentationReady = true;
    if (greenscreenEnabled && currentStream) restartFrameLoop();
  } catch (e) {
    console.error('Failed to initialize segmentation:', e);
    segmentationReady = false;
  }
}

function onSegmentationResults(results) {
  if (!greenscreenEnabled || !vcamCtx) return;
  const w = vcamCanvas.width;
  const h = vcamCanvas.height;

  // 1. Draw original frame (person + background) with video adjustments.
  // drawVideoRotated handles 0/90/180/270 — the save/restore inside it
  // preserves the current compositing mode for the mask step below.
  setVideoFilters(vcamCtx);
  drawVideoRotated(vcamCtx, results.image, w, h);
  vcamCtx.filter = 'none';

  // 2. Apply mask to keep only the person (MediaPipe soft mask as-is).
  // Same rotation so the mask aligns with the rotated image.
  vcamCtx.globalCompositeOperation = 'destination-in';
  drawVideoRotated(vcamCtx, results.segmentationMask, w, h);

  // 3. Draw new background behind the person.
  // The background must be drawn with the same canvas rotation as the video
  // so it aligns with the person after the CSS counter-rotation for display.
  // The image is contain-fitted (entire image visible, centered, no cropping)
  // and the background color fills any gaps so there are no transparent areas.
  vcamCtx.globalCompositeOperation = 'destination-over';
  const bgDeg = (cameraRotation + CANVAS_ROTATION_OFFSET) % 360;
  vcamCtx.save();
  if (bgDeg !== 0) {
    vcamCtx.translate(w / 2, h / 2);
    vcamCtx.rotate(bgDeg * Math.PI / 180);
    if (bgDeg === 90 || bgDeg === 270) {
      // Swap dimensions for 90/270 so the background covers the canvas
      vcamCtx.translate(-h / 2, -w / 2);
      vcamCtx.fillStyle = bgColorValue;
      vcamCtx.fillRect(0, 0, h, w);
      if (bgImageElement) drawContainImage(vcamCtx, bgImageElement, h, w);
    } else {
      // 180: same dimensions
      vcamCtx.translate(-w / 2, -h / 2);
      vcamCtx.fillStyle = bgColorValue;
      vcamCtx.fillRect(0, 0, w, h);
      if (bgImageElement) drawContainImage(vcamCtx, bgImageElement, w, h);
    }
  } else {
    vcamCtx.fillStyle = bgColorValue;
    vcamCtx.fillRect(0, 0, w, h);
    if (bgImageElement) drawContainImage(vcamCtx, bgImageElement, w, h);
  }
  vcamCtx.restore();
  vcamCtx.globalCompositeOperation = 'source-over';

  // 4. Send composited frame to the virtual camera
  sendFrameToVcam(w, h);
  perfFrameCount++;
}

// Draw an image "contain"-fitted (entire image visible, centered, no cropping)
// into a w×h region on the canvas.  Unlike cover-fit, nothing is cut off — the
// image is scaled down so it fits entirely within the bounds, with any gap left
// transparent so the background color (drawn separately) shows through.
function drawContainImage(ctx, img, w, h) {
  const imgRatio = img.width / img.height;
  const canvasRatio = w / h;
  let drawW, drawH, offX, offY;

  if (imgRatio > canvasRatio) {
    // Image is wider than canvas — fit width, center vertically
    drawW = w;
    drawH = w / imgRatio;
    offX = 0;
    offY = (h - drawH) / 2;
  } else {
    // Image is taller than canvas — fit height, center horizontally
    drawH = h;
    drawW = h * imgRatio;
    offX = (w - drawW) / 2;
    offY = 0;
  }

  ctx.drawImage(img, offX, offY, drawW, drawH);
}

function restartFrameLoop() {
  // Allow restart when either the 2D context or the GL compositor is active.
  if (!currentStream || (!vcamCtx && !glCompositor)) return;
  const s = currentStream.getVideoTracks()[0].getSettings();
  const w = s.width  || vcamCanvas.width  || 1280;
  const h = s.height || vcamCanvas.height || 720;
  startFrameLoop(w, h);
}

function setGsPopoverOpen(open) {
  if (!greenscreenControls) return;
  greenscreenControls.classList.toggle('hidden', !open);
  if (btnGsOptions) btnGsOptions.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function updateGreenscreenUI() {
  const hasStream = !!currentStream;
  if (btnGreenscreen) btnGreenscreen.classList.toggle('active', greenscreenEnabled);
  // Update label only — never wipe the button SVG via textContent.
  if (gsBtnLabel) {
    gsBtnLabel.textContent = greenscreenEnabled ? 'GS On' : 'Green Screen';
  }
  // Options chevron only when GS is on; popover stays closed until user opens it.
  if (btnGsOptions) btnGsOptions.classList.toggle('hidden', !greenscreenEnabled);
  if (!greenscreenEnabled) setGsPopoverOpen(false);
  if (greenscreenBadge) greenscreenBadge.classList.toggle('hidden', !greenscreenEnabled);

  if (greenscreenEnabled && hasStream) {
    cameraVideo.classList.add('hidden');
    vcamCanvas.classList.add('active');
  } else {
    cameraVideo.classList.remove('hidden');
    vcamCanvas.classList.remove('active');
  }
}

async function toggleGreenscreen() {
  if (!isPremium()) {
    showPremiumUpgrade('Green Screen is a Premium feature — sign in with your PNKSOUNDS account to unlock');
    return;
  }
  greenscreenEnabled = !greenscreenEnabled;
  updateGreenscreenUI();
  const hasOutput = currentStream && (vcamCtx || glCompositor);
  if (greenscreenEnabled) {
    await initSegmentation();
    if (hasOutput) restartFrameLoop();
  } else if (hasOutput) {
    restartFrameLoop();
  }
}

// ─── Virtual Camera Driver ────────────────────────────────────────────────────
async function checkVirtualCameraDriver() {
  if (!window.electronAPI) { setVcamStatus('gray', 'Virtual Camera: unavailable'); return; }
  setVcamStatus('yellow', 'Checking virtual camera driver…');
  try {
    const installed = await window.electronAPI.checkVcam();
    if (installed) {
      vcamDriverReady = true;
      setVcamStatus('yellow', 'Driver registered — start a camera to test the frame bridge');
      btnInstallVcam.classList.add('hidden');
      vcamInstallStatus.textContent = '✓ Driver registered. In OBS, look for "MultiCam" under Video Capture Devices.';
      vcamInstallStatus.style.color = 'var(--green)';
      if (currentStream) startVcamOutput();
    } else {
      // Only check — never auto-register on launch. The driver is registered
      // at install time by NSIS (customInstall macro). For portable/dev builds
      // or if install-time registration failed, the user clicks the button
      // explicitly. This eliminates the per-launch UAC prompt.
      vcamDriverReady = false;
      setVcamStatus('gray', 'Virtual cam driver not installed — Window Capture still works');
      btnInstallVcam.classList.remove('hidden');
      vcamInstallStatus.textContent = 'Driver not installed. Click "Register Virtual Camera Driver" below (admin required).';
      vcamInstallStatus.style.color = 'var(--text-muted)';
    }
  } catch {
    setVcamStatus('gray', 'Could not check driver status');
  }
}

function setVcamStatus(color, text) {
  vcamDot.className = 'dot ' + color;
  vcamStatusText.textContent = text;
}

async function installVcamDriver() {
  if (!window.electronAPI) return;
  setVcamStatus('yellow', 'Registering driver (admin prompt)…');
  vcamInstallStatus.textContent = 'Registering…';
  vcamInstallStatus.style.color = 'var(--text-muted)';
  const r = await window.electronAPI.registerVcam();
  if (r.success) {
    vcamDriverReady = true;
    setVcamStatus('green', 'Virtual Camera driver registered');
    btnInstallVcam.classList.add('hidden');
    vcamInstallStatus.textContent = '✓ Registered! In OBS, look for "MultiCam" under Video Capture Devices.';
    vcamInstallStatus.style.color = 'var(--green)';
    if (currentStream) startVcamOutput();
  } else {
    setVcamStatus('red', 'Registration failed');
    vcamInstallStatus.textContent = '✗ ' + (r.error || 'Run as Administrator.');
    vcamInstallStatus.style.color = 'var(--accent)';
    btnInstallVcam.classList.remove('hidden');
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
deviceSelect.addEventListener('change', () => {
  saveSettingsDebounced({ lastDeviceIndex: deviceSelect.value });
  startSelected();
});
resSelect.addEventListener('change', () => {
  saveSettingsDebounced({ resolution: resSelect.value });
  if (deviceSelect.value !== '') startSelected();
});

settingShowSplash.addEventListener('change', () => {
  saveSettingsDebounced({ showSplash: settingShowSplash.checked });
});

settingTheme.addEventListener('change', () => {
  const theme = settingTheme.value;
  document.documentElement.setAttribute('data-theme', theme);
  updateHeaderLogoForTheme(theme);
  saveSettingsDebounced({ theme });
});

btnNewWindow.addEventListener('click', () => {
  if (!isPremium()) {
    showPremiumUpgrade('Opening a separate MultiCam window is a Premium feature — sign in with your PNKSOUNDS account to unlock');
    return;
  }
  window.electronAPI?.openNewWindow();
});
btnNewWindowMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNewCameraDropdown();
});
btnNewSameWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  addSecondaryPane();
});
btnNewSeparate.addEventListener('click', (e) => {
  e.stopPropagation();
  openNewCameraSeparate();
});

btnClosePane0.addEventListener('click', () => {
  stopCamera();
  closeAllSecondaryPanes();
});

// Close the new-camera dropdown when clicking anywhere else.
document.addEventListener('click', () => newCameraDropdown.classList.add('hidden'));

// Rotate button: cycles through 0° → 90° → 180° → 270°.
// Applies CSS transform to the main <video> and restarts the vcam output so
// the canvas dimensions swap for 90°/270°.
btnRotate.addEventListener('click', () => {
  if (btnRotate.disabled) return;
  cameraRotation = (cameraRotation + 90) % 360;
  applyVideoRotation();
  // Restart the vcam output to resize the canvas for the new orientation.
  // This also re-evaluates whether to use the GL or 2D path.
  if (currentStream) startVcamOutput();
});

// Flip button: swaps between front and back camera for the active phone.
// Each phone is a single dropdown entry holding a `cameras` array; flip cycles
// `currentCamIndex` within that entry and restarts scrcpy with the other camera.
btnFlipCamera.addEventListener('click', async () => {
  if (btnFlipCamera.disabled) return;
  const idx = deviceSelect.value;
  if (idx === '' || idx === null) return;
  const opt = sourceOptions[Number(idx)];
  if (!opt || opt.kind !== 'phone' || opt.cameras.length < 2) return;

  // Cycle to the next camera in the phone's camera list (front ↔ back)
  opt.currentCamIndex = (opt.currentCamIndex + 1) % opt.cameras.length;
  await startSelected();
});

// ─── Keyboard shortcuts / hotkeys ────────────────────────────────────────────
// Default hotkey bindings. Persisted to settings on first launch (Phase 4) so
// future customization only needs a UI. The dispatch table maps a normalized
// key string to an action function.
const DEFAULT_HOTKEYS = {
  rotate:         'r',
  flipCamera:     'f',
  greenscreen:    'g',
  settings:       's',
  newCamera:      'n',
  closeCamera:    'c',
  nextResolution: '+',
  prevResolution: '-',
  showHotkeys:    '?',
  newWindow:      'Ctrl+Shift+N',
};
let activeHotkeys = { ...DEFAULT_HOTKEYS };

// Normalize a KeyboardEvent into a key string matching the hotkeys table.
// Examples: 'r', 'F5', '?', 'Ctrl+Shift+N'. Key is lowercased for single
// letters; modifier names are sorted Ctrl, Shift, Alt for stable lookup.
function normalizeKey(e) {
  const key = e.key;
  // Function keys and special chars stay as-is
  if (key === 'F5' || key === '?' || key === '+' || key === '-' || key === '=' || key === '_') {
    // Modifier-based combos need the full string
  } else if (key.length === 1) {
    // Single char — lowercase for letter keys
  }
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey)   parts.push('Alt');
  // For single-char keys with no modifiers, use lowercase
  if (parts.length === 0 && key.length === 1) {
    return key.toLowerCase();
  }
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

// Build an inverted lookup: key string → action name
function buildHotkeyLookup(hotkeys) {
  const lookup = {};
  for (const [action, key] of Object.entries(hotkeys)) {
    lookup[key.toLowerCase()] = action;
  }
  return lookup;
}

// Hotkey action functions. Each checks its own preconditions (e.g., button
// disabled state) and is a no-op if the action can't run.
function actionRotate() {
  if (!btnRotate || btnRotate.disabled) return;
  btnRotate.click();
}

function actionFlipCamera() {
  if (!btnFlipCamera || btnFlipCamera.disabled) return;
  btnFlipCamera.click();
}

function actionToggleGreenscreen() {
  if (!btnGreenscreen) return;
  btnGreenscreen.click();
}

function actionToggleSettings() {
  if (!settingsOverlay) return;
  if (settingsOverlay.classList.contains('hidden')) openSettings();
  else closeSettings();
}

function actionNewCamera() {
  if (!btnNewWindow) return;
  btnNewWindow.click();
}

function actionCloseCamera() {
  stopCamera();
}

function actionRefresh() {
  refreshSources();
}

function actionNextResolution() {
  if (!resSelect || resSelect.options.length <= 1) return;
  const idx = resSelect.selectedIndex;
  const next = (idx + 1) % resSelect.options.length;
  resSelect.selectedIndex = next;
  resSelect.dispatchEvent(new Event('change'));
}

function actionPrevResolution() {
  if (!resSelect || resSelect.options.length <= 1) return;
  const idx = resSelect.selectedIndex;
  const prev = (idx - 1 + resSelect.options.length) % resSelect.options.length;
  resSelect.selectedIndex = prev;
  resSelect.dispatchEvent(new Event('change'));
}

function actionShowHotkeys() {
  openHotkeysOverlay();
}

function actionNewWindow() {
  if (window.electronAPI?.openNewWindow) window.electronAPI.openNewWindow();
}

function actionSelectCamera(idx) {
  if (!sourceOptions[idx]) return;
  deviceSelect.value = String(idx);
  deviceSelect.dispatchEvent(new Event('change'));
}

// Consolidated keydown handler — replaces the two scattered listeners.
// Single-key hotkeys are suppressed when typing in INPUT/SELECT/TEXTAREA.
// Escape and F5 are exempt (work everywhere). Modifier-based hotkeys
// (Ctrl+Shift+N) are also exempt (intentional, not accidental).
document.addEventListener('keydown', (e) => {
  // Keybind capture mode — when active, the next keypress is consumed to
  // rebind the capturing action (Esc cancels). Takes priority over everything.
  if (capturingAction) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancelKeybindCapture();
    } else {
      captureKeybind(e);
    }
    return;
  }

  // Escape always works — closes overlays/popovers even in input fields
  if (e.key === 'Escape') {
    if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) closeSettings();
    if (changelogOverlay) changelogOverlay.classList.add('hidden');
    if (hotkeysOverlay) hotkeysOverlay.classList.add('hidden');
    setGsPopoverOpen(false);
    return;
  }

  // F5 always works — standard refresh key
  if (e.key === 'F5') {
    e.preventDefault();
    actionRefresh();
    return;
  }

  // Build the normalized key string for lookup
  const keyStr = normalizeKey(e);
  const lookup = buildHotkeyLookup(activeHotkeys);
  const action = lookup[keyStr.toLowerCase()];

  // Digit keys 1-9 → select camera (not in the hotkeys table, handled specially)
  if (!e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.shiftKey) return; // Shift+digit is a symbol, not a camera select
    actionSelectCamera(parseInt(e.key, 10) - 1);
    return;
  }

  if (!action) return;

  // Input-field guard for single-key hotkeys (no modifiers)
  const hasModifiers = e.ctrlKey || e.altKey;
  if (!hasModifiers) {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  }

  // Dispatch to the action function
  switch (action) {
    case 'rotate':         actionRotate(); break;
    case 'flipCamera':     actionFlipCamera(); break;
    case 'greenscreen':    actionToggleGreenscreen(); break;
    case 'settings':       actionToggleSettings(); break;
    case 'newCamera':      actionNewCamera(); break;
    case 'closeCamera':    actionCloseCamera(); break;
    case 'nextResolution': actionNextResolution(); break;
    case 'prevResolution': actionPrevResolution(); break;
    case 'showHotkeys':    actionShowHotkeys(); break;
    case 'newWindow':      actionNewWindow(); break;
  }
});

btnRefresh.addEventListener('click', refreshSources);
btnSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
// Keep preview in view when opening settings with Video Adjustments focused.
if (settingsPreviewCanvas) {
  settingsPreviewCanvas.addEventListener('click', (e) => e.stopPropagation());
}

// Exit App — deliberate quit so the user doesn't accidentally close via the window X.
if (btnExitApp) {
  btnExitApp.addEventListener('click', () => {
    window.electronAPI?.quitApp?.();
  });
}

// Collapsible Help & Guides section in Settings.
if (helpToggle && helpContent) {
  helpToggle.addEventListener('click', () => {
    const expanded = helpToggle.getAttribute('aria-expanded') === 'true';
    helpToggle.setAttribute('aria-expanded', String(!expanded));
    helpContent.classList.toggle('hidden', expanded);
  });
}

// Changelog overlay — opened from the About section, closes on X / click-outside / Escape.
if (btnViewChangelog && changelogOverlay) {
  btnViewChangelog.addEventListener('click', () => changelogOverlay.classList.remove('hidden'));
}
if (btnCloseChangelog && changelogOverlay) {
  btnCloseChangelog.addEventListener('click', () => changelogOverlay.classList.add('hidden'));
  changelogOverlay.addEventListener('click', (e) => {
    if (e.target === changelogOverlay) changelogOverlay.classList.add('hidden');
  });
}

// ─── Hotkeys reference overlay ────────────────────────────────────────────────
// Pretty-print a hotkey string as <kbd> elements for the reference table.
// 'Ctrl+Shift+N' → <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>
function formatHotkey(key) {
  return key.split('+').map(p => `<kbd>${p}</kbd>`).join('+');
}

// Populate the hotkeys table from the active bindings + labels.
function populateHotkeysTable() {
  if (!hotkeysTbody) return;
  const labels = {
    rotate:         'Rotate camera 90°',
    flipCamera:     'Flip front/back camera',
    greenscreen:    'Toggle green screen',
    settings:       'Open/close settings',
    newCamera:      'Add camera pane (this window)',
    closeCamera:    'Stop active camera',
    nextResolution: 'Next resolution (higher)',
    prevResolution: 'Previous resolution (lower)',
    showHotkeys:    'Show this help',
    newWindow:      'Open new MultiCam window',
  };
  hotkeysTbody.innerHTML = '';
  for (const [action, key] of Object.entries(activeHotkeys)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="hotkey-key">${formatHotkey(key)}</td><td>${labels[action] || action}</td>`;
    hotkeysTbody.appendChild(tr);
  }
  // Add the digit range (1-9) for camera selection — not in the hotkeys table
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="hotkey-key"><kbd>1</kbd>–<kbd>9</kbd></td><td>Select camera 1–9</td>`;
  hotkeysTbody.appendChild(tr);
  // Add F5 and Escape (handled outside the dispatch table)
  const extras = [
    ['<kbd>F5</kbd>', 'Refresh camera list'],
    ['<kbd>Esc</kbd>', 'Close overlays / popovers'],
  ];
  for (const [k, label] of extras) {
    const tr2 = document.createElement('tr');
    tr2.innerHTML = `<td class="hotkey-key">${k}</td><td>${label}</td>`;
    hotkeysTbody.appendChild(tr2);
  }
}

function openHotkeysOverlay() {
  if (!hotkeysOverlay) return;
  populateHotkeysTable();
  hotkeysOverlay.classList.remove('hidden');
}

function closeHotkeysOverlay() {
  if (!hotkeysOverlay) return;
  hotkeysOverlay.classList.add('hidden');
}

if (btnViewHotkeys && hotkeysOverlay) {
  btnViewHotkeys.addEventListener('click', openHotkeysOverlay);
}
if (btnCloseHotkeys && hotkeysOverlay) {
  btnCloseHotkeys.addEventListener('click', closeHotkeysOverlay);
  hotkeysOverlay.addEventListener('click', (e) => {
    if (e.target === hotkeysOverlay) closeHotkeysOverlay();
  });
}

// ─── Keybind customization (Settings overlay) ────────────────────────────────
// The four user-customizable actions. Other hotkeys (newCamera, closeCamera,
// resolutions, showHotkeys, newWindow) stay on defaults and are not editable
// from the settings UI to keep the menu focused.
const CUSTOMIZABLE_KEYBINDS = ['flipCamera', 'rotate', 'greenscreen', 'settings'];

// Reserved keys that cannot be reassigned (handled outside the dispatch table).
const RESERVED_KEYS = new Set(['f5', 'escape', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

// State for the capture-in-progress interaction.
let capturingAction = null;       // action name being rebound, or null
let capturingButton = null;       // the DOM button element in capture state

// Build the editable keybind rows in the Settings overlay.
function populateKeybindCustomizeList() {
  if (!keybindCustomizeList) return;
  const labels = {
    flipCamera:  'Flip front/back camera',
    rotate:      'Rotate camera 90°',
    greenscreen: 'Toggle green screen',
    settings:    'Open/close settings',
  };
  keybindCustomizeList.innerHTML = '';
  for (const action of CUSTOMIZABLE_KEYBINDS) {
    const key = activeHotkeys[action] || '—';
    const row = document.createElement('div');
    row.className = 'keybind-customize-row';
    row.innerHTML = `
      <span class="keybind-label">${labels[action] || action}</span>
      <button class="keybind-bind-btn" data-action="${action}" title="Click to reassign">${formatHotkeyPlain(key)}</button>
    `;
    keybindCustomizeList.appendChild(row);
  }
  // Wire up click handlers on each bind button
  keybindCustomizeList.querySelectorAll('.keybind-bind-btn').forEach(btn => {
    btn.addEventListener('click', () => beginKeybindCapture(btn));
  });
}

// Plain-text version of a hotkey for button labels (no <kbd> tags).
function formatHotkeyPlain(key) {
  return key.split('+').join('+');
}

// Enter capture mode: the next keypress will rebind this action.
function beginKeybindCapture(btn) {
  // If another capture is in progress, cancel it first
  if (capturingAction) cancelKeybindCapture();
  capturingAction = btn.dataset.action;
  capturingButton = btn;
  btn.classList.add('capturing');
  btn.textContent = 'Press a key…';
}

// Cancel capture mode without rebinding.
function cancelKeybindCapture() {
  if (!capturingButton) { capturingAction = null; return; }
  capturingButton.classList.remove('capturing');
  const action = capturingAction;
  capturingButton.textContent = formatHotkeyPlain(activeHotkeys[action] || '—');
  capturingAction = null;
  capturingButton = null;
}

// Handle a keypress during capture mode — assign it to the capturing action.
function captureKeybind(e) {
  const action = capturingAction;
  if (!action || !capturingButton) return;

  // Reject bare modifier presses (need an actual key)
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
    return; // keep listening
  }

  const newKey = normalizeKey(e);
  const newKeyLower = newKey.toLowerCase();

  // Reject reserved keys
  if (RESERVED_KEYS.has(newKeyLower)) {
    capturingButton.classList.add('conflict');
    capturingButton.textContent = 'Reserved';
    setTimeout(() => {
      capturingButton.classList.remove('conflict');
      capturingButton.textContent = formatHotkeyPlain(activeHotkeys[action] || '—');
    }, 1000);
    return;
  }

  // Detect conflict: is this key already bound to another action?
  const conflictAction = Object.entries(activeHotkeys).find(
    ([a, k]) => a !== action && k.toLowerCase() === newKeyLower
  )?.[0];

  if (conflictAction) {
    // Auto-swap: give the conflicting action the old key of this action
    activeHotkeys[conflictAction] = activeHotkeys[action];
  }
  activeHotkeys[action] = newKey;

  // Persist
  saveSettingsDebounced({ hotkeys: activeHotkeys });

  // Update UI
  capturingButton.classList.remove('capturing');
  capturingButton.textContent = formatHotkeyPlain(newKey);
  capturingAction = null;
  capturingButton = null;

  // Re-render the full list (in case a swap changed another row) + reference table
  populateKeybindCustomizeList();
  populateHotkeysTable();
}

// Reset all customizable keybinds to their defaults.
function resetKeybindsToDefaults() {
  for (const action of CUSTOMIZABLE_KEYBINDS) {
    activeHotkeys[action] = DEFAULT_HOTKEYS[action];
  }
  saveSettingsDebounced({ hotkeys: activeHotkeys });
  if (capturingAction) cancelKeybindCapture();
  populateKeybindCustomizeList();
  populateHotkeysTable();
}

if (btnResetKeybinds) {
  btnResetKeybinds.addEventListener('click', resetKeybindsToDefaults);
}

// ─── Window controls (frameless mode) ─────────────────────────────────────────
// Minimize and maximize/restore buttons in the custom title bar.
// No close button — quitting is done via "Exit App" in Settings.
function updateMaximizeIcon(isMaximized) {
  if (!maximizeIcon || !restoreIcon) return;
  maximizeIcon.classList.toggle('hidden', isMaximized);
  restoreIcon.classList.toggle('hidden', !isMaximized);
  if (btnMaximize) btnMaximize.title = isMaximized ? 'Restore' : 'Maximize';
}

if (btnMinimize) {
  btnMinimize.addEventListener('click', () => {
    window.electronAPI?.windowMinimize?.();
  });
}

if (btnMaximize) {
  btnMaximize.addEventListener('click', () => {
    window.electronAPI?.windowToggleMaximize?.().then(updateMaximizeIcon);
  });
}

// Sync the maximize/restore icon with the actual window state (covers
// keyboard shortcuts like Win+Up and double-click title bar).
if (window.electronAPI?.onWindowMaximizeChange) {
  window.electronAPI.onWindowMaximizeChange(updateMaximizeIcon);
}
if (window.electronAPI?.windowIsMaximized) {
  window.electronAPI.windowIsMaximized().then(updateMaximizeIcon);
}

btnInstallVcam.addEventListener('click', installVcamDriver);
btnInstallVcamSettings.addEventListener('click', installVcamDriver);

// ─── Forum account event listeners ───────────────────────────────────────────
btnForumLogin.addEventListener('click', doForumLogin);
btnForumLogout.addEventListener('click', doForumLogout);
btnForumRegister.addEventListener('click', openForumRegister);
linkForumReset.addEventListener('click', (e) => { e.preventDefault(); openForumReset(); });
forumPasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doForumLogin();
});
forumEmailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') forumPasswordInput.focus();
});

// ─── Upgrade / account management links ──────────────────────────────────────
const btnUpgradePremium = document.getElementById('btn-upgrade-premium');
const btnManageAccount  = document.getElementById('btn-manage-account');

if (btnUpgradePremium) {
  btnUpgradePremium.addEventListener('click', async () => {
    try {
      const url = await window.electronAPI?.forumGetPricingUrl?.();
      if (url) window.electronAPI?.openExternal(url);
    } catch {}
  });
}
if (btnManageAccount) {
  btnManageAccount.addEventListener('click', async () => {
    try {
      const url = await window.electronAPI?.forumGetAccountUrl?.();
      if (url) window.electronAPI?.openExternal(url);
    } catch {}
  });
}

// Periodic entitlement re-check (every 30 minutes) to catch subscription
// cancellations, expirations, or new purchases during long-running sessions.
entitlementCheckTimer = setInterval(async () => {
  if (!window.electronAPI?.forumCheckPremium) return;
  try {
    const session = await window.electronAPI.forumGetSession();
    await checkForumPremium(session?.ok ? session.user : null);
  } catch {}
}, 30 * 60 * 1000);

// ─── About / social links ────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.getAppVersion().then(v => {
    if (v && appVersionDisplay) appVersionDisplay.textContent = `v${v}`;
  }).catch(() => {});
}
if (linkGithub)  linkGithub.addEventListener('click',  (e) => { e.preventDefault(); window.electronAPI?.openExternal('https://github.com/pnksounds-dev'); });
if (linkWebsite) linkWebsite.addEventListener('click', (e) => { e.preventDefault(); window.electronAPI?.openExternal('https://pnksounds.dev/'); });
if (linkDiscord) linkDiscord.addEventListener('click', (e) => { e.preventDefault(); window.electronAPI?.openExternal('https://discord.gg/DkyraHSbTW'); });
btnUninstallVcamSettings.addEventListener('click', async () => {
  if (!window.electronAPI?.unregisterVcam) {
    vcamInstallStatus.textContent = 'Uninstall not supported in this build.';
    vcamInstallStatus.style.color = 'var(--text-muted)';
    return;
  }
  setVcamStatus('yellow', 'Unregistering driver (admin prompt)…');
  vcamInstallStatus.textContent = 'Unregistering…';
  vcamInstallStatus.style.color = 'var(--text-muted)';
  const r = await window.electronAPI.unregisterVcam();
  if (r.success) {
    vcamDriverReady = false;
    setVcamStatus('gray', 'Virtual cam driver uninstalled — Window Capture still works');
    btnInstallVcam.classList.remove('hidden');
    vcamInstallStatus.textContent = '✓ Driver unregistered. "MultiCam" devices will disappear from OBS after restarting OBS.';
    vcamInstallStatus.style.color = 'var(--green)';
  } else {
    setVcamStatus('red', 'Uninstall failed');
    vcamInstallStatus.textContent = '✗ ' + (r.error || 'Uninstall failed. Run as Administrator.');
    vcamInstallStatus.style.color = 'var(--accent)';
  }
});

if (btnVcamDiagnostics) {
  btnVcamDiagnostics.addEventListener('click', async () => {
    if (!window.electronAPI?.vcamDiagnostics) {
      if (vcamDiagnosticsOutput) {
        vcamDiagnosticsOutput.classList.remove('hidden');
        vcamDiagnosticsOutput.textContent = 'Diagnostics not supported in this build.';
      }
      return;
    }
    if (vcamDiagnosticsOutput) vcamDiagnosticsOutput.classList.remove('hidden');
    vcamDiagnosticsOutput.textContent = 'Collecting diagnostics…';
    const d = await window.electronAPI.vcamDiagnostics();
    const lines = [
      `MultiCam Viewer v${d.appVersion}`,
      `Driver installed: ${d.installed ? 'YES' : 'NO'}`,
      `Last error: ${d.lastError || 'none'}`,
      ``,
      `64-bit DLL: ${d.dllPath64}`,
      `  exists: ${d.dll64Exists ? 'YES' : 'NO'}`,
      `32-bit DLL: ${d.dllPath32}`,
      `  exists: ${d.dll32Exists ? 'YES' : 'NO'}`,
      ``,
      `Resources path: ${d.resourcesPath}`,
    ];
    vcamDiagnosticsOutput.textContent = lines.join('\n');
  });
}

// Green screen controls
btnGreenscreen.addEventListener('click', () => {
  toggleGreenscreen();
  saveSettingsDebounced({ greenscreenEnabled: greenscreenEnabled });
});

if (btnGsOptions) {
  btnGsOptions.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!greenscreenEnabled) return;
    const isOpen = greenscreenControls && !greenscreenControls.classList.contains('hidden');
    setGsPopoverOpen(!isOpen);
  });
}

// Close GS popover when clicking outside it
document.addEventListener('click', (e) => {
  if (!greenscreenControls || greenscreenControls.classList.contains('hidden')) return;
  const wrap = document.getElementById('greenscreen-wrap');
  if (wrap && !wrap.contains(e.target)) setGsPopoverOpen(false);
});

bgColorInput.addEventListener('input', (e) => {
  bgColorValue = e.target.value;
  saveSettingsDebounced({ bgColor: bgColorValue });
});

bgImageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = async () => {
    bgImageElement = img;
    URL.revokeObjectURL(img.src);
    // Read the file as a data URL so we can save it via IPC (file.path is not
    // available under context isolation in Electron 33).
    if (window.electronAPI?.saveImageFile) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const result = await window.electronAPI.saveImageFile(dataUrl, file.name || 'bg');
        if (result.ok) {
          const thumb = makeThumbnail(img, 48);
          addToRecentBgImages(result.path, file.name || 'background', thumb);
        }
      } catch (err) {
        console.error('Failed to save background image:', err);
      }
    }
  };
  img.onerror = () => {
    bgImageElement = null;
  };
  img.src = URL.createObjectURL(file);
});

// Read a File as a data URL (Promise wrapper for FileReader).
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

btnClearBg.addEventListener('click', () => {
  bgImageElement = null;
  bgImageInput.value = '';
  activeRecentIdx = -1;
  renderRecentBgImages();
});

// Generate a small thumbnail data URL from an Image element.
function makeThumbnail(img, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  // Cover-fit the image into the square thumbnail
  const scale = Math.max(size / img.width, size / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return c.toDataURL('image/jpeg', 0.7);
}

// Add an image to the recent list (dedup by path, move to front, cap at 5).
function addToRecentBgImages(filePath, name, thumbDataUrl) {
  // Remove existing entry with the same path
  recentBgImages = recentBgImages.filter(r => r.path !== filePath);
  // Prepend the new entry
  recentBgImages.unshift({ path: filePath, name, thumbDataUrl });
  // Cap at 5
  if (recentBgImages.length > 5) recentBgImages = recentBgImages.slice(0, 5);
  // Persist paths to settings (thumbnails are in memory only)
  saveSettingsDebounced({ recentBgImagePaths: recentBgImages.map(r => r.path) });
  // Mark the just-added image as active
  activeRecentIdx = 0;
  renderRecentBgImages();
}

// Render the recent images thumbnails in the GS popover.
function renderRecentBgImages() {
  if (!gsRecentList || !gsRecentImages) return;
  gsRecentList.innerHTML = '';
  if (recentBgImages.length === 0) {
    gsRecentImages.classList.add('hidden');
    return;
  }
  gsRecentImages.classList.remove('hidden');
  recentBgImages.forEach((r, i) => {
    const thumb = document.createElement('img');
    thumb.src = r.thumbDataUrl;
    thumb.className = 'gs-recent-thumb' + (i === activeRecentIdx ? ' active' : '');
    thumb.title = r.name;
    thumb.addEventListener('click', () => loadRecentBgImage(i));
    gsRecentList.appendChild(thumb);
  });
}

// Load a recent background image by index. Reads the file via IPC and sets it
// as the current background.
async function loadRecentBgImage(idx) {
  const r = recentBgImages[idx];
  if (!r || !window.electronAPI?.readImageFile) return;
  activeRecentIdx = idx;
  renderRecentBgImages();
  try {
    const result = await window.electronAPI.readImageFile(r.path);
    if (!result.ok) {
      // File may have been deleted/moved — remove from recent list
      recentBgImages.splice(idx, 1);
      activeRecentIdx = -1;
      saveSettingsDebounced({ recentBgImagePaths: recentBgImages.map(x => x.path) });
      renderRecentBgImages();
      return;
    }
    const img = new Image();
    img.onload = () => { bgImageElement = img; };
    img.src = result.dataUrl;
  } catch {
    bgImageElement = null;
  }
}

// Load recent image paths from settings on startup and generate thumbnails
// lazily by reading each file.
async function initRecentBgImages(paths) {
  if (!paths || !Array.isArray(paths) || !paths.length) return;
  if (!window.electronAPI?.readImageFile) return;
  recentBgImages = [];
  for (const p of paths.slice(0, 5)) {
    try {
      const result = await window.electronAPI.readImageFile(p);
      if (result.ok) {
        const img = new Image();
        await new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = result.dataUrl;
        });
        if (img.width > 0) {
          const thumb = makeThumbnail(img, 48);
          const name = p.split(/[\\/]/).pop() || p;
          recentBgImages.push({ path: p, name, thumbDataUrl: thumb });
        }
      }
    } catch {}
  }
  renderRecentBgImages();
}

function syncSlider(input, valueEl, value) {
  if (input) input.value = value;
  if (valueEl) valueEl.textContent = value;
}

function bindSlider(input, valueEl, stateVar, onChange) {
  if (!input) return;
  input.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    onChange(val);
    if (valueEl) valueEl.textContent = val;
  });
}

bindSlider(stExposure, stExposureVal, 'gsExposureValue', (val) => {
  setVideoAdjustment('exposure', val);
  saveSettingsDebounced({ exposure: val });
});
bindSlider(stContrast, stContrastVal, 'gsContrastValue', (val) => {
  setVideoAdjustment('contrast', val);
  saveSettingsDebounced({ contrast: val });
});
bindSlider(stSaturation, stSaturationVal, 'gsSaturationValue', (val) => {
  setVideoAdjustment('saturation', val);
  saveSettingsDebounced({ saturation: val });
});

// Guide tabs
document.querySelectorAll('.guide-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.guide-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.guide-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    const panel = document.getElementById('tab-' + tab.dataset.tab);
    if (panel) panel.classList.remove('hidden');
  });
});

window.addEventListener('beforeunload', () => {
  stopSettingsPreview();
  // Stop the primary scrcpy process.
  if (activeScrcpyTitle && window.electronAPI) window.electronAPI.stopScrcpy(activeScrcpyTitle);
  // Stop ALL secondary pane scrcpy processes too — without this, closing a
  // window orphans the scrcpy processes, which keep holding the phone cameras
  // and leave off-screen capture windows that confuse desktopCapturer.
  secondaryPanes.forEach(pane => {
    if (pane.scrcpyTitle && window.electronAPI) {
      window.electronAPI.stopScrcpy(pane.scrcpyTitle);
      pane.scrcpyTitle = null;
    }
    if (pane.stream) {
      pane.stream.getTracks().forEach(t => t.stop());
      pane.stream = null;
    }
  });
  // Stop the primary stream.
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
});

// ─── Go ───────────────────────────────────────────────────────────────────────
init();
