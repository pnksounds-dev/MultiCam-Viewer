# MultiCamViewer — Skills & Workflow Rules

## Product capabilities (keep current)

- **Camera sources:** Android phones (ADB + scrcpy) **and** local UVC/USB/built-in webcams via `navigator.mediaDevices.enumerateDevices` + `getUserMedia`.
- **Source kinds in renderer:** `phone` | `uvc`. Phone uses scrcpy + desktop capture; UVC uses deviceId constraints.
- **Canvas rotation offset:** phone-only (`getCanvasRotationOffset()` → 180 for phone, 0 for uvc). Do not reintroduce a global 180° constant or laptop cams flip upside-down.
- **Virtual device filter:** skip MultiCam / OBS / ManyCam-style virtual outputs when listing UVC devices to avoid feedback loops. User can toggle `showAllCameras` via the eye-icon toolbar button (`btn-show-all-cams`) to bypass the filter and list every videoinput device.
- **Minimize to tray:** clicking minimize or the X close button hides the window to the system tray instead of quitting. Virtual camera output and scrcpy capture continue running in the background. The tray icon (right-click) provides Show and Quit options. `isQuitting` flag in main.js controls whether `close` events are intercepted or allowed through.
- **Avatar face overlay:** optional VTuber-style face overlay using MediaPipe Face Mesh. Free users get a built-in default multi-state sprite pack (neutral, blink, mouth-open). Premium users can upload custom expression art and access all six expressions plus overlay mode, scale, and sensitivity controls.

## Planning Documentation

Whenever a plan is discussed or created (whether it's a bug fix plan, feature plan, refactor plan, or any systematic multi-step plan):

1. **Write it to `docs/plans/`** — Create a markdown file named after the plan topic (e.g., `docs/plans/multi-instance-lifecycle-fixes.md`).
2. **Include a timestamp** — At the top of the plan, record the date and time the plan was created (ISO 8601 format, e.g., `2026-07-13T13:07:00Z`).
3. **Track completion status** — Each plan item must have a status: `[ ]` for pending, `[x]` for completed. Update the status as work progresses.
4. **Record completion timestamp** — When the entire plan is completed, add a "Completed:" timestamp at the top of the document.
5. **Update the plan as it evolves** — If the plan changes (items added, removed, or reprioritized), update the document and note the change with a timestamp.

### Plan File Template

```markdown
# [Plan Title]

**Created:** 2026-07-13T13:07:00Z
**Status:** In Progress | Completed
**Completed:** (fill in when done)

## Items

- [ ] 1. [Description] — [priority]
- [ ] 2. [Description] — [priority]
- [x] 3. [Description] — [priority] (completed: 2026-07-13T14:30:00Z)

## Notes

[Any relevant context, decisions, or changes made during execution.]
```
