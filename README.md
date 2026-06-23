# MultiCam Viewer

Use your Android phones' cameras over USB as virtual webcams on your PC — for OBS, Discord, Zoom, etc. Detects phones directly via **USB debugging (ADB)** and pulls the camera with bundled **scrcpy**. No app is installed on your phone.

## How it works

```
Phone camera ──(USB / ADB)──► scrcpy (bundled) ──► hidden window
                                                      │
                                  Windows Graphics Capture
                                                      │
                                      MultiCam Viewer preview
                                                      │
                                   UnityCapture virtual camera ──► OBS / Discord / Zoom
```

- scrcpy pushes a **temporary** helper to the phone over USB (auto-removed on disconnect) — nothing permanent installed.
- The phone's camera window is kept **hidden behind the app** and captured via Windows Graphics Capture.
- Each app window = one phone camera = one virtual camera slot.

## Requirements

- Windows 10 (2004+) or Windows 11, 64-bit
- Android **12 or higher** phone
- A **data** USB cable
- For virtual-cam output to OBS/Discord: the UnityCapture driver (bundled, one-time admin registration)

## Quick start

1. **Enable USB Debugging on the phone** (one time):
   - Settings → About phone → tap **Build number** 7 times
   - Settings → System → Developer Options → enable **USB Debugging**
2. Plug the phone in. On the phone, tap **Allow** on the "Allow USB debugging?" prompt (tick "Always allow").
>3. Install/run the app:
>   - Installer: run **`dist\MultiCam Viewer Setup 1.0.0.exe`** (or `npm run build` to create it)
>   - From source: double-click **`start.bat`** (or `npm start`)
>4. Pick your phone in the **Camera** dropdown (e.g. "📱 Pixel 6a — back camera").
5. (For OBS/Discord) Open **Settings ⚙ → Register Virtual Camera Driver**, approve the admin prompt.

## Using two phones at once

- Click **+ New Camera** to open a second window, select your other phone there.
- Window 1 → **Unity Video Capture**, Window 2 → **Unity Video Capture 2** in OBS.

## OBS

- **Virtual camera:** OBS → Add Source → **Video Capture Device** → "Unity Video Capture".
- **Window capture (no driver):** OBS → Add Source → **Window Capture** → "MultiCam Viewer".

## Resolution / FPS

Use the **Resolution** dropdown. It controls scrcpy's `--max-size` (capture quality from the phone). 30 fps default.

## Bundled tools

- `tools/` — scrcpy 4.0 + adb (Genymobile/scrcpy, Apache-2.0)
- `vcam/` — UnityCapture DirectShow filter (schellingb/UnityCapture)

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone not in dropdown | Check USB Debugging is on; tap **Allow** on the phone; click **↻ Refresh**; use a *data* cable |
| "unauthorized" device | Unlock phone, re-plug, tap **Allow** on the debugging prompt |
| Black preview | Don't minimize the app while capturing; make sure scrcpy started (check the phone screen) |
| Driver register fails | Approve the UAC admin prompt; or run `vcam\install-vcam.bat` as Administrator |
| Camera privacy error (UVC mode) | Windows Settings → Privacy → Camera → allow desktop apps |

## Dev

```
npm start          # run from source
npm run build:dir  # build unpacked app in dist/win-unpacked/
npm run build      # build Windows installer (dist/MultiCam Viewer Setup 1.0.0.exe)
```

**Note:** this environment sets `ELECTRON_RUN_AS_NODE`, which breaks Electron. `start.bat` and the npm `start` script clear it automatically. The packaged installer is unaffected when launched from Explorer.

by pnksounds