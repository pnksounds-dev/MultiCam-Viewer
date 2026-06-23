/**
 * vcam-worker.js — Virtual Camera output worker
 *
 * Runs as a Web Worker in the Electron renderer process (browser context).
 * Receives raw RGBA ImageData frames from the main renderer thread and
 * writes them to UnityCapture's shared memory so that DirectShow apps
 * (OBS, Zoom, Teams, etc.) can read the virtual camera feed.
 *
 * UnityCapture shared memory layout:
 *   Offset 0:  uint32  width
 *   Offset 4:  uint32  height
 *   Offset 8+: BGRA pixel data (width * height * 4 bytes)
 *
 * Shared memory name format:
 *   Slot 0 → "UnityCaptureSharedMem"
 *   Slot 1 → "UnityCaptureSharedMem1"
 *   Slot 2 → "UnityCaptureSharedMem2"  (etc.)
 *
 * Since Web Workers cannot call Windows APIs directly, we use a WASM module
 * compiled from a small C shim, bundled as vcam-native.wasm. If the WASM
 * module is unavailable, we fall back to a no-op (the video is still visible
 * in the app window for OBS Window Capture).
 *
 * For the initial release, the primary OBS integration method is Window Capture.
 * The shared memory path is a progressive enhancement that activates when
 * the compiled native helper is present.
 */

'use strict';

let width = 0;
let height = 0;
let slot = 0;
let frameCount = 0;
let nativeReady = false;

// We post messages back to the main thread
function post(type, data) {
  self.postMessage({ type, ...data });
}

// ─── WASM bridge (optional) ──────────────────────────────────────────────────
// Try to load vcam-native.wasm which exposes:
//   init_shared_mem(slot, width, height) → 1 on success, 0 on fail
//   write_frame(ptr, len) → void
//   cleanup() → void
let wasmExports = null;

async function tryLoadWasm() {
  try {
    const resp = await fetch(new URL('vcam-native.wasm', self.location.href));
    if (!resp.ok) return false;
    const bytes = await resp.arrayBuffer();
    const wasm = await WebAssembly.instantiate(bytes, {
      env: {
        memory: new WebAssembly.Memory({ initial: 256 }),
      }
    });
    wasmExports = wasm.instance.exports;
    return true;
  } catch {
    return false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initWorker(msg) {
  width  = msg.width  || 1280;
  height = msg.height || 720;
  slot   = msg.slot   || 0;

  const wasmLoaded = await tryLoadWasm();

  if (wasmLoaded && wasmExports && wasmExports.init_shared_mem) {
    const ok = wasmExports.init_shared_mem(slot, width, height);
    nativeReady = ok === 1;
  }

  post('ready', { nativeAvailable: nativeReady });

  if (!nativeReady) {
    // No native bridge — virtual cam output via shared memory won't work.
    // The app window can still be captured by OBS via Window Capture.
    post('info', {
      message: 'Virtual cam shared memory bridge not available. Use OBS Window Capture to capture this window, OR install the vcam-native helper for DirectShow output.'
    });
  }
}

// ─── Frame handler ────────────────────────────────────────────────────────────
function handleFrame(rgbaBuffer) {
  if (!nativeReady || !wasmExports) return;

  try {
    const totalBytes = 8 + width * height * 4;

    // Get a pointer to WASM memory and write header + BGRA pixels
    const mem = new DataView(wasmExports.memory.buffer);
    const pixelPtr = wasmExports.get_frame_buffer ? wasmExports.get_frame_buffer() : 0;

    if (!pixelPtr) return;

    // Write header
    mem.setUint32(pixelPtr, width,  true);
    mem.setUint32(pixelPtr + 4, height, true);

    // Convert RGBA → BGRA into WASM memory
    const src = new Uint8Array(rgbaBuffer);
    const dst = new Uint8Array(wasmExports.memory.buffer, pixelPtr + 8, width * height * 4);

    for (let i = 0; i < src.length; i += 4) {
      dst[i]     = src[i + 2]; // B
      dst[i + 1] = src[i + 1]; // G
      dst[i + 2] = src[i];     // R
      dst[i + 3] = src[i + 3]; // A
    }

    // Flush to shared memory
    wasmExports.write_frame(pixelPtr, totalBytes);

    frameCount++;
  } catch (err) {
    nativeReady = false;
    post('error', { message: err.message });
  }
}

// ─── Message router ───────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      initWorker(msg);
      break;
    case 'frame':
      if (msg.data) handleFrame(msg.data);
      break;
    case 'stop':
      if (wasmExports && wasmExports.cleanup) wasmExports.cleanup();
      nativeReady = false;
      break;
  }
};
