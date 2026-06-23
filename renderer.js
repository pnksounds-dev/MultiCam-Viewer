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
const vcamCanvas         = document.getElementById('vcam-canvas');
const vcamInstallStatus  = document.getElementById('vcam-install-status');
const btnInstallVcamSettings   = document.getElementById('btn-install-vcam-settings');
const btnUninstallVcamSettings = document.getElementById('btn-uninstall-vcam-settings');
const currentSlotDisplay = document.getElementById('current-slot-display');
const settingShowSplash  = document.getElementById('setting-show-splash');

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
let vcamWorker       = null;
let fpsInterval      = null;
let fpsFrameCount    = 0;
let lastFpsTime      = Date.now();
let vcamAnimFrame    = null;
let vcamCtx          = null;
let activeScrcpyTitle = null;   // currently running scrcpy window title (if any)
let sourceOptions    = [];      // metadata for each dropdown option (by value)
let lastScrcpyError  = '';      // last error line from scrcpy output
let vcamNativeReady  = false;   // true when the shared-memory frame bridge is active

// ─── Same-window additional camera panes (CCTV grid) ──────────────────────────
const secondaryPanes = []; // { id, element, select, video, stream, scrcpyTitle }
let nextPaneId = 1;

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
  if (settings.greenscreenEnabled) {
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
  }

  await refreshSources();
  // If a last device was saved and still exists in the dropdown, select it.
  try {
    const settings = await window.electronAPI.getSettings();
    if (settings && settings.lastDeviceIndex !== '' &&
        [...deviceSelect.options].some(o => o.value === String(settings.lastDeviceIndex))) {
      deviceSelect.value = String(settings.lastDeviceIndex);
      startSelected();
    }
  } catch {}
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
  return slotIdx === 0 ? 'Unity Video Capture' : `Unity Video Capture ${slotIdx + 1}`;
}

// ─── Source Enumeration (phones via ADB + real UVC cameras) ───────────────────
const VIRTUAL_OUTPUT_ONLY = [
  'unity video capture', 'obs virtual camera', 'obs-camera',
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
        label: `📱 ${ph.model} — ${cam.facing} camera`,
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
            label: '🎥 ' + (d.label || 'USB Camera'),
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
  if (activeScrcpyTitle !== windowTitle) return; // selection changed mid-wait
  if (!found) {
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
    attachStream(opt.label.replace(/^🎥\s*/, ''));
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
    document.title = `MultiCam — ${name}`;
    updateGreenscreenUI();
    startVcamOutput();
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
  if (total >= 4) {
    statusText.textContent = 'Maximum 4 cameras per window reached';
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
  if (pane.scrcpyTitle !== windowTitle) return;
  if (!found) {
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

function toggleNewCameraDropdown() {
  newCameraDropdown.classList.toggle('hidden');
}

function openNewCameraSeparate() {
  newCameraDropdown.classList.add('hidden');
  window.electronAPI?.openNewWindow();
}

// ─── FPS Counter ──────────────────────────────────────────────────────────────
function startFpsCounter() {
  fpsFrameCount = 0;
  lastFpsTime   = Date.now();
  function tick() {
    if (!currentStream) return;
    fpsFrameCount++;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  fpsInterval = setInterval(() => {
    const dt = (Date.now() - lastFpsTime) / 1000;
    fpsDisplay.textContent = `${Math.round(fpsFrameCount / dt)} FPS`;
    fpsFrameCount = 0;
    lastFpsTime  = Date.now();
  }, 1000);
}
function stopFpsCounter() {
  if (fpsInterval) { clearInterval(fpsInterval); fpsInterval = null; }
  fpsDisplay.textContent = '';
}

// ─── Virtual Camera Output (UnityCapture) ─────────────────────────────────────
function startVcamOutput() {
  if (!currentStream) return;
  const s = currentStream.getVideoTracks()[0].getSettings();
  const w = s.width  || 1280;
  const h = s.height || 720;

  vcamCanvas.width = w; vcamCanvas.height = h;
  vcamCtx = vcamCanvas.getContext('2d', { willReadFrequently: true });

  if (vcamDriverReady) {
    if (vcamWorker) { vcamWorker.terminate(); vcamWorker = null; }
    try {
      vcamWorker = new Worker('vcam-worker.js');
      vcamWorker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          vcamNativeReady = !!m.nativeAvailable;
          if (vcamNativeReady) {
            vcamBadge.classList.remove('hidden');
            setVcamStatus('green', `Virtual Camera active — ${slotLabel(vcamSlot)}`);
          } else {
            vcamBadge.classList.add('hidden');
            setVcamStatus('yellow', 'Driver registered but frame bridge missing — use OBS Window Capture');
          }
          startFrameLoop(w, h);
        } else if (m.type === 'error') {
          vcamNativeReady = false;
          vcamBadge.classList.add('hidden');
          setVcamStatus('yellow', 'Virtual cam frame error — use Window Capture in OBS');
        } else if (m.type === 'info') {
          // Log info from worker for debugging
          console.log('[vcam-worker]', m.message);
        }
      };
      vcamWorker.onerror = () => {
        vcamNativeReady = false;
        vcamBadge.classList.add('hidden');
        setVcamStatus('yellow', 'Virtual cam worker error — use Window Capture in OBS');
      };
      vcamWorker.postMessage({ type: 'init', slot: vcamSlot, width: w, height: h });
    } catch { /* window capture still works */ }
  } else {
    // No driver installed yet: still run the preview loop so green screen works
    startFrameLoop(w, h);
  }
}

function startFrameLoop(w, h) {
  if (vcamAnimFrame) { cancelAnimationFrame(vcamAnimFrame); vcamAnimFrame = null; }
  if (greenscreenEnabled && segmentationReady) {
    startSegmentationLoop();
  } else {
    startRawFrameLoop(w, h);
  }
}

function setVideoFilters(ctx) {
  const exposure = 1 + (gsExposureValue / 100);
  const contrast = 1 + (gsContrastValue / 100);
  const saturation = 1 + (gsSaturationValue / 100);
  ctx.filter = `brightness(${exposure}) contrast(${contrast}) saturate(${saturation})`;
}

function startRawFrameLoop(w, h) {
  function draw() {
    if (!currentStream || !vcamCtx) return;
    setVideoFilters(vcamCtx);
    vcamCtx.drawImage(cameraVideo, 0, 0, w, h);
    vcamCtx.filter = 'none';
    const img = vcamCtx.getImageData(0, 0, w, h);
    if (vcamWorker) vcamWorker.postMessage({ type: 'frame', data: img.data }, [img.data.buffer]);
    vcamAnimFrame = requestAnimationFrame(draw);
  }
  vcamAnimFrame = requestAnimationFrame(draw);
}

function startSegmentationLoop() {
  async function loop() {
    if (!currentStream || !vcamCtx || !greenscreenEnabled) return;
    if (isSegmenting) {
      vcamAnimFrame = requestAnimationFrame(loop);
      return;
    }
    isSegmenting = true;
    try {
      await selfieSegmentation.send({ image: cameraVideo });
    } catch (e) {
      console.error('Segmentation error:', e);
    }
    isSegmenting = false;
    vcamAnimFrame = requestAnimationFrame(loop);
  }
  vcamAnimFrame = requestAnimationFrame(loop);
}

function stopVcamOutput() {
  if (vcamAnimFrame) { cancelAnimationFrame(vcamAnimFrame); vcamAnimFrame = null; }
  if (vcamWorker)    { vcamWorker.postMessage({ type: 'stop' }); vcamWorker.terminate(); vcamWorker = null; }
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

  // 4. Send composited frame to the virtual camera worker
  if (vcamWorker) {
    const img = vcamCtx.getImageData(0, 0, w, h);
    vcamWorker.postMessage({ type: 'frame', data: img.data }, [img.data.buffer]);
  }
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
  if (!currentStream || !vcamCtx) return;
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
  greenscreenEnabled = !greenscreenEnabled;
  updateGreenscreenUI();
  if (greenscreenEnabled) {
    await initSegmentation();
    if (currentStream && vcamCtx) restartFrameLoop();
  } else if (currentStream && vcamCtx) {
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
      vcamInstallStatus.textContent = '✓ Driver registered. In OBS use Window Capture (recommended) or look for "MultiCam" / "Unity Video Capture".';
      vcamInstallStatus.style.color = 'var(--green)';
      if (currentStream) startVcamOutput();
    } else {
      vcamDriverReady = false;
      setVcamStatus('gray', 'Virtual cam driver not installed — Window Capture still works');
      btnInstallVcam.classList.remove('hidden');
      vcamInstallStatus.textContent = 'Driver not registered. Click below to install.';
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
    vcamInstallStatus.textContent = '✓ Registered! Restart OBS. Use Window Capture (recommended) or look for "MultiCam" / "Unity Video Capture".';
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

btnNewWindow.addEventListener('click', () => window.electronAPI?.openNewWindow());
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
  stopSelected();
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

btnInstallVcam.addEventListener('click', installVcamDriver);
btnInstallVcamSettings.addEventListener('click', installVcamDriver);
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
  if (e.key === 'Escape') settingsOverlay.classList.add('hidden');
  if (e.key === 'F5')     refreshSources();
});

window.addEventListener('beforeunload', () => {
  if (activeScrcpyTitle && window.electronAPI) window.electronAPI.stopScrcpy(activeScrcpyTitle);
});

// ─── Go ───────────────────────────────────────────────────────────────────────
init();
