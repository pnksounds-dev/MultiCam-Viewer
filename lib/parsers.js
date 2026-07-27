'use strict';

/**
 * lib/parsers.js — Pure, dependency-free helpers extracted from main.js.
 *
 * These functions contain no Electron, Node-FS, or process-spawning code so
 * they can be unit-tested in isolation (see test/parsers.test.js) and reused
 * across the main process. Keeping the parsing/validation logic pure is the
 * first step of the Phase 0 "make change safe" work described in
 * optimizations-and-design.md.
 */

// ─── ADB device-state messaging ───────────────────────────────────────────────
function adbIssueMessage(state) {
  switch (state) {
    case 'unauthorized':
      return 'Unlock your phone and tap "Allow" on the USB debugging prompt.';
    case 'offline':
      return 'Device is offline — reconnect the USB cable or press ↻ Refresh.';
    case 'recovery':
    case 'bootloader':
      return 'Phone is in recovery/bootloader mode — reboot to normal mode.';
    default:
      return 'Phone not ready — check USB debugging is enabled.';
  }
}

/**
 * Parse the stdout of `adb devices -l` into ready phones and actionable issues.
 * @param {string} output raw command output
 * @returns {{ phones: {serial:string, model:string}[], issues: {serial:string, state:string, message:string}[] }}
 */
function parseAdbDevices(output) {
  const phones = [];
  const issues = [];
  const lines = String(output || '').split(/\r?\n/).slice(1); // skip "List of devices attached"
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: <serial>   <state> [<details>]
    const m = trimmed.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const serial = m[1];
    const state = m[2].toLowerCase();
    const rest = m[3] || '';

    if (state === 'device') {
      const modelMatch = rest.match(/model:(\S+)/);
      const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : serial;
      phones.push({ serial, model });
    } else if (state === 'no') {
      // "no permissions" state: no permissions (user in group ...)
      issues.push({ serial, state: 'no permissions', message: 'USB debugging permission denied — check developer options and reconnect the cable.' });
    } else {
      issues.push({ serial, state, message: adbIssueMessage(state) });
    }
  }
  return { phones, issues };
}

/**
 * Parse `scrcpy --list-cameras` output into a list of camera descriptors.
 * scrcpy prints lines like: --camera-id=0 (back, 4000x3000, ...)
 * @param {string} output raw command output (stdout+stderr)
 * @returns {{ id:string, facing:string, maxRes:string }[]}
 */
function parseScrcpyCameras(output) {
  const cameras = [];
  const re = /--camera-id=(\d+)\s+\((\w+),\s*(\d+x\d+)/g;
  let m;
  while ((m = re.exec(String(output || ''))) !== null) {
    cameras.push({ id: m[1], facing: m[2], maxRes: m[3] });
  }
  return cameras;
}

/**
 * Parse `scrcpy --list-camera-sizes` output into camera descriptors with their
 * full list of supported capture sizes.
 *
 * scrcpy prints:
 *   --camera-id=0    (back, 4080x3060, fps=[15, 20, 24, 30])
 *         - 4080x3060
 *         - 1920x1080
 *         - 1280x720
 *       High speed capture (--camera-high-speed):
 *         - 1920x1080 (fps=[120, 240])
 *
 * @param {string} output raw command output (stdout+stderr)
 * @returns {{ id:string, facing:string, maxRes:string, sizes:string[] }[]}
 */
function parseScrcpyCameraSizes(output) {
  const cameras = [];
  const lines = String(output || '').split(/\r?\n/);
  let current = null;
  let inHighSpeed = false;
  const camRe = /--camera-id=(\d+)\s+\((\w+),\s*(\d+x\d+)/;
  // Size lines look like "        - 1920x1080" (indented, dash-prefixed)
  const sizeRe = /^\s+-\s+(\d+x\d+)/;
  // "High speed capture" section header — sizes after this are high-speed only
  const highSpeedRe = /High speed capture/;

  for (const line of lines) {
    const camMatch = line.match(camRe);
    if (camMatch) {
      current = { id: camMatch[1], facing: camMatch[2], maxRes: camMatch[3], sizes: [] };
      cameras.push(current);
      inHighSpeed = false;
      continue;
    }
    if (!current) continue;
    if (highSpeedRe.test(line)) { inHighSpeed = true; continue; }
    if (inHighSpeed) continue; // skip high-speed sizes
    const sizeMatch = line.match(sizeRe);
    if (sizeMatch) {
      current.sizes.push(sizeMatch[1]);
    }
  }
  return cameras;
}

/**
 * Compute a reduced aspect-ratio string ("16:9", "9:16", "1:1", "4:3") from a
 * "WxH" resolution string. Used to pass --camera-ar to scrcpy so that
 * --max-size selects a matching aspect ratio instead of defaulting to 4:3.
 * @param {string} resolution e.g. "1280x720"
 * @returns {string|null} e.g. "16:9", or null if input is invalid
 */
function computeAspectRatio(resolution) {
  if (typeof resolution !== 'string') return null;
  const m = resolution.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  let w = parseInt(m[1], 10);
  let h = parseInt(m[2], 10);
  if (w <= 0 || h <= 0) return null;
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

// ─── Virtual camera slot labelling ─────────────────────────────────────────────
function slotLabel(slotIdx) {
  return slotIdx === 0 ? 'MultiCam' : `MultiCam ${slotIdx + 1}`;
}

// ─── IPC input validation / clamping ──────────────────────────────────────────
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

function isValidResolution(res) {
  // Accept "auto" (let the renderer detect the best resolution) or "WxH".
  if (res === 'auto') return true;
  return typeof res === 'string' && /^\d{1,4}x\d{1,4}$/.test(res);
}

// ─── scrcpy argument construction ─────────────────────────────────────────────
// Build the scrcpy CLI argument list for a camera capture session.
// `useMaxSize` selects the --max-size path (loose upper bound, lets scrcpy pick
// a supported size) vs the exact --camera-size path.
// `aspectRatio` (e.g. "16:9") is passed as --camera-ar when using --max-size so
// scrcpy selects a size matching the user's chosen aspect ratio instead of
// defaulting to 4:3 (the largest pixel-count size within the bound).
// Extracted from main.js so the arg list can be unit-tested without spawning.
function buildScrcpyArgs({ serial, cameraId, resolution, fps, windowTitle, winW, winH, offX, offY, useMaxSize, maxDim, aspectRatio }) {
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
  if (useMaxSize && maxDim) {
    args.push(`--max-size=${maxDim}`);
    // Pin the aspect ratio so --max-size picks a 16:9 (or 9:16, 1:1, 4:3) size
    // instead of the default 4:3 (largest pixel count within the bound).
    if (aspectRatio) args.push(`--camera-ar=${aspectRatio}`);
  } else if (resolution) {
    args.push(`--camera-size=${resolution}`);
  }
  // Only force --camera-fps for non-default values. Android's default camera
  // frame rate is already 30fps; sending --camera-fps=30 sets a strict [30,30]
  // CONTROL_AE_TARGET_FPS_RANGE which some budget camera HALs (e.g. Moto E15)
  // don't support, crashing the camera service and System UI. Letting Android
  // pick its default AE range (e.g. [15,30]) is safer and produces the same 30fps.
  if (fps && fps !== 30) args.push(`--camera-fps=${fps}`);
  return args;
}

// ─── Frame ring-buffer index math (Phase 1 zero-copy pipeline) ─────────────────
// A small, branch-free helper set so the SharedArrayBuffer ring used by the
// virtual-camera writer can be reasoned about and unit-tested independently of
// any Atomics wiring.
function ringNextIndex(current, slotCount) {
  if (!(slotCount > 0)) return 0;
  return (current + 1) % slotCount;
}

// Byte size of one frame slot for the given dimensions (RGBA8).
function frameSlotBytes(width, height) {
  return Math.max(0, (width | 0)) * Math.max(0, (height | 0)) * 4;
}

module.exports = {
  adbIssueMessage,
  parseAdbDevices,
  parseScrcpyCameras,
  parseScrcpyCameraSizes,
  computeAspectRatio,
  slotLabel,
  clampInt,
  isValidSerial,
  isValidCameraId,
  isValidWindowTitle,
  isValidResolution,
  buildScrcpyArgs,
  ringNextIndex,
  frameSlotBytes,
};
