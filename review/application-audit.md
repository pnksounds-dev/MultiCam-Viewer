# MultiCam Viewer Application Audit

Date: 2026-06-23 (last updated 2026-06-23)
Scope: Electron desktop application code, renderer UI, camera capture flow, virtual camera flow, packaging configuration, and public release readiness.

## Completed changes since initial audit

The following items from the initial audit have been addressed:

### Security — completed

- **CSP meta tags added** to both `index.html` and `output.html` (Critical #3 / Action #13).
- **Permission handling restricted** — `setPermissionRequestHandler` and `setPermissionCheckHandler` now only allow `media` and `display-capture`; all other permissions are denied (Critical #3 / Action #3).
- **Navigation blocking** — `will-navigate` handler prevents navigation away from local `file://` URLs (Security improvement).
- **`setWindowOpenHandler` validation** — only `output.html` is allowed; all other URLs are denied (Action #12).
- **IPC input validation** — `isValidSerial()`, `isValidCameraId()`, `isValidWindowTitle()`, resolution format validation, and clamping for move deltas and numeric args (Critical #4 / Action #4).
- **`open-external` IPC handler** — validates URLs start with `http://` or `https://` before opening in the default browser.

### Settings persistence — completed

- **Full settings persistence implemented** — settings are stored in `settings.json` under `app.getPath('userData')` and loaded on startup (Action #8 / Product upgrade #4).
- Persisted values include: `showSplash`, `resolution`, `lastDeviceIndex`, `greenscreenEnabled`, `gsThreshold`, `gsGap`, `bgColor`, `exposure`, `contrast`, `saturation`, `licenseKey`, `licensedCameras`.
- Settings are saved debounced via `saveSettingsDebounced()` on every UI change.
- Default settings are merged with saved settings on startup so new keys are written without overwriting user values.

### Multi-camera grid — completed (was Phase 3 differentiator)

- **Dynamic CCTV-style camera grid** replacing the old picture-in-picture layout.
- Supports 1–4 cameras side-by-side with responsive CSS grid layouts.
- Each camera pane has its own header with a device dropdown and close button.
- Panes are managed dynamically via `addSecondaryPane()` / `removeSecondaryPane()`.
- Camera grid layouts: 1 (full), 2 (side-by-side), 3 (one large + two stacked), 4 (2×2 grid).

### Premium license key system — completed (replaces Stripe plan)

- **In-house encrypted license key system** instead of Stripe subscription.
- `license.js` — client-side AES-256-GCM decryption and verification using Web Crypto API.
- `license-generator.js` — admin CLI tool to generate encrypted license keys.
- `licenses.json` — bundled key database that the app verifies against.
- License activation UI in Settings → Premium License section.
- Camera count gating: free = 2 cameras, licensed = up to 4 cameras.
- License key and camera count persisted in settings.

### Settings menu redesign — completed

- Settings panel now fills **92vw × 92vh** (max 1200px wide) instead of fixed 560px.
- Body uses a responsive CSS grid (`auto-fit, minmax(420px, 1fr)`) for multi-column layout.
- Internal scrolling within the panel body.

### Virtual camera branding — completed

- UnityCapture driver friendly name changed from "Unity Video Capture" to "MultiCam".
- Install scripts (`install-vcam.bat`, `install-multiple-devices.bat`) updated for new naming.
- README and settings text updated to reflect MultiCam branding.

---

## Remaining items (not yet completed)

The findings below have NOT been addressed yet.

## Executive summary

MultiCam Viewer already has a strong core concept: it detects Android phones through bundled ADB/scrcpy, captures phone camera output, supports UVC cameras, offers a clean OBS output window, and includes a UnityCapture virtual camera registration path. The application is promising for a public Windows release, but it is not yet at peak shipping quality.

The biggest remaining release blockers are packaging completeness, virtual camera implementation reliability, lack of automated tests/diagnostics, and missing public-release metadata such as app identity, code signing, licensing notices, privacy documentation, and update strategy.

**Completed since initial audit:** CSP headers, permission restriction, IPC validation, navigation blocking, window-open validation, full settings persistence, multi-camera grid (up to 4 cameras), in-house license key system, settings menu redesign, and virtual camera branding.

## Current strengths

- **Clear product value**: Turns Android phones and USB webcams into usable video sources for OBS/Discord/Zoom.
- **Bundled capture stack**: The app packages `adb.exe`, `scrcpy.exe`, and required DLLs under `tools/`, reducing setup friction.
- **Good first-run guidance**: The main UI explains USB debugging and Android native webcam mode when no camera is found.
- **Safe Electron defaults in main window**: `contextIsolation` is enabled, `nodeIntegration` is disabled, and a preload bridge is used.
- **Multi-window idea**: Each new camera window maps to a different UnityCapture slot, which is a good path for multi-phone users.
- **OBS-friendly output mode**: The separate output window gives users a clean capture target even if virtual camera output is unavailable.
- **Progressive feature set**: Green screen, exposure/contrast/saturation, and background image support are useful differentiators.

## Critical findings before public release

### 1. Packaged build may miss required runtime files

`package.json` includes explicit files for Electron Builder, but the app loads MediaPipe from `node_modules` in `index.html`:

- `index.html` loads `node_modules/@mediapipe/selfie_segmentation/selfie_segmentation.js`.
- `package.json` `build.files` does not include `node_modules/@mediapipe/...`.
- `renderer.js` then loads MediaPipe model/assets from jsDelivr CDN.

Impact:

- Green screen may fail in the packaged EXE if the local script is not included.
- Green screen may fail offline or in restricted networks because model assets are loaded from CDN.
- Public users may experience a feature that appears present but silently fails.

Recommendation:

- Bundle all required MediaPipe JS/WASM/model assets into the app package.
- Change `locateFile` to resolve local packaged assets instead of `https://cdn.jsdelivr.net/...`.
- Add a clear UI error if green screen assets cannot load.

### 2. Virtual camera shared-memory path is probably incomplete

The worker tries to load `vcam-native.wasm`, but `package.json` does not list this file, and the repository listing did not show it at the root. `vcam-worker.js` says the shared-memory path is optional and falls back to no-op.

Impact:

- The UI may say the UnityCapture driver is registered, but frames may not actually be written to the virtual camera unless the missing native/WASM bridge exists.
- For public users, this could feel like the headline feature is broken.

Recommendation:

- Decide on the official output path:
  - Either ship a fully working virtual camera frame writer, or
  - Market the app as OBS/window-capture first and label UnityCapture as experimental.
- Add an end-to-end validation check: after registration, verify that frame writing is actually available, not just that the driver exists.
- Include `vcam-native.wasm` in `build.files` if this is the intended implementation.
- Consider replacing UnityCapture integration with a maintained, signed, app-owned virtual camera driver or an OBS plugin for a more professional release.

### 3. ~~Permission policy is too broad~~ — COMPLETED

**Resolved.** `main.js` now uses `setPermissionRequestHandler` and `setPermissionCheckHandler` with an explicit allowlist (`ALLOWED_PERMISSIONS = Set(['media', 'display-capture'])`). All other permissions are denied. Navigation is blocked via `will-navigate` handler. `setWindowOpenHandler` only allows `output.html`.

~~`main.js` grants every permission request and every permission check for the app session.~~

Impact:

- This is risky for a public Electron application.
- Any future remote content, accidental navigation, injected content, or opened window could gain media/display permissions without user intent.

Recommendation:

- Restrict permissions to known origins/files and specific permissions.
- Allow only required permissions such as `media`, `display-capture`, and only for trusted app windows.
- Deny everything else by default.
- Add a security checklist before enabling any web content or links.

### 4. ~~IPC input validation is minimal~~ — COMPLETED

**Resolved.** All IPC handlers now validate inputs: `isValidSerial()` (alphanumeric + `._:-`), `isValidCameraId()` (1-4 digit numeric), `isValidWindowTitle()` (safe charset), resolution format check (`\d{1,4}x\d{1,4}`), and clamping for move deltas and numeric arguments.

~~The preload bridge exposes powerful operations: ADB scanning, scrcpy spawning, virtual camera registration, opening windows, moving windows, and dialogs. Main-process handlers trust renderer-provided values such as `serial`, `cameraId`, `maxSize`, `fps`, `windowTitle`, and output-window move deltas.~~

Impact:

- Current risk is reduced because `nodeIntegration` is disabled and local app files are used.
- Still, public-release Electron apps should validate all IPC input because renderer compromise should not automatically become process/control compromise.

Recommendation:

- Validate IPC payload schemas in `main.js`.
- Restrict `serial`, `cameraId`, `maxSize`, `fps`, and `windowTitle` to expected formats/ranges.
- Clamp output-window movement deltas.
- Avoid sending raw user-controlled values to process spawning or shell commands.

### 5. Shell command usage for driver registration needs hardening

`registerVcam()` builds a PowerShell command string that runs elevated `regsvr32`. The DLL path is derived from app resources, so this is not directly user-controlled, but command-string execution is still fragile.

Impact:

- Quoting/escaping errors can cause registration failures.
- Security reviewers may flag shell string execution.
- UAC behavior and error reporting can be inconsistent.

Recommendation:

- Use `spawn`/`execFile` with argument arrays where possible.
- Consider a dedicated helper executable for registration/unregistration.
- Add an actual `unregisterVcam` IPC handler instead of telling users to run `regsvr32 /u` manually.
- Make the installer optionally register/unregister the driver during install/uninstall with a clear consent screen.

## High-priority product upgrades

### 1. Add a first-run setup wizard

A public user should not need to understand ADB, scrcpy, drivers, or OBS terms upfront.

Recommended wizard steps:

1. Welcome and privacy explanation.
2. Choose source type: Android USB Debugging, Android native webcam, normal USB camera.
3. Phone setup checklist with live detection.
4. Camera permission check.
5. Output choice: OBS Window Capture, virtual camera, Discord/Zoom.
6. Optional driver registration with clear admin/UAC explanation.
7. Test screen showing video and FPS.

### 2. Add built-in diagnostics and support export

Recommended diagnostics:

- App version, Electron version, Windows version.
- Packaged/unpackaged mode.
- ADB path and version.
- scrcpy path and version.
- Connected ADB devices including unauthorized/offline statuses.
- Camera list results.
- Virtual camera registration status.
- Recent scrcpy logs.
- Media permission results.

Add a `Copy diagnostics` button and a `Save support report` button. This will dramatically reduce support effort after public release.

### 3. Improve ADB device state handling

`listPhones()` currently only includes lines matching `device`. It ignores `unauthorized`, `offline`, `no permissions`, and other states.

Recommendation:

- Parse all `adb devices -l` states.
- Show specific UI actions:
  - Unauthorized: unlock phone and accept USB debugging prompt.
  - Offline: reconnect cable/restart ADB.
  - No devices: check cable/developer options.
- Add a `Restart ADB` button.

### 4. ~~Make camera selection and settings persistent~~ — COMPLETED

**Resolved.** Settings are persisted in `settings.json` under `app.getPath('userData')`. All UI changes save debounced via `saveSettingsDebounced()`. Persisted values: `showSplash`, `resolution`, `lastDeviceIndex`, `greenscreenEnabled`, `gsThreshold`, `gsGap`, `bgColor`, `exposure`, `contrast`, `saturation`, `licenseKey`, `licensedCameras`. Defaults are merged on startup without overwriting user values.

~~Currently preferences are held in memory. Public users expect the app to remember choices.~~

Persist:

- Last selected resolution.
- Last selected source type/device where safe.
- Green screen enabled state and thresholds.
- Background color/image choice.
- Exposure/contrast/saturation.
- Preferred output mode.
- Auto-start camera on launch.

Use a small local settings file or `electron-store`.

### 5. Add quality modes instead of only resolution

Current phone capture uses `--max-size` and fixed `fps: 30`. UVC capture requests up to 60 FPS.

Recommendation:

- Add presets:
  - Performance: 720p30.
  - Balanced: 1080p30.
  - Quality: 1080p60 or best available.
  - Custom.
- Expose frame rate separately.
- Show actual negotiated camera settings after start.
- Consider bitrate/codec tuning where scrcpy supports it.

## Packaging and EXE release readiness

### Current packaging status

- Uses `electron-builder` with NSIS target.
- Has existing `dist/` output.
- Bundles app files plus `tools/` and `vcam/` as `extraResources`.
- Product name is `MultiCam Viewer`.
- `author` is empty and license is `ISC`.
- No visible code signing configuration.
- No visible app icon included in packaged `build.files`, though `main.js` looks for `assets/icon.png`.

### Required before public EXE launch

- **Code signing**: Sign the EXE/installer to reduce SmartScreen warnings over time.
- **Installer polish**: Add publisher, icon, app description, license page, and clear driver consent.
- **Auto-update plan**: Add `electron-updater` or define a manual update path.
- **Versioning**: Move beyond `1.0.0` only when the release is truly stable; consider `0.9.0-beta` for early public testing.
- **License notices**: Include third-party notices for Electron, scrcpy, ADB/platform-tools, MediaPipe, UnityCapture, and all bundled DLLs.
- **Privacy policy**: Explain camera access, ADB usage, local-only processing, no cloud upload unless that changes.
- **Terms/support**: Add website/support email/bug report link.
- **Asset inclusion**: Ensure `assets/icon.png`, MediaPipe assets, and any virtual camera bridge are included.
- **Clean build output**: Do not ship development folders like `useful files/` unless intentionally included. It is currently not in `build.files`, which is good.

## Security review

### Good security choices already present

- `contextIsolation: true`.
- `nodeIntegration: false`.
- Local files are loaded with `loadFile`.
- Main process owns native operations through IPC.

### Security improvements needed

- ~~Replace blanket permission approval with explicit allowlist.~~ — **DONE**
- ~~Add IPC schema validation.~~ — **DONE**
- ~~Add `setWindowOpenHandler` URL validation so only `output.html` can be opened.~~ — **DONE**
- ~~Add a Content Security Policy to `index.html` and `output.html`.~~ — **DONE**
- Avoid loading MediaPipe from CDN in production.
- ~~Prevent navigation away from local app files.~~ — **DONE**
- Sanitize and constrain dialog options exposed through IPC.
- Remove or gate `console.log`/`console.error` noise in public builds, or route it to a diagnostic log.

## Reliability and stability review

### Potential reliability issues

- Synchronous process calls in `main.js` can block the Electron main process while ADB/scrcpy commands run.
- `navigator.mediaDevices.addEventListener('devicechange', refreshSources)` may not exist in older Chromium contexts without a guard.
- `refreshSources()` can be called repeatedly and concurrently through F5/devicechange/retry timers.
- If scrcpy launches but the capture window is not found, the scrcpy process may remain running until selection changes or window unload.
- `stopCamera()` sends `stopScrcpy()` but does not await confirmation.
- FPS counter measures animation frames, not actual video frames.
- Green screen processing and `getImageData()` every frame are CPU-heavy, especially at 1080p.
- Worker frame transfer detaches `img.data.buffer`; this is acceptable for the copied `ImageData`, but performance should be profiled.

### Recommendations

- Add a single-flight/debounce guard around `refreshSources()`.
- Kill scrcpy if `waitForCaptureWindow()` times out.
- Move blocking ADB/scrcpy list operations to async `execFile` or worker process.
- Use `requestVideoFrameCallback` for more accurate FPS and efficient frame processing where available.
- Add watchdogs for black frames, frozen streams, and scrcpy process exit.
- Add structured error codes instead of only status text.

## UI/UX review

### What works well

- Compact single-window layout.
- Clear status bar.
- In-app connection guide.
- Dedicated output window is a strong OBS workflow.
- Settings overlay contains useful setup explanations.

### Improvements to make it feel premium

- Add branded icon/logo and improved visual identity.
- Add onboarding wizard instead of only static guide text.
- Add tooltips/help links beside technical features.
- Add an always-visible health indicator for source, capture, processing, and output.
- Show live preview thumbnails in camera dropdown if feasible.
- Add `Start`, `Stop`, and `Reconnect` buttons instead of relying entirely on dropdown changes.
- Add keyboard accessibility and visible focus states.
- Add high-DPI and small-screen layout testing.
- Split output window controls into a polished overlay with fade/hide behavior.
- Add user-friendly names for phones/cameras.

## Code organization review

Current code is functional but concentrated in large files:

- `main.js` contains process management, ADB, scrcpy, driver registration, window creation, and IPC.
- `renderer.js` contains DOM refs, state, source enumeration, capture startup, canvas rendering, segmentation, virtual camera output, settings, and events.
- `output.html` contains inline CSS instead of shared styling.

Recommendation:

- Split into modules before the app grows further:
  - `main/adb.js`
  - `main/scrcpy.js`
  - `main/vcam.js`
  - `main/windows.js`
  - `main/ipc.js`
  - `renderer/sources.js`
  - `renderer/capture.js`
  - `renderer/processing.js`
  - `renderer/settings.js`
  - `renderer/ui.js`
- Add a minimal build step if needed, but keep the app easy to package.
- Add linting/formatting (`eslint`, `prettier`) and enforce it before builds.

## Testing recommendations

Add test coverage in layers:

### Unit tests

- ADB device parser.
- scrcpy camera-list parser.
- virtual camera slot labels.
- resolution/max-size mapping.
- IPC validation schemas.

### Integration tests

- App launches packaged and unpackaged.
- Main window loads without console errors.
- Output window opens and closes.
- Permission handling works.
- Missing `tools/` or missing `vcam/` produces friendly errors.

### Manual release matrix

Test before public launch on:

- Windows 10 2004+.
- Windows 11 current.
- Standard user account and admin account.
- OBS, Discord, Zoom, Teams.
- Android 12, 13, 14, 15+.
- Samsung, Pixel, OnePlus/Xiaomi if available.
- Authorized, unauthorized, offline, and no-device ADB states.
- USB 2 and USB 3 ports/cables.
- One, two, and three simultaneous phones.

## Marketing and public positioning recommendations

### Strongest positioning

"Use your Android phone as a clean, low-latency webcam for OBS and calls over USB — no phone app required."

### Features worth highlighting

- No phone app installation.
- USB reliability vs Wi-Fi webcam apps.
- Multi-phone support.
- OBS clean output window.
- Optional virtual camera output.
- Green screen/background replacement.
- Works with normal USB webcams too.

### Be careful with claims

Avoid claiming universal support until tested widely. Safer language:

- "Designed for Windows 10/11."
- "Requires Android 12+ for scrcpy camera mode."
- "Virtual camera support may require one-time admin driver registration."
- "OBS Window Capture works without driver installation."

## Suggested roadmap to make it 10x better

### Phase 1: Ship-safe beta

- Bundle all required assets offline.
- ~~Add strict permission handling.~~ — **DONE**
- ~~Add IPC validation.~~ — **DONE**
- Add diagnostics export.
- Add first-run wizard.
- Fix virtual camera status to distinguish driver registered vs frame writer active.
- Add app icon, publisher metadata, and third-party notices.
- Run manual test matrix with at least 3 phone brands.

### Phase 2: Professional public launch

- Code-sign installer and app.
- Add auto-update.
- ~~Add settings persistence.~~ — **DONE**
- Add crash/error logging with user consent.
- Add polished website/landing page.
- Add video setup tutorials.
- Add better driver install/uninstall flow.
- Add release channels: stable/beta.

### Phase 3: Differentiators

- Native virtual camera driver or OBS plugin.
- Hardware acceleration/performance tuning for green screen.
- Presets/scenes for background replacement.
- Phone camera controls where supported: front/back, zoom, exposure, focus.
- Audio support if valuable.
- ~~Multi-camera grid/manager view.~~ — **DONE** (dynamic CCTV grid, up to 4 cameras)
- Cloud-free privacy badge and privacy-first branding.

## Top 15 prioritized action items

1. Bundle MediaPipe assets locally and verify packaged green screen works offline.
2. Confirm whether virtual camera frame writing works; if not, fix or re-label as experimental.
3. ~~Restrict Electron permission handling to trusted windows and required permissions only.~~ — **DONE**
4. ~~Add IPC payload validation in `main.js`.~~ — **DONE**
5. Add a diagnostics/support report screen.
6. Parse and display ADB unauthorized/offline states.
7. Add first-run setup wizard.
8. ~~Persist user settings.~~ — **DONE**
9. Add code signing and publisher metadata.
10. Add third-party license notices and privacy policy.
11. Add a real driver uninstall flow.
12. ~~Add `setWindowOpenHandler` validation for only `output.html`.~~ — **DONE**
13. ~~Add CSP headers/meta tags for app windows.~~ — **DONE**
14. Add automated parser/unit tests and a manual release checklist.
15. Refactor large files into maintainable modules before adding more features.

## Overall readiness rating

- Prototype/product concept: 8/10
- Current user experience: 7.5/10 _(was 6.5 — settings persistence, multi-camera grid, settings menu redesign)_
- Public EXE readiness: 4.5/10 _(unchanged — still needs packaging, code signing, asset bundling)_
- Security posture for public release: 7.5/10 _(was 5.5 — CSP, permission allowlist, IPC validation, navigation blocking, window-open validation all done)_
- Maintainability: 5/10
- Market potential after polish: 8/10

## Final recommendation

Do not market this as a finished public 1.0 until the packaging, virtual camera reliability, permissions, diagnostics, and licensing/privacy work are completed. It is strong enough for a controlled beta with friendly testers, especially OBS users, but a broader public release should wait until the app can handle setup failures gracefully and clearly explain what is happening when phones, drivers, or permissions fail.
