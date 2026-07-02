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
  return typeof res === 'string' && /^\d{1,4}x\d{1,4}$/.test(res);
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
  slotLabel,
  clampInt,
  isValidSerial,
  isValidCameraId,
  isValidWindowTitle,
  isValidResolution,
  ringNextIndex,
  frameSlotBytes,
};
