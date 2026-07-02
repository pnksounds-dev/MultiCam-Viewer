# MultiCam Viewer — Optimizations & Design

> **Purpose:** A full architectural review of MultiCam Viewer as it exists today, an analysis of every major operation and where it can be improved, and a forward-looking design that takes the current concept and **10×'s both the infrastructure and the feature set** — turning a solid phone-to-webcam utility into a premium, professional-grade virtual production studio.
>
> This document is **forward-looking and architectural**. A separate, release-readiness/security audit already exists at `review/application-audit.md` (packaging, code-signing, CSP, IPC validation, privacy notices, etc.). This document intentionally does **not** re-litigate those items; it focuses on *architecture, performance, and product ambition*. Where the two overlap, this file references the audit rather than duplicating it.
>
> Status legend: `[NOW]` exists today · `[GAP]` missing/weak today · `[10X]` proposed premium direction.

---

## Table of Contents

1. [What the app is today](#1-what-the-app-is-today)
2. [Architecture map](#2-architecture-map)
3. [Operation-by-operation review](#3-operation-by-operation-review)
4. [Top architectural bottlenecks (ranked)](#4-top-architectural-bottlenecks-ranked)
5. [The 10× vision](#5-the-10x-vision)
6. [Target architecture](#6-target-architecture)
7. [Feature roadmap (10× the feature set)](#7-feature-roadmap-10x-the-feature-set)
8. [Phased implementation plan](#8-phased-implementation-plan)
9. [Phase 1 — detailed work breakdown](#9-phase-1--detailed-work-breakdown)
10. [Risks, metrics & decisions needed](#10-risks-metrics--decisions-needed)

---

## 1. What the app is today

MultiCam Viewer is an **Electron (v33) desktop app for Windows** that turns Android phones (and ordinary USB webcams) into virtual cameras consumable by OBS, Discord, Zoom, Teams, etc. Its differentiator is that it needs **no companion app on the phone** — it drives the phone's camera over USB via bundled **ADB + scrcpy**, captures the hidden scrcpy window with **Windows Graphics Capture**, optionally processes the frame (greenscreen / color), and pushes it into a **UnityCapture DirectShow virtual camera** via a Koffi-based shared-memory bridge.

**Current headline capabilities (`[NOW]`):**
- USB phone detection via ADB with per-phone camera enumeration via scrcpy.
- Real UVC webcam support via `getUserMedia`.
- Multi-camera CCTV grid (1–4 panes) in one window; additional separate windows map to additional vcam slots.
- AI greenscreen via MediaPipe Selfie Segmentation (premium), color adjustments (exposure/contrast/saturation).
- UnityCapture virtual camera output (up to 4 slots) + a clean borderless "Output Window" for OBS Window Capture.
- In-house AES-256-GCM license keys verified in the main process; free = 2 cameras, premium = 4.
- Settings persistence, themes (Dusk/Dark/Light), splash screen, obfuscation + Electron fuses hardening.

It's a genuinely good v1. The concept is strong and the security posture has matured. The ceiling, however, is much higher — and several core design choices cap performance, scalability, and the premium story.

---

## 2. Architecture map

```
┌──────────────────────────── MAIN PROCESS (main.js) ────────────────────────────┐
│  • Window factory (1 BrowserWindow per camera "instance", slot = size % 4)      │
│  • ADB: listPhones()  ── execFileSync adb devices -l                            │
│  • scrcpy: listCameras() / startScrcpyCamera() ── spawn, off-screen borderless  │
│  • desktopCapturer.getSources() → match scrcpy window by title                  │
│  • UnityCapture register (elevated regsvr32 via PowerShell string)              │
│  • vcam-native (Koffi FFI → kernel32 shared memory) writeFrame per slot         │
│  • License verify (AES-256-GCM, PBKDF2) vs bundled licenses.json                │
│  • Settings JSON in userData; app.log file logging                              │
└───────────────▲───────────────────────────────────────────────▲────────────────┘
                │ IPC (preload.js contextBridge: electronAPI)     │ vcam:frame (ArrayBuffer clone)
┌───────────────┴───────────────── RENDERER (renderer.js) ────────┴────────────────┐
│  • Source enumeration (phones + UVC)                                             │
│  • Capture: getUserMedia({chromeMediaSource:'desktop', id}) → <video>            │
│  • Frame loop: requestAnimationFrame → vcamCanvas.drawImage → getImageData       │
│    → electronAPI.vcamFrame(rgba) ── per frame, per window                        │
│  • Greenscreen: MediaPipe SelfieSegmentation on MAIN THREAD (send(video))        │
│  • Secondary panes (preview only — NOT pumped to vcam, NO greenscreen)           │
│  • Settings/license UI, premium gating                                           │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ window.open(output.html)
┌───────┴──────── OUTPUT WINDOW (output-renderer.js) ───────────────────────────────┐
│  • captureStream(30) of opener's vcam-canvas → clean borderless <video> for OBS   │
└────────────────────────────────────────────────────────────────────────────────────┘

Unused / vestigial: vcam-worker.js (WASM path, no .wasm shipped), license.js (legacy
renderer-side verify), premium-server/ (server licensing, not wired up).
```

Key files: `main.js` (~785 lines, monolithic), `renderer.js` (~1,336 lines, monolithic), `preload.js`, `vcam-native/index.js` (Koffi shared-mem writer), `output-renderer.js`, `vcam-worker.js` (dead), `index.html`/`styles.css`.

---

## 3. Operation-by-operation review

### 3.1 Phone detection (ADB)
- `[NOW]` `listPhones()` uses **synchronous** `execFileSync` on the main process, parses `adb devices -l`, and now surfaces unauthorized/offline/no-permission states with helpful messages — good.
- `[GAP]` **Blocking the main process** during ADB/scrcpy enumeration freezes all windows. With multiple windows and a slow daemon, this is noticeable.
- `[GAP]` No **wireless ADB** (TCP/IP), no persistent device registry, no friendly per-device naming/aliasing, no hot-plug push (relies on a 6× 5s retry timer + `devicechange`).

### 3.2 Camera enumeration & capture (scrcpy + Graphics Capture)
- `[NOW]` scrcpy launched **off-screen, borderless, `--no-control --no-audio`**, then located via `desktopCapturer.getSources()` and grabbed with `getUserMedia({chromeMediaSource:'desktop'})`. Clever, and it works without a phone app.
- `[GAP]` **The capture chain is long and lossy:** phone H.264 → scrcpy decode → hidden OS window → Windows Graphics Capture → Chromium desktop capture → `<video>` → canvas. Every hop is a GPU/CPU copy and adds latency (typically 80–200 ms end-to-end). It also depends on a fragile *window-title match* and the window never being minimized.
- `[GAP]` Fixed `fps: 30`, no bitrate/codec controls, no quality presets, resolution string parsing scattered. The audit's "quality modes" item applies here.
- `[GAP]` If `waitForCaptureWindow()` times out, the scrcpy process can linger (partially mitigated, but not killed on timeout).

### 3.3 Frame pipeline → virtual camera (the hot path)
This is the single most important area and the biggest performance liability.

Current per-frame work in the renderer (`startRawFrameLoop` / `sendFrameToVcam`):
1. `requestAnimationFrame` (so the loop is tied to *display* refresh, not video cadence).
2. `ctx.drawImage(video)` with a CSS `filter` string for color adjust.
3. **`ctx.getImageData(0,0,w,h)`** — a full **GPU→CPU readback** every frame (the classic canvas perf killer, even with `willReadFrequently`).
4. **`electronAPI.vcamFrame({data: img.data.buffer})`** — the RGBA buffer (1280×720×4 ≈ **3.7 MB**, 1080p ≈ 8.3 MB) is **structured-cloned across the renderer→main IPC boundary every frame**. `invoke` does **not** transfer; it copies.
5. In `vcam-native/index.js#writeFrame`: a **`Buffer.concat([header, frame])` allocates a fresh buffer every frame** (GC pressure), then `koffi.encode(pShared, headerArrayType, combined)` where `headerArrayType` is sized to **`TOTAL_SHARED_SIZE` ≈ 66 MB** (`3840*2160*4*2 + 32`). Writing through a 66 MB array type per frame is wasteful even if only the populated bytes are copied.

Net result: at 1080p60 the app moves on the order of **0.5 GB/s** through readback + IPC clone + per-frame allocations, **per window**. This caps frame rate, spikes CPU, and pressures GC.

- `[GAP]` `sendFrameToVcam` `await`s nothing meaningful but fires an async IPC per frame; there's no backpressure, so a slow main process queues frames.
- `[GAP]` Secondary panes are **preview-only** — they are never composited or pumped to a vcam slot, and greenscreen never applies to them.
- `[GAP]` FPS counter measures `requestAnimationFrame` ticks, not delivered video frames (audit noted this).

### 3.4 Greenscreen / processing
- `[NOW]` MediaPipe SelfieSegmentation, loaded from bundled `vendor/mediapipe` (good — offline), masks via canvas `destination-in` compositing with threshold/gap sliders.
- `[GAP]` Runs **on the renderer main thread** (`selfieSegmentation.send({image: video})`), competing with UI and the frame pump. At 1080p this stutters.
- `[GAP]` Uses the older `@mediapipe/selfie_segmentation` package rather than the newer **MediaPipe Tasks `ImageSegmenter`** (GPU delegate, better masks). No edge feathering/light-wrap, no background **blur**, no real chroma-key for actual greenscreens, no LUTs/AR.

### 3.5 Virtual camera output (UnityCapture)
- `[NOW]` Real shared-memory protocol implemented correctly via Koffi (mutex/events/file-mapping). Up to 4 slots, branded "MultiCam".
- `[GAP]` Depends on a **third-party DirectShow filter** registered with **elevated `regsvr32` built from a PowerShell command string** (audit flagged). No real **uninstall** flow. DirectShow is legacy on Windows 11; **Media Foundation Virtual Camera** (`MFCreateVirtualCamera`, Win 11) is the modern, signed-friendly path.
- `[GAP]` `vcam-worker.js` references a `vcam-native.wasm` that is **never shipped** — dead code/confusion.

### 3.6 Windowing & process model
- `[NOW]` Each camera "instance" is a separate `BrowserWindow`; slot = `windows.size % 4`. Multi-instance lock deliberately disabled.
- `[GAP]` Separate windows = heavy: each is a full renderer (~100–150 MB). The "scene/layers" mental model doesn't exist; everything is one-camera-per-window with a bolt-on grid.

### 3.7 Licensing
- `[NOW]` AES-256-GCM keys, verified main-side against bundled `licenses.json`. Decent for offline.
- `[GAP]` `licenses.json` ships with the app and is **plaintext-editable**; the key DB is the trust root. `premium-server/` exists but is **unused**. No device binding, no online activation, no revocation propagation, no tiers beyond camera count.

### 3.8 Code organization, testing, observability
- `[GAP]` Two monoliths (`main.js`, `renderer.js`), **no tests**, **no lint/format**, **no module boundaries**, `console.log` noise, no crash reporting, no auto-update (all echoed by the audit).

---

## 4. Top architectural bottlenecks (ranked)

| # | Bottleneck | Impact | 10× direction |
|---|-----------|--------|---------------|
| 1 | **Per-frame `getImageData` + IPC clone + `Buffer.concat`** in the vcam hot path | Caps FPS, high CPU/GC, worse at 1080p+ and per extra window | Zero-copy pipeline: composite in a worker/WebGPU, write to a **persistent mapped shared-memory pointer** from a Node `worker_thread` using a `SharedArrayBuffer` ring buffer (no clone, no concat) |
| 2 | **Long capture chain** (scrcpy window → Graphics Capture → desktop getUserMedia) | Latency, fragility (title match, no-minimize), CPU | Consume scrcpy's **raw H.264 socket** and decode with **WebCodecs `VideoDecoder`** → `VideoFrame` straight into the compositor; drop the OS-window hop entirely |
| 3 | **Greenscreen on main thread** w/ legacy model | UI stutter, mediocre matte | Move segmentation to a **worker + OffscreenCanvas**, upgrade to **MediaPipe Tasks ImageSegmenter (GPU)** or WebGPU matting; add blur/feather/light-wrap |
| 4 | **One BrowserWindow per camera; panes not composited to output** | Memory, no true multi-source output, limited premium story | **Single-app scene compositor**: N sources → M independent virtual cameras, each its own scene/layout |
| 5 | **Synchronous ADB/scrcpy on main process** | Freezes UI | Async `execFile`/worker; device service with event stream |
| 6 | **Legacy DirectShow vcam + fragile elevated install** | Win11 friction, no uninstall, signing pain | Add **Media Foundation Virtual Camera** path; proper signed install/uninstall helper |
| 7 | **Offline-editable license DB, unused server** | Weak monetization/anti-piracy | Signed tokens (Ed25519) + online activation w/ device binding + offline grace |
| 8 | **Monolith, no tests/CI** | Slows everything below | Modularize + Vitest + ESLint/Prettier + CI |

---

## 5. The 10× vision

**Reposition from "phone-as-webcam utility" → "a privacy-first, USB-native virtual camera *studio*."**

The product north star: a creator plugs in one or more phones and/or webcams and gets a **multi-scene, multi-output, GPU-accelerated production surface** — compositing, real-time effects, audio, recording, and several independent virtual cameras — all processed **locally, over USB, with no phone app and no cloud**.

The three pillars:

1. **Performance & infra (10× the engine):** a zero-copy, GPU-accelerated capture→process→output pipeline built on WebCodecs + WebGPU + worker threads + shared memory, replacing the rAF/getImageData/IPC-clone chain. Modern Media Foundation virtual camera alongside UnityCapture.

2. **Production features (10× the features):** scenes & layers, transforms/crop/PTZ, multiple simultaneous virtual cameras, real chroma key + AI matting + background blur/replace, color grading & LUTs, overlays/text/logos, audio capture & mixing, local recording, and streaming (RTMP/NDI).

3. **Platform & business (10× the polish):** modular codebase + tests + CI, auto-update with channels, crash/telemetry (opt-in), robust device service (wired + wireless ADB), online licensing with tiers, onboarding wizard, diagnostics, and eventually macOS/Linux.

---

## 6. Target architecture

```
                         ┌────────────────────────── MAIN (Node) ─────────────────────────┐
                         │  DeviceService (async ADB, wired+wifi, event stream)            │
                         │  CaptureService (scrcpy raw-socket spawn + lifecycle)           │
                         │  VcamService: UnityCapture (DirectShow) + MF Virtual Camera      │
                         │  LicenseService (Ed25519 tokens, online activation + grace)      │
                         │  UpdateService (electron-updater, channels)                      │
                         │  RecordingService / StreamingService (ffmpeg sidecar)            │
                         └───────▲───────────────────────────────────────────▲──────────────┘
                                 │ structured IPC (typed, validated)          │
                                 │                              SharedArrayBuffer ring (frames)
                         ┌───────┴──────────────── RENDERER (UI only) ────────┴──────────────┐
                         │  React/Svelte UI · scene manager · device panel · settings        │
                         └───────▲────────────────────────────────────────────────────────────┘
                                 │ postMessage (control) + SAB (frames)
   ┌─────────────────────────────┴─────────────────── WORKERS ───────────────────────────────┐
   │  DecodeWorker[N]:  WebCodecs VideoDecoder(scrcpy H.264) → VideoFrame                      │
   │  ComposeWorker:    WebGPU pipeline → scenes/layers, chroma key, AI matte, color, overlays │
   │                    → render to texture → readback to SAB (or GPU interop)                 │
   │  SegmentWorker:    MediaPipe Tasks ImageSegmenter (GPU delegate) → mask texture           │
   │  VcamWriteWorker:  worker_thread w/ koffi, persistent mapped ptr, reads SAB → memcpy       │
   └─────────────────────────────────────────────────────────────────────────────────────────┘
```

Principles:
- **One process, many sources, many outputs.** Windows become *views*, not capture units.
- **Frames never cross IPC as clones.** Use `SharedArrayBuffer` ring buffers + transferable `VideoFrame`s.
- **GPU-first.** Composite and key on the GPU (WebGPU/WebGL2); only one readback per output frame, ideally into a pre-allocated SAB the writer thread already maps to shared memory.
- **Services are modules with typed IPC contracts**, individually testable.

---

## 7. Feature roadmap (10× the feature set)

**Capture & sources**
- `[10X]` WebCodecs decode of scrcpy raw stream (low-latency, fewer copies).
- `[10X]` Wireless ADB (Wi-Fi) + device aliasing + persistent device registry.
- `[10X]` Phone camera controls where exposed: front/back switch, zoom, torch, focus, AE/AWB lock.
- `[10X]` Additional source types: screen/region capture, image/video files, browser/URL source, NDI input.

**Compositing & effects (GPU)**
- `[10X]` **Scenes + layers** with transform/crop/rotate/opacity, snapping, and hotkey scene switching.
- `[10X]` **Real chroma key** (greenscreen) + **AI matting** (ImageSegmenter) + **background blur** + image/video backgrounds + light-wrap & edge feather.
- `[10X]` Color grading: white balance, tint, gamma, **3D LUT (.cube)** import, sharpening, denoise.
- `[10X]` Overlays: text, timers, logos/watermark, lower-thirds, PNG/GIF, picture-in-picture, borders/masks.
- `[10X]` Transitions (cut/fade/stinger) between scenes.

**Output**
- `[10X]` **Multiple simultaneous virtual cameras**, each bound to a scene (not 1 window = 1 slot).
- `[10X]` **Media Foundation Virtual Camera** (Win 11) in addition to UnityCapture.
- `[10X]` **Local recording** (MP4/WebM, hardware-encoded via ffmpeg sidecar) with hotkeys.
- `[10X]` **Streaming**: RTMP/SRT push + **NDI** output for studio networks.

**Audio**
- `[10X]` Phone-mic and PC audio capture, per-source gain/mute/monitor, simple mixer, A/V sync for recording.

**Platform & business**
- `[10X]` Onboarding wizard + diagnostics export (from audit).
- `[10X]` Auto-update with stable/beta channels; opt-in crash & usage telemetry.
- `[10X]` Online licensing: tiers (Free / Pro / Studio), device-bound activation, offline grace, revocation.
- `[10X]` Plugin/extension API (sources, effects, outputs) — community ecosystem.
- `[10X]` macOS/Linux via platform-abstracted capture & vcam backends.

---

## 8. Phased implementation plan

Each phase ships something usable and de-risks the next. Phases 1–2 are **engine/infra** (the "10× infra"); Phases 3–5 are **features**; Phase 6 is **platform/business**.

| Phase | Theme | Goal | Headline outcomes |
|------|-------|------|-------------------|
| **0** | Foundations | Make change safe | Modularize `main.js`/`renderer.js`, add ESLint/Prettier, Vitest, CI, typed IPC, kill dead code (`vcam-worker.js`, legacy `license.js`) |
| **1** | Hot-path rewrite | 10× the engine core | Zero-copy frame pipeline: worker-thread vcam writer + `SharedArrayBuffer` ring, remove per-frame `getImageData`/IPC-clone/`Buffer.concat`; accurate FPS via `requestVideoFrameCallback` |
| **2** | Capture & GPU | Low-latency + GPU compositor | WebCodecs decode of scrcpy stream; WebGPU/WebGL2 compositor; segmentation moved to worker |
| **3** | Studio core | Scenes/layers + multi-output | Scene/layer model, transforms, multiple independent virtual cameras (incl. MF vcam) |
| **4** | Effects & audio | Premium creative suite | Chroma key + AI matte + blur, LUTs/color, overlays/text, audio capture & mixer |
| **5** | Record & stream | Output everywhere | Recording (ffmpeg), RTMP/SRT, NDI |
| **6** | Platform & biz | Scale & monetize | Auto-update + channels, online licensing/tiers, telemetry, onboarding/diagnostics, plugin API, macOS/Linux |

**Sequencing rationale:** Phase 1 first because the frame hot path limits *everything* (FPS, CPU headroom for effects, number of concurrent outputs). Phase 0 runs in parallel/ahead because the monoliths make every later change risky.

---

## 9. Phase 1 — detailed work breakdown

**Objective:** Eliminate the per-frame readback + IPC-clone + per-frame allocation, and decouple the output cadence from the display, *without changing the user-visible feature set*. This is the highest-leverage, lowest-feature-risk change.

### 9.1 Design
- Allocate a **`SharedArrayBuffer` ring** (e.g. 3 slots) sized for the negotiated resolution: `slots × (width*height*4) + control header`. Use `Atomics` for write-index/read-index handoff.
- Renderer composites into an **`OffscreenCanvas`** and uses **one** readback per output frame **into the SAB** (or, intermediate step: keep the canvas but switch to a single pre-allocated `Uint8ClampedArray` and `getImageData` into it via `ctx.getImageData` reuse / `copyTo`), avoiding a fresh `ImageData` per frame.
- A **Node `worker_thread`** in the main process holds the Koffi handles and the **persistent mapped pointer**, reads the latest SAB slot, and does a **single `koffi.encode` of exactly `width*height*4` bytes** (plus a one-time header write), removing the `Buffer.concat` and the 66 MB array-type per frame.
- Drive the loop from **`video.requestVideoFrameCallback`** (true video cadence) instead of `requestAnimationFrame`; this also fixes the FPS meter.

### 9.2 Tasks
1. **Measure first.** Add a dev-only perf HUD: real delivered FPS (`requestVideoFrameCallback`), readback ms, write ms, dropped frames. Capture a 1080p60 baseline.
2. **Refactor `vcam-native/index.js`:**
   - Precompute and **write the header once** on `init` (it's constant per stream).
   - In `writeFrame`, write **only the pixel region** via a persistent typed pointer/`koffi.array(uint8, width*height*4)`; drop `Buffer.concat`.
   - Add a `writeFromShared(sabView, len)` entry that copies directly from the SAB.
3. **Add a `worker_thread` vcam writer** (`main/vcam-writer.worker.js`): owns the SAB, the mutex/event handles, and the mapped pointer; spins on `Atomics.wait`/notify or a small poll, writes newest frame, sets the `Sent` event. Main process creates one per active slot.
4. **Renderer frame loop rewrite:**
   - Replace `startRawFrameLoop` with a `requestVideoFrameCallback` loop.
   - Write composited pixels into the SAB slot; `Atomics.store` the write index; `postMessage` only a tiny "frame ready" signal (or rely on the worker polling). **No more `vcamFrame({data})` 3.7 MB clone.**
5. **Wire SAB across processes.** Establish the SAB once at `vcam:init` (pass via `postMessage` to the worker thread; renderer↔main share via a `MessageChannel`/`MessagePort` that carries the SAB — note: SAB sharing renderer→main needs a port handoff, validate Electron support; fallback is transferable `ArrayBuffer` with a 1-slot double buffer).
6. **Backpressure & frame dropping:** if the writer is behind, the renderer overwrites the newest slot (drop-old policy) rather than queueing.
7. **Validate** against OBS/Discord: image correct (RGBA→BGRA handled by filter), no tearing, stable at 1080p60, CPU down materially vs baseline.

### 9.3 Acceptance criteria
- 1080p60 sustained on a mid-range PC with **single window** at noticeably lower CPU than baseline (target: ≥40% reduction in the frame path).
- No per-frame heap allocations in the hot path (verify via a heap-profile snapshot — flat allocation timeline).
- FPS meter reflects **actual delivered frames**.
- No regressions: greenscreen, color adjust, output window, multi-pane preview all still work.

### 9.4 Guardrails
- Keep the old path behind a feature flag until the new one is proven, so we can ship/rollback safely.
- This phase **must not** require touching the licensing or UI beyond the perf HUD — keep the blast radius small.

> **Note on Phase 0 (do alongside Phase 1):** before heavy hot-path surgery, split `vcam-native` and the frame code into their own modules and add a couple of unit tests (ADB parser, scrcpy camera parser, slot labeling, the new ring-buffer index math). This makes Phase 1 verifiable and protects the rest of the app.

---

## 10. Risks, metrics & decisions needed

### Risks
- **SAB across Electron processes**: renderer↔main `SharedArrayBuffer` handoff has caveats (COOP/COEP headers, `MessagePort` transfer). If blocked, fall back to **transferable** `ArrayBuffer` double-buffering (still removes the clone, keeps one copy) or do the composite in the main process via OffscreenCanvas in a Node worker.
- **WebCodecs/WebGPU availability** (Phase 2): both are present in Electron 33's Chromium, but the scrcpy raw-socket protocol integration is non-trivial — prototype behind a flag, keep the Graphics-Capture path as fallback.
- **Media Foundation vcam** (Phase 3): requires a signed package for production; plan code-signing early (see audit).
- **Scope creep**: the feature list is large; enforce the phase gates and "ship usable each phase" rule.

### Success metrics
- **Latency**: glass-to-OBS end-to-end (target <80 ms with WebCodecs path vs ~150 ms today).
- **CPU/GPU per output** at 1080p60 (target: ≥2× more concurrent outputs at equal CPU).
- **Frame stability**: dropped-frame % under load.
- **Crash-free sessions** and update adoption (Phase 6).

### Decisions needed from the product owner
1. **Primary vcam strategy** going forward: keep UnityCapture, add Media Foundation, or migrate? (Affects Phase 3 and signing.)
2. **UI framework** for the studio rebuild: stay vanilla, or adopt React/Svelte? (Affects Phase 0/3 effort.)
3. **Licensing model**: stay offline, or stand up the existing `premium-server/` for online activation + tiers? (Affects Phase 6 and pricing.)
4. **Cross-platform**: is macOS/Linux in scope, or Windows-only premium? (Affects abstraction work throughout.)
5. **Tiering**: which 10× features are Free vs Pro vs Studio?

---

---

## Implementation log

**Phase 0 (foundations) — started:**
- Extracted pure, dependency-free logic from `main.js` into **`lib/parsers.js`** (ADB device parser, scrcpy camera parser, slot label, `clampInt`, serial/cameraId/windowTitle/resolution validators, ring-buffer index math). `main.js` now imports these; added `lib/**/*` to `build.files`.
- Added **`test/parsers.test.js`** (16 `node:test` cases) and a `npm test` script. All passing.
- Removed dead code: **`vcam-worker.js`** (referenced a `vcam-native.wasm` that was never shipped) and **`license.js`** (legacy renderer-side verify, unused in builds). Updated README structure.

**Phase 1 (hot-path) — first cut landed:**
- **`vcam-native/index.js`**: the `SharedMemHeader` is now written **once** at `init()` (it's constant per stream); `writeFrame()` writes **only** the pixel region via a pre-sized koffi array type at the correct offset. This removes the per-frame `Buffer.concat` allocation and the per-frame encode through a ~66 MB array type. Byte-layout verified against the installed koffi (`encode(ptr, offset, type, value)` copies exactly `dataSize` bytes).
- **`renderer.js`**: the raw-preview frame loop now uses **`requestVideoFrameCallback`** (true source cadence; avoids redundant readback + IPC on high-refresh displays), with a `requestAnimationFrame` fallback. The greenscreen/segmentation loop intentionally stays on rAF because `cameraVideo` is hidden during segmentation and rVFC may not fire for non-composited videos. The **FPS meter now counts frames actually delivered** to the vcam, and a dev `PERF_HUD` flag surfaces readback timing.

**Still open in Phase 1 (deferred, higher risk / needs hardware verification):** the renderer→main **per-frame IPC clone** of the RGBA buffer and the `getImageData` readback remain. Removing these requires the `SharedArrayBuffer` ring + `worker_thread` writer described in §9, which needs end-to-end testing on Windows with OBS before it can replace the current path. Tracked as the next Phase 1 task behind a feature flag.

**Phase 1 (hot-path) — second cut landed (reliability + bounded latency):**
- **Async ADB/scrcpy enumeration** (`main.js`): `listPhones()` and `listCameras()` now use a new `execFileAsyncSafe()` (async `execFile`) instead of `execFileSyncSafe`. This removes the last **synchronous process calls on the main process**, so a slow ADB daemon or scrcpy camera enumeration can no longer freeze every window. The async helper preserves the sync version's key quirk (scrcpy `--list-cameras` exits non-zero but still emits output → treated as success). IPC handlers already `await` these.
- **Frame-dropping backpressure** (`renderer.js` `sendFrameToVcam`): if the previous frame's `vcamFrame` IPC hasn't resolved yet, the new frame is **dropped** instead of queueing another multi-MB readback + clone. This bounds memory and latency under load and lets `requestVideoFrameCallback` naturally throttle the loop. The flag is cleared in `stopVcamOutput()` so a restart isn't blocked.
- **No more lingering scrcpy** (`renderer.js`): both the primary and secondary-pane phone-capture paths now **kill the scrcpy process** whenever they fail to attach after starting it — on `waitForCaptureWindow` timeout, on a mid-wait selection change, and on a final `getUserMedia` capture error. Previously the off-screen borderless scrcpy window could keep running invisibly.

**Phase 2 (capture & GPU) — started (WebGL2 compositor, feature-flagged):**
- Added a **WebGL2 GPU compositor** in `renderer.js` behind `USE_WEBGL_COMPOSITOR = false` (off by default; the 2D canvas path remains the safe default). When enabled and WebGL2 is available, the **raw (non-greenscreen) frame path** uploads the video as a GPU texture (`texImage2D` from the `<video>` element — no CPU copy for the draw) and applies brightness/contrast/saturation in a **fragment shader** (GPU) instead of a 2D-canvas CSS filter (CPU composite). Readback uses a single `readPixels` into a **reusable `Uint8Array`** + an in-place Y-flip to top-down order (verified correct), replacing the per-frame `getImageData` allocation.
- This is the **foundation for Phase 4 GPU effects** (chroma key, LUTs, multi-layer) — the shader program is the extension point.
- Greenscreen still composites on the 2D canvas for now; `startFrameLoop` transparently disposes the GL compositor and acquires a 2D context when greenscreen is toggled on, and `stopVcamOutput`/`restartFrameLoop` were updated to handle the GL-active state. Falls back to 2D automatically if WebGL2 is unavailable or shader compile/link fails.
- **Needs runtime verification** on Windows with a real camera + OBS before flipping the flag on: confirm (1) the preview/output-window orientation is correct, (2) the vcam feed in OBS is right-side up, (3) color adjustments match the 2D path, (4) FPS/CPU is ≥ the 2D path.
- **Still open in Phase 2:** WebCodecs decode of the scrcpy raw stream (eliminate the OS-window capture hop) and moving segmentation to a worker + OffscreenCanvas. Both are hardware-gated.

---

*Companion document: `review/application-audit.md` (release-readiness, security, packaging, privacy). This file owns the architecture/performance/feature direction; the audit owns ship-blockers. Keep both in sync as phases land.*
