# MultiCam Viewer

**Turn your Android phones into high-quality USB webcams for your PC — no app installed on the phone, no Wi-Fi needed.**

MultiCam Viewer detects Android phones over USB debugging (ADB), pulls their camera feeds using bundled scrcpy, and pipes them into virtual webcams that OBS, Discord, Zoom, Teams, and any other software can use. Run multiple phone cameras simultaneously, apply AI greenscreen, adjust exposure/contrast/saturation, and output to up to 4 virtual camera slots.

Built by [pnksounds](https://pnksounds.dev/) · [GitHub](https://github.com/pnksounds-dev) · [Discord](https://discord.gg/DkyraHSbTW)

---

## How It Works

```
Phone camera ──(USB / ADB)──► scrcpy (bundled) ──► hidden window
                                                      │
                                  Windows Graphics Capture
                                                      │
                                      MultiCam Viewer preview
                                                      │
                                   UnityCapture virtual camera ──► OBS / Discord / Zoom
```

- scrcpy pushes a **temporary** helper to the phone over USB (auto-removed on disconnect) — nothing permanent is installed on the phone.
- The phone's camera window is kept **hidden behind the app** and captured via Windows Graphics Capture.
- Each app window = one phone camera = one virtual camera slot in OBS.

---

## Features

### Camera Management
- **Multi-camera support** — display up to 2 cameras side-by-side in the same window (free tier), or up to 4 with a premium license.
- **Separate windows** — open additional MultiCam windows for additional phones (premium feature).
- **Multiple output slots** — Window 1 → MultiCam, Window 2 → MultiCam 2, Window 3 → MultiCam 3, etc.
- **Output Window** — open a clean, borderless window for OBS Window Capture (no driver needed).
- **Resolution control** — 16:9 (1080p, 720p, 480p, 360p), 9:16 (vertical), 1:1 (square), 4:3 formats.
- **Auto-detection** — phones are automatically detected via ADB with refresh capability.

### AI Greenscreen (Premium)
- **Real-time background removal** powered by Google MediaPipe Selfie Segmentation.
- **Custom background color** — pick any solid color as the replacement background.
- **Background image** — use any image file as the virtual background.
- **Edge threshold & gap sliders** — fine-tune segmentation quality for clean edges.

### Video Adjustments (Premium)
- **Exposure** — adjust brightness from -100 to +100.
- **Contrast** — adjust contrast from -100 to +100.
- **Saturation** — adjust color saturation from -100 to +100.
- **Threshold & Gap** — greenscreen edge refinement controls.

### Virtual Camera Output
- **UnityCapture DirectShow filter** — registered as a system virtual webcam.
- **Up to 4 slots** — each window outputs to a separate OBS Video Capture Device.
- **One-time driver installation** — admin prompt handles registration automatically.

### Premium / Licensing
- **Free tier** — up to 2 side-by-side cameras in the same window, standard virtual camera output.
- **Premium license** — unlocks AI greenscreen, separate MultiCam windows, video adjustments (exposure/contrast/saturation), and up to 4 cameras per window.
- **In-house license system** — AES-256-GCM encrypted keys verified in the main process (not exposed to DevTools).
- **License keys** are generated using the bundled `license-generator.js` and stored in `licenses.json`.

### Settings & UI
- **Theme support** — Dusk, Dark, and Light themes.
- **Splash screen** — optional startup splash (toggleable).
- **Settings persistence** — all preferences saved to `settings.json` in the user data directory.
- **Auto-versioning** — app version displayed in Settings → About, pulled automatically from `package.json`.
- **Social links** — GitHub, website, and Discord accessible from the About section.

### Security & Anti-Tampering
- **License verification in main process** — the license secret and decryption logic run in Node.js (main process), not exposed to the renderer or DevTools.
- **JavaScript obfuscation** — `renderer.js` and `output-renderer.js` are obfuscated at build time with control-flow flattening, string array encoding, dead code injection, and self-defending protections.
- **Electron fuses** — production builds disable `--inspect` CLI args, enforce ASAR integrity validation, and restrict file protocol privileges.
- **DevTools blocking** — F12 and Ctrl+Shift+I/J/C are intercepted and DevTools auto-closes in packaged builds.

---

## Requirements

- **Windows 10 (2004+) or Windows 11**, 64-bit
- **Android 12 or higher** phone
- A **data** USB cable (charging-only cables won't work)
- For virtual camera output to OBS/Discord: UnityCapture driver (bundled, one-time admin registration)

---

## Quick Start

### For End Users

1. **Enable USB Debugging on the phone** (one time):
   - Settings → About phone → tap **Build number** 7 times
   - Settings → System → Developer Options → enable **USB Debugging**
2. Plug the phone in. On the phone, tap **Allow** on the "Allow USB debugging?" prompt (tick "Always allow").
3. Run the installer: **`dist\MultiCam Viewer Setup 1.0.0.exe`**
4. Pick your phone in the **Camera** dropdown (e.g. "📱 Pixel 6a — back camera").
5. (For OBS/Discord) Open **Settings ⚙ → Register Virtual Camera Driver**, approve the admin prompt.

### Using Two Phones

- **Same window (free):** Click **+ New Camera ▼ → Add in this window** to add a second camera side-by-side.
- **Separate window (premium):** Click **+ New Camera ▼ → Open new MultiCam** to open a second window.
- Window 1 → **MultiCam**, Window 2 → **MultiCam 2** in OBS.

### Activating a Premium License

1. Open **Settings ⚙ → Premium License**.
2. Paste your license key into the input field.
3. Click **Activate License**.
4. Premium features unlock immediately. The key is saved and re-verified on each launch.

---

## OBS Setup

### Option 1: Virtual Camera (requires driver)
1. In MultiCam Viewer: Settings ⚙ → **Register Virtual Camera Driver** (approve UAC).
2. In OBS: Add Source → **Video Capture Device** → select **"MultiCam"**.
3. For a second phone: open a second window, add another OBS source → **"MultiCam 2"**.

### Option 2: Window Capture (no driver needed)
1. In MultiCam Viewer: select your phone in the dropdown.
2. In OBS: Add Source → **Window Capture** → select **"MultiCam Viewer"**.
3. Open a second app window for the second phone.

---

## Project Structure

```
multi-cam-viewer/
├── main.js              # Electron main process — window creation, IPC, license verification, scrcpy/ADB
├── preload.js           # IPC bridge — exposes electronAPI to renderer
├── renderer.js          # Renderer process — UI logic, camera management, greenscreen, adjustments
├── index.html           # Main app UI
├── styles.css           # App styling (Dusk/Dark/Light themes)
├── output.html          # Clean output window for OBS Window Capture
├── output-renderer.js   # Output window logic
├── splash.html          # Startup splash screen
├── license.js           # Legacy renderer-side license verification (unused in builds)
├── license-generator.js # CLI tool to generate license keys
├── licenses.json        # License key database
├── obfuscate.js         # Build-time JS obfuscation script
├── flip-fuses.js        # Electron fuses configuration script
├── vcam-worker.js       # Virtual camera worker
├── installer.nsh        # NSIS installer custom script
├── launcher.vbs         # Production launcher (clears ELECTRON_RUN_AS_NODE)
├── dev-launcher.vbs     # Dev launcher
├── assets/              # App logos and icons
├── vendor/mediapipe/    # MediaPipe Selfie Segmentation model
├── vcam-native/         # Native addon for virtual camera frame bridge
├── tools/               # Bundled scrcpy 4.0 + adb (not in repo, added at build)
├── vcam/                # UnityCapture DirectShow filter DLL (not in repo, added at build)
└── premium-server/      # Optional server-side license verification
```

---

## Development

### Running from Source

```bash
npm install        # install dependencies
npm start          # launch app (clears ELECTRON_RUN_AS_NODE automatically)
```

### Building the Installer

```bash
npm run build      # obfuscate JS → build NSIS installer → restore originals
npm run build:fuses # flip Electron fuses on the built binary (run after build)
```

Output:
- `dist\MultiCam Viewer Setup 1.0.0.exe` — NSIS installer
- `dist\win-unpacked\` — unpacked app directory

### Generating License Keys

```bash
node license-generator.js
```

Prompts for:
- Number of cameras (2-4)
- Validity in months (0 = no expiry)
- Optional note

The generated key is saved to `licenses.json` and printed to the console.

### Build Pipeline

The `npm run build` script executes three steps in sequence:

1. **`node obfuscate.js obfuscate`** — backs up original JS files, obfuscates `renderer.js` and `output-renderer.js` in place with `javascript-obfuscator` (control-flow flattening, base64 string encoding, dead code injection, self-defending, hexadecimal identifiers).
2. **`electron-builder --win --x64`** — packages the app into an NSIS installer.
3. **`node obfuscate.js restore`** — restores the original readable source files.

Electron fuses are applied separately via `npm run build:fuses`:
- Disables `--inspect` CLI arguments
- Enforces ASAR integrity validation
- Restricts file protocol extra privileges

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone not in dropdown | Check USB Debugging is on; tap **Allow** on the phone; click **↻ Refresh**; use a *data* cable |
| "unauthorized" device | Unlock phone, re-plug, tap **Allow** on the debugging prompt |
| Black preview | Don't minimize the app while capturing; make sure scrcpy started (check the phone screen) |
| Driver register fails | Approve the UAC admin prompt; or run `vcam\install-vcam.bat` as Administrator |
| Camera privacy error | Windows Settings → Privacy → Camera → allow desktop apps |
| Greenscreen not working | Premium license required; check that a camera is active before toggling |
| License not accepted | Ensure the key matches in `licenses.json`; check for typos; try re-activating |

---

## Tech Stack

- **Electron** 33 — cross-platform desktop framework
- **scrcpy** 4.0 + **adb** — Android screen mirroring over USB (Genymobile/scrcpy, Apache-2.0)
- **UnityCapture** — DirectShow virtual camera filter (schellingb/UnityCapture)
- **MediaPipe Selfie Segmentation** — real-time AI background removal (Google)
- **javascript-obfuscator** — build-time code protection
- **@electron/fuses** — binary-level production hardening
- **electron-builder** — packaging and NSIS installer generation

---

## License

ISC — see `package.json`

## Links

- **Website:** [pnksounds.dev](https://pnksounds.dev/)
- **GitHub:** [github.com/pnksounds-dev](https://github.com/pnksounds-dev)
- **Discord:** [discord.gg/DkyraHSbTW](https://discord.gg/DkyraHSbTW)

---

*Built by pnksounds*