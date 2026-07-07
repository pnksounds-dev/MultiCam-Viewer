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
const btnOutputWindow    = document.getElementById('btn-output-window');
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
const btnMinimize        = document.getElementById('btn-minimize');
const btnMaximize        = document.getElementById('btn-maximize');
const maximizeIcon       = document.getElementById('maximize-icon');
const restoreIcon        = document.getElementById('restore-icon');
const vcamCanvas         = document.getElementById('vcam-canvas');
const vcamInstallStatus  = document.getElementById('vcam-install-status');
const btnInstallVcamSettings   = document.getElementById('btn-install-vcam-settings');
const btnUninstallVcamSettings = document.getElementById('btn-uninstall-vcam-settings');
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
const greenscreenControls = document.getElementById('greenscreen-controls');
const bgColorInput       = document.getElementById('bg-color');
const bgImageInput       = document.getElementById('bg-image');
const btnClearBg         = document.getElementById('btn-clear-bg');
const greenscreenBadge   = document.getElementById('greenscreen-badge');
const gsThreshold        = document.getElementById('gs-threshold');
const gsThresholdVal     = document.getElementById('gs-threshold-val');
const gsGap              = document.getElementById('gs-gap');
const gsGapVal           = document.getElementById('gs-gap-val');
const stThreshold        = document.getElementById('settings-threshold');
const stThresholdVal     = document.getElementById('settings-threshold-val');
const stGap              = document.getElementById('settings-gap');
const stGapVal           = document.getElementById('settings-gap-val');
const stExposure         = document.getElementById('settings-exposure');
const stExposureVal      = document.getElementById('settings-exposure-val');
const stContrast         = document.getElementById('settings-contrast');
const stContrastVal      = document.getElementById('settings-contrast-val');
const stSaturation       = document.getElementById('settings-saturation');
const stSaturationVal    = document.getElementById('settings-saturation-val');

// ─── State ────────────────────────────────────────────────────────────────────
let currentStream    = null;
let vcamSlot         = 0;
let vcamDriverReady  = false;
let fpsInterval      = null;
let lastFpsTime      = Date.now();
let frameHandle      = null;    // id from requestVideoFrameCallback or requestAnimationFrame
let vcamCtx          = null;

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
let gsThresholdValue   = 50;
let gsGapValue         = 0;
let gsExposureValue    = 0;
let gsContrastValue    = 0;
let gsSaturationValue  = 0;
let outputWindow       = null;

// ─── Video adjustment API (used by the output window) ──────────────────────────
function setVideoAdjustment(name, value) {
  const val = parseInt(value, 10);
  if (name === 'exposure') gsExposureValue = val;
  if (name === 'contrast') gsContrastValue = val;
  if (name === 'saturation') gsSaturationValue = val;
  // Keep the main settings panel in sync
  syncSlider(stExposure, stExposureVal, gsExposureValue);
  syncSlider(stContrast, stContrastVal, gsContrastValue);
  syncSlider(stSaturation, stSaturationVal, gsSaturationValue);
  // Keep the output window menu in sync
  if (outputWindow && !outputWindow.closed) {
    try {
      const doc = outputWindow.document;
      syncSlider(doc.getElementById('out-exposure'), doc.getElementById('out-exposure-val'), gsExposureValue);
      syncSlider(doc.getElementById('out-contrast'), doc.getElementById('out-contrast-val'), gsContrastValue);
      syncSlider(doc.getElementById('out-saturation'), doc.getElementById('out-saturation-val'), gsSaturationValue);
    } catch {}
  }
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
    btnGreenscreen.classList.add('active');
    greenscreenControls.classList.remove('hidden');
    greenscreenBadge.classList.remove('hidden');
    initSegmentation();
  }
  if (typeof settings.gsThreshold === 'number') {
    gsThresholdValue = settings.gsThreshold;
    gsThreshold.value = settings.gsThreshold;
    gsThresholdVal.textContent = String(settings.gsThreshold);
    stThreshold.value = settings.gsThreshold;
    stThresholdVal.textContent = String(settings.gsThreshold);
  }
  if (typeof settings.gsGap === 'number') {
    gsGapValue = settings.gsGap;
    gsGap.value = settings.gsGap;
    gsGapVal.textContent = String(settings.gsGap);
    stGap.value = settings.gsGap;
    stGapVal.textContent = String(settings.gsGap);
  }
  if (settings.bgColor) {
    bgColorValue = settings.bgColor;
    bgColorInput.value = settings.bgColor;
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

  // Auto-refresh when a UVC device is plugged/unplugged
  navigator.mediaDevices.addEventListener('devicechange', refreshSources);

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

async function refreshSources() {
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

  // For each phone, list its cameras
  for (const ph of phones) {
    let cams = [];
    const cr = await window.electronAPI.listPhoneCameras(ph.serial);
    if (cr.ok && cr.cameras.length) cams = cr.cameras;
    // Fallback if camera listing failed: assume one back camera
    if (!cams.length) cams = [{ id: '0', facing: 'back', maxRes: '' }];

    for (const cam of cams) {
      sourceOptions.push({
        kind: 'phone',
        serial: ph.serial,
        model: ph.model,
        cameraId: cam.id,
        facing: cam.facing,
        maxRes: cam.maxRes,
        label: `${ph.model} — ${cam.facing} camera`,
      });
    }
  }

  // 2) Real UVC cameras (includes Android 14+ native USB webcam mode)
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
    if (probe) probe.getTracks().forEach(t => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    devs.filter(d => d.kind === 'videoinput' && !isVirtualOutputOnly(d.label))
        .forEach(d => {
          sourceOptions.push({
            kind: 'uvc',
            deviceId: d.deviceId,
            label: '­ƒÄÑ ' + (d.label || 'USB Camera'),
          });
        });
  } catch { /* camera privacy may block this; phones still work */ }

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
      statusText.textContent = 'No phones or cameras found — see guide below';
      showConnectionGuide();
    }
  } else {
    const nPhones = sourceOptions.filter(s => s.kind === 'phone').length;
    const countMsg = nPhones
      ? `${nPhones} phone camera${nPhones > 1 ? 's' : ''} ready`
      : `${sourceOptions.length} camera${sourceOptions.length > 1 ? 's' : ''} detected`;
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
  if (idx === '' || idx === null) { stopCamera(); return; }
  const opt = sourceOptions[Number(idx)];
  if (!opt) return;

  stopCamera();
  hideConnectionGuide();

  if (opt.kind === 'phone') {
    await startPhoneCamera(opt);
  } else {
    await startUvcCamera(opt);
  }
}

// ── Phone camera via scrcpy + desktop capture ──
async function startPhoneCamera(opt) {
  const resolution = resSelect.value || '1280x720';
  const windowTitle = `MultiCamCap_${opt.serial}_${opt.cameraId}_${vcamSlot}`;
  activeScrcpyTitle = windowTitle;
  lastScrcpyError = '';

  statusText.textContent = `[1/3] Launching scrcpy for ${opt.model || opt.serial} (${opt.facing})…`;

  const start = await window.electronAPI.startScrcpy({
    serial: opt.serial,
    cameraId: opt.cameraId,
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
      attachStream(`${opt.model || opt.serial} · ${opt.facing}`);
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

// ── Common: attach a stream to the preview + start outputs ──
function attachStream(name) {
  cameraVideo.srcObject = currentStream;
  cameraVideo.classList.add('active');
  noCameraMsg.style.display = 'none';

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

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (activeScrcpyTitle && window.electronAPI) {
    window.electronAPI.stopScrcpy(activeScrcpyTitle);
    activeScrcpyTitle = null;
  }
  cameraVideo.srcObject = null;
  cameraVideo.classList.remove('active');
  noCameraMsg.style.display = 'flex';
  stopFpsCounter();
  stopVcamOutput();
  updateGreenscreenUI();
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
  const resolution = resSelect.value || '1280x720';
  const windowTitle = `MultiCamCap${pane.id}_${opt.serial}_${opt.cameraId}_${vcamSlot}`;
  pane.scrcpyTitle = windowTitle;

  const start = await window.electronAPI.startScrcpy({
    serial: opt.serial,
    cameraId: opt.cameraId,
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
  const w = cameraVideo.videoWidth  || s.width  || 1280;
  const h = cameraVideo.videoHeight || s.height || 720;

  vcamCanvas.width = w; vcamCanvas.height = h;

  // Phase 2: prefer the WebGL2 GPU compositor for the raw path when enabled.
  // Greenscreen still composites on the 2D canvas, so don't create the GL
  // compositor when greenscreen is active — startFrameLoop will acquire a 2D
  // context instead. tryCreateGlCompositor returns null if WebGL2 is missing,
  // in which case we fall back to the 2D canvas path.
  if (USE_WEBGL_COMPOSITOR && !greenscreenEnabled) {
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

function startRawFrameLoop(w, h) {
  function draw() {
    if (!currentStream || !vcamCtx) return;
    setVideoFilters(vcamCtx);
    vcamCtx.drawImage(cameraVideo, 0, 0, w, h);
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

  // 1. Draw original frame (person + background) with video adjustments
  setVideoFilters(vcamCtx);
  vcamCtx.drawImage(results.image, 0, 0, w, h);
  vcamCtx.filter = 'none';

  // 2. Apply mask to keep only the person
  vcamCtx.globalCompositeOperation = 'destination-in';
  // Adjust edge threshold with contrast/brightness
  const threshold = gsThresholdValue / 100;
  const maskBrightness = 1 + (0.5 - threshold) * 1.5;
  const maskContrast = 1 + threshold * 2;
  vcamCtx.filter = `brightness(${maskBrightness}) contrast(${maskContrast})`;
  // Apply gap by shrinking the mask toward the center
  const gap = Math.min(gsGapValue, Math.floor(Math.min(w, h) / 4));
  if (gap > 0) {
    vcamCtx.drawImage(results.segmentationMask, gap, gap, w - gap * 2, h - gap * 2);
  } else {
    vcamCtx.drawImage(results.segmentationMask, 0, 0, w, h);
  }
  vcamCtx.filter = 'none';

  // 3. Draw new background behind the person
  vcamCtx.globalCompositeOperation = 'destination-over';
  if (bgImageElement) {
    drawCoverImage(vcamCtx, bgImageElement, w, h);
  } else {
    vcamCtx.fillStyle = bgColorValue;
    vcamCtx.fillRect(0, 0, w, h);
  }
  vcamCtx.globalCompositeOperation = 'source-over';

  // 4. Send composited frame to the virtual camera
  sendFrameToVcam(w, h);
  perfFrameCount++;
}

function drawCoverImage(ctx, img, w, h) {
  const imgRatio = img.width / img.height;
  const canvasRatio = w / h;
  let drawW, drawH, offX, offY;

  if (imgRatio > canvasRatio) {
    drawH = h;
    drawW = h * imgRatio;
    offX = (w - drawW) / 2;
    offY = 0;
  } else {
    drawW = w;
    drawH = w / imgRatio;
    offX = 0;
    offY = (h - drawH) / 2;
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

function updateGreenscreenUI() {
  const hasStream = !!currentStream;
  btnGreenscreen.classList.toggle('active', greenscreenEnabled);
  btnGreenscreen.textContent = greenscreenEnabled ? 'Green Screen: On' : 'Green Screen';
  greenscreenControls.classList.toggle('hidden', !greenscreenEnabled);
  greenscreenBadge.classList.toggle('hidden', !greenscreenEnabled);

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
      // Auto-register the driver on launch (will prompt for admin/UAC)
      setVcamStatus('yellow', 'Installing virtual camera driver (admin prompt)…');
      vcamInstallStatus.textContent = 'Installing driver…';
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
        vcamDriverReady = false;
        setVcamStatus('gray', 'Virtual cam driver not installed — Window Capture still works');
        btnInstallVcam.classList.remove('hidden');
        vcamInstallStatus.textContent = '✗ ' + (r.error || 'Auto-install failed. Click below to retry.');
        vcamInstallStatus.style.color = 'var(--text-muted)';
      }
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

btnOutputWindow.addEventListener('click', () => {
  if (outputWindow && !outputWindow.closed) {
    outputWindow.focus();
    return;
  }
  // Open the output as a same-origin popup so it can share the processed canvas stream
  document.body.classList.add('clean-mode');
  outputWindow = window.open('output.html', 'multicam-output', 'frame=0,width=960,height=540,resizable=1');

  // Watch for the popup closing so we can restore the main window UI
  const checkClosed = setInterval(() => {
    if (!outputWindow || outputWindow.closed) {
      clearInterval(checkClosed);
      document.body.classList.remove('clean-mode');
      outputWindow = null;
    }
  }, 300);
});
btnRefresh.addEventListener('click', refreshSources);
btnSettings.addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
btnCloseSettings.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden'); });

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
btnUninstallVcamSettings.addEventListener('click', () => {
  vcamInstallStatus.textContent = 'To unregister, run as Admin: regsvr32 /u "vcam\\UnityCaptureFilter64.dll"';
  vcamInstallStatus.style.color = 'var(--text-muted)';
});

// Green screen controls
btnGreenscreen.addEventListener('click', () => {
  toggleGreenscreen();
  saveSettingsDebounced({ greenscreenEnabled: greenscreenEnabled });
});

bgColorInput.addEventListener('input', (e) => {
  bgColorValue = e.target.value;
  saveSettingsDebounced({ bgColor: bgColorValue });
});

bgImageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    bgImageElement = img;
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => {
    bgImageElement = null;
  };
  img.src = URL.createObjectURL(file);
});

btnClearBg.addEventListener('click', () => {
  bgImageElement = null;
  bgImageInput.value = '';
});

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

bindSlider(gsThreshold, gsThresholdVal, 'gsThresholdValue', (val) => {
  gsThresholdValue = val;
  syncSlider(stThreshold, stThresholdVal, val);
  saveSettingsDebounced({ gsThreshold: val });
});
bindSlider(stThreshold, stThresholdVal, 'gsThresholdValue', (val) => {
  gsThresholdValue = val;
  syncSlider(gsThreshold, gsThresholdVal, val);
  saveSettingsDebounced({ gsThreshold: val });
});

bindSlider(gsGap, gsGapVal, 'gsGapValue', (val) => {
  gsGapValue = val;
  syncSlider(stGap, stGapVal, val);
  saveSettingsDebounced({ gsGap: val });
});
bindSlider(stGap, stGapVal, 'gsGapValue', (val) => {
  gsGapValue = val;
  syncSlider(gsGap, gsGapVal, val);
  saveSettingsDebounced({ gsGap: val });
});

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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    settingsOverlay.classList.add('hidden');
    if (changelogOverlay) changelogOverlay.classList.add('hidden');
  }
  if (e.key === 'F5')     refreshSources();
});

window.addEventListener('beforeunload', () => {
  if (activeScrcpyTitle && window.electronAPI) window.electronAPI.stopScrcpy(activeScrcpyTitle);
});

// ─── Go ───────────────────────────────────────────────────────────────────────
init();
