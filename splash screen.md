# Splash Screen — Complete Reference

A full, copy-paste-ready breakdown of the MultiCam Viewer splash screen. Use this as a blueprint to reproduce the same look and behavior in any other Electron app.

The implementation is split across three files:

| File | Role |
| --- | --- |
| `splash.html` | Self-contained markup, CSS, and a tiny inline script. No external CSS or JS files. |
| `main.js` | Creates the `BrowserWindow` that hosts the splash, controls its lifecycle, and decides when to close it. |
| `renderer.js` + `index.html` | The "Show splash screen on startup" checkbox in Settings that toggles the `showSplash` setting. |

---

## 1. The BrowserWindow (main process)

Defined in `createSplash()` in `main.js` (around line 144). This is the container that holds `splash.html`.

```js
splashWindow = new BrowserWindow({
  width: 640,
  height: 540,
  frame: false,            // no OS title bar / borders — fully custom chrome
  resizable: false,
  minimizable: false,
  maximizable: false,
  center: true,            // centered on the primary monitor
  show: true,              // visible immediately (no ready-to-show dance needed)
  alwaysOnTop: true,       // floats above other windows during boot
  skipTaskbar: false,      // still shows in the taskbar so it isn't "invisible"
  backgroundColor: '#0f0f1a',  // MUST match the HTML body bg to avoid a white flash
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
  },
});

splashWindow.loadFile(path.join(__dirname, 'splash.html'));
```

### Why each option matters

- **`width: 640` / `height: 540`** — A roughly square-ish portrait window. The logo is capped at 420×420, plus 40px margin, plus a 5px loading bar, plus 18px gap, plus ~13px text. 540px gives comfortable vertical headroom. Reuse these dimensions if you want the same proportions.
- **`frame: false`** — Removes the OS chrome so the splash looks like a single floating card. Because the splash is non-interactive, there are no close/minimize buttons needed.
- **`resizable / minimizable / maximizable: false`** — Locks the window to its fixed size and prevents the user from minimizing it from the taskbar context menu.
- **`center: true`** — Centers it on the primary display at creation time.
- **`show: true`** — Combined with `backgroundColor`, this avoids the white flash that happens when a window is created hidden and then shown after content loads.
- **`alwaysOnTop: true`** — Keeps the splash above the main window while the main window is being constructed offscreen.
- **`skipTaskbar: false`** — Intentionally kept visible in the taskbar. Hiding it can make the app look like it hasn't launched at all on slow machines.
- **`backgroundColor: '#0f0f1a'`** — This is the single most important anti-flash setting. It must exactly match the `body` background in `splash.html`, otherwise you get a brief flash of white (or another color) before the page paints.
- **`contextIsolation: true` / `nodeIntegration: false`** — The splash has no need for Node APIs, so it runs in the safest renderer configuration.

### Lifecycle hooks

```js
splashWindow.webContents.on('console-message', (event, level, message) => {
  logToFile('Splash console [' + level + ']: ' + message);
});

splashWindow.on('ready-to-show', () => {
  const b = splashWindow.getBounds();
  logToFile('Splash bounds: ' + JSON.stringify(b));
  splashWindow.setAlwaysOnTop(true);
  splashWindow.moveTop();
  splashWindow.focus();
});

splashWindow.on('closed', () => { splashWindow = null; });
```

The `ready-to-show` handler re-asserts `alwaysOnTop`, moves the window to the top of the z-order, and focuses it. This guards against other apps (or the main window itself) stealing focus during boot.

---

## 2. The HTML Structure (splash.html)

The body contains exactly three elements, in vertical order:

```html
<img id="splash-logo" src="assets/MCVLOGO1.png?v=2" alt="MultiCam Viewer">
<div id="loading-bar-container">
  <div id="loading-bar"></div>
</div>
<div id="splash-text">Loading MultiCam Viewer…</div>
```

1. **Logo image** — A single PNG, capped at 420×420, centered.
2. **Loading bar** — A 320×5px track with an animated fill inside it.
3. **Loading text** — A small, dimmed, pulsing label under the bar.

That's it. No buttons, no links, no close affordance — the splash is purely informational.

### Cache-busting inline script

```html
<script>
  console.log('Splash script running');
  const logo = document.getElementById('splash-logo');
  logo.src = 'assets/MCVLOGO1.png?v=' + Date.now();
  logo.onload = function() { console.log('Splash logo loaded'); };
  logo.onerror = function() { console.log('Splash logo failed to load'); };
</script>
```

This rewrites the `src` with a `?v=<timestamp>` query string on every load, forcing the browser to fetch the logo fresh instead of serving a stale cached copy. The `onload` / `onerror` callbacks only log — they don't gate the UI. Combined with `session.defaultSession.clearCache()` in the main process (see §5), this guarantees an updated logo file always shows up.

---

## 3. The CSS — Colors, Dimensions, Positioning

### Global reset and body

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0f0f1a;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
  user-select: none;
}
```

- **`background: #0f0f1a`** — Very dark navy/near-black. This is the splash's signature background color and the value that must match `BrowserWindow.backgroundColor`.
- **`display: flex; flex-direction: column; align-items: center; justify-content: center;`** — Centers all three child elements both horizontally and vertically inside the 640×540 window.
- **`overflow: hidden`** — No scrollbars, ever.
- **`-webkit-app-region: no-drag`** — Even though `frame: false` is set, this prevents the entire window from being draggable (which is the default behavior for empty regions in frameless Electron windows).
- **`user-select: none`** — The loading text can't be accidentally selected.

### Logo

```css
#splash-logo {
  max-width: 420px;
  max-height: 420px;
  width: auto;
  height: auto;
  object-fit: contain;
  margin-bottom: 40px;
  animation: logoFadeIn 0.6s ease-out;
}
```

- **`max-width / max-height: 420px`** — The logo will never exceed 420px in either dimension, regardless of the source PNG's native size.
- **`width: auto; height: auto;`** — Lets the image keep its natural aspect ratio.
- **`object-fit: contain`** — Ensures the entire logo is visible without cropping or stretching.
- **`margin-bottom: 40px`** — The gap between the logo and the loading bar. This is the main vertical spacer that gives the splash its "breathing room" feel.
- **`animation: logoFadeIn 0.6s ease-out`** — A one-shot 600ms fade-and-scale-in when the splash first appears.

### Loading bar (track + fill)

```css
#loading-bar-container {
  width: 320px;
  height: 5px;
  background: #2a2a4a;
  border-radius: 3px;
  overflow: hidden;
}

#loading-bar {
  width: 0%;
  height: 100%;
  background: linear-gradient(90deg, #e94560, #0f3460);
  border-radius: 3px;
  animation: loadingFill 2.2s ease-in-out forwards;
}
```

- **Track: 320×5px, `#2a2a4a` (muted indigo), 3px radius.** Thin, subtle, rounded.
- **Fill: gradient from `#e94560` (coral/red-pink) to `#0f3460` (deep navy blue).** This is the splash's signature accent gradient — warm on the left, cool on the right.
- **`overflow: hidden` on the track** — Clips the fill's rounded corners so they don't poke out of the track while the bar is partially filled.
- **`forwards` on the animation** — The bar stays at 100% after the animation completes, instead of snapping back to 0%.

### Loading text

```css
#splash-text {
  margin-top: 18px;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #888aaa;
  letter-spacing: 1px;
  animation: textPulse 1.8s ease-in-out infinite;
}
```

- **`margin-top: 18px`** — Gap between the loading bar and the text.
- **`'Segoe UI', system-ui, sans-serif`** — Uses Windows' native UI font first, then the OS default, then a generic sans-serif. No web fonts are loaded — the splash stays instant.
- **`font-size: 13px`** — Small, unobtrusive.
- **`color: #888aaa`** — A muted blue-gray. Deliberately dim so it reads as secondary info.
- **`letter-spacing: 1px`** — Slightly tracked out, gives a "loading…" feel.
- **`animation: textPulse 1.8s ease-in-out infinite`** — A gentle opacity pulse that loops forever while the splash is visible.

---

## 4. The Animations (keyframes)

Three `@keyframes` rules drive everything.

### `logoFadeIn` — one-shot, 0.6s

```css
@keyframes logoFadeIn {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}
```

The logo starts at 92% scale and 0% opacity, then eases out to full size and full opacity over 600ms. Subtle — it makes the splash feel like it "arrives" instead of just popping in.

### `loadingFill` — one-shot, 2.2s, `forwards`

```css
@keyframes loadingFill {
  0%   { width: 0%; }
  30%  { width: 35%; }
  60%  { width: 65%; }
  80%  { width: 82%; }
  100% { width: 100%; }
}
```

This is a **fake/indeterminate** progress bar — it does NOT track real loading progress. The keyframes are tuned to feel like the bar is moving fast at first, then slowing down (35% by 0.66s, 65% by 1.32s, 82% by 1.76s, 100% by 2.2s). The deceleration curve mimics a real boot sequence.

The total duration of **2.2s** is chosen to match the worst-case main-window construction time (see §5 for how the real close is gated).

### `textPulse` — infinite, 1.8s

```css
@keyframes textPulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}
```

The loading text oscillates between 50% and 100% opacity every 1.8 seconds. This is the only looping animation — it gives the user a sense that "something is happening" even when the bar has finished filling.

---

## 5. The Content Security Policy

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
">
```

- **`default-src 'self'`** — Everything is restricted to the local origin by default.
- **`script-src 'self' 'unsafe-inline'`** — Allows the tiny cache-busting inline script. `unsafe-inline` is required because the script is embedded directly in the HTML.
- **`style-src 'self' 'unsafe-inline'`** — Allows the inline `<style>` block. Same reasoning.
- **`img-src 'self' data: blob:`** — Allows the local logo PNG, plus `data:`/`blob:` URIs in case the logo is ever injected as a data URL.

There is no `connect-src` because the splash makes no network requests. If you reuse this for an app that fetches a remote logo, you'll need to add the relevant origin here.

### Cache-control meta tags

```html
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
```

Belt-and-suspenders cache busting at the HTTP-header level. Combined with the `?v=Date.now()` query string on the logo `src` and the `session.defaultSession.clearCache()` call in the main process, this guarantees the splash always loads the latest assets.

---

## 6. The Lifecycle — When the Splash Shows and Closes

### Showing the splash

In `app.whenReady()` (main.js, around line 726):

```js
await session.defaultSession.clearCache();   // wipe stale cached assets

if (appSettings.showSplash) {
  createSplash();
  setTimeout(() => {
    createWindow(false);   // create the main window hidden
  }, 400);
} else {
  createWindow(true);      // no splash — just show the main window directly
}
```

The **400ms delay** before creating the main window is deliberate: it lets the splash paint first so the main window's construction (which can be CPU-heavy) doesn't jank the splash's opening animation.

### Closing the splash

The splash is closed from inside the main window's `did-finish-load` handler (main.js, around line 524):

```js
win.webContents.on('did-finish-load', () => {
  // ...send IPC to renderer...

  if (splashWindow && !splashWindow.isDestroyed()) {
    // Small delay so the loading bar animation completes.
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      win.show();
    }, 3000);
  } else {
    win.show();
  }
});
```

Key points:

- The splash is closed **only after the main window has finished loading** (`did-finish-load`).
- A **3000ms delay** is added on top of that so the 2.2s loading-bar animation has time to complete and the user sees the bar hit 100%.
- After the splash closes, `win.show()` reveals the main window (which was created hidden via `createWindow(false)`).
- The double `if (splashWindow && !splashWindow.isDestroyed())` check guards against the splash being closed by the user (e.g. via Alt+F4) during the delay.

### Total splash duration

In practice the splash is visible for roughly **3–5 seconds**:

- 0ms: splash created and shown
- 400ms: main window construction begins (hidden)
- ~600ms: `logoFadeIn` animation completes
- ~2200ms: `loadingFill` animation completes (bar at 100%)
- (whenever main window finishes loading) + 3000ms: splash closes, main window shows

The 3000ms post-load delay is what guarantees the bar always reaches 100% before the splash disappears, even on a fast machine where the main window loads in 200ms.

---

## 7. The Settings Toggle

The splash can be disabled by the user. The setting flows through three files:

**`DEFAULT_SETTINGS` in main.js:**
```js
const DEFAULT_SETTINGS = {
  showSplash: true,
  // ...
};
```

**`index.html` (Settings panel):**
```html
<input type="checkbox" id="setting-show-splash" checked>
<span>Show splash screen on startup</span>
```

**`renderer.js`:**
```js
// On load, apply the saved setting to the checkbox:
if (typeof settings.showSplash === 'boolean') {
  settingShowSplash.checked = settings.showSplash;
}

// When the user toggles it, persist immediately:
settingShowSplash.addEventListener('change', () => {
  saveSettingsDebounced({ showSplash: settingShowSplash.checked });
});
```

The setting is read in `app.whenReady()` before `createSplash()` is called, so the toggle takes effect on the next launch.

---

## 8. Color Palette Reference

All colors used by the splash, in one place:

| Token | Hex | Used for |
| --- | --- | --- |
| Background (dark navy) | `#0f0f1a` | `body` background, `BrowserWindow.backgroundColor` |
| Loading bar track | `#2a2a4a` | `#loading-bar-container` background |
| Loading bar fill start | `#e94560` | Coral / red-pink, left side of the gradient |
| Loading bar fill end | `#0f3460` | Deep navy blue, right side of the gradient |
| Loading text | `#888aaa` | Muted blue-gray for `#splash-text` |

The palette is a dark, low-saturation base (`#0f0f1a`, `#2a2a4a`, `#888aaa`) with a single warm-to-cool gradient accent (`#e94560` → `#0f3460`). This is the entire visual identity of the splash — reuse these five hex values to reproduce the look exactly.

---

## 9. Dimension Reference

| Element | Size |
| --- | --- |
| BrowserWindow | 640 × 540 px |
| Logo | max 420 × 420 px (auto aspect, `contain`) |
| Logo → loading bar gap | 40 px (`margin-bottom`) |
| Loading bar track | 320 × 5 px, 3px border-radius |
| Loading bar → text gap | 18 px (`margin-top`) |
| Loading text | 13 px font, 1px letter-spacing |

Vertical layout (centered as a flex column inside 540px):
```
        ┌───────────────────────┐  540px tall
        │                       │
        │      [ LOGO ≤420 ]    │  ← logoFadeIn 0.6s
        │        40px gap       │
        │   ▓▓▓▓▓▓░░░░░░░░░░    │  ← 320×5 loading bar, loadingFill 2.2s
        │        18px gap       │
        │   Loading MultiCam…   │  ← 13px text, textPulse 1.8s infinite
        │                       │
        └───────────────────────┘
              640px wide
```

---

## 10. Reuse Checklist

To port this splash to another Electron app:

1. **Copy `splash.html`** verbatim. Change only:
   - The `<title>`,
   - The logo `src` path,
   - The `#splash-text` content ("Loading MultiCam Viewer…" → "Loading YourApp…"),
   - The `alt` attribute on the logo.
2. **Copy `createSplash()`** into your main process. Keep `backgroundColor: '#0f0f1a'` matching the body bg.
3. **In your `app.whenReady()`**, call `createSplash()` and then delay your main window creation by ~400ms.
4. **In your main window's `did-finish-load`**, close the splash after a `setTimeout(..., 3000)` so the loading bar animation finishes.
5. **Add `await session.defaultSession.clearCache()`** at the start of `whenReady()` if you want updated logos to always show.
6. **(Optional) Add a `showSplash` setting** with a checkbox in your settings UI if you want users to be able to disable it.
7. **Drop your logo** into `assets/` (or wherever you pointed the `src`) as a PNG with transparency. The CSS will scale it down to fit 420×420 automatically.

That's the entire system — three files, five colors, three animations, one window.
