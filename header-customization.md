# Header Customization & Window Controls — Complete Reference

A full, copy-paste-ready breakdown of the Mindo window customization system. This covers removing the default Electron menu, implementing a custom draggable title bar with minimize/maximize controls, scrollbar theming and hiding, and the reusable settings menu architecture. Use this as a blueprint to reproduce the same look and behavior in any other Electron app.

The implementation is split across these files:

| File | Role |
| --- | --- |
| `electron/main.ts` | Removes default menu, creates frameless window, registers window-control IPC handlers |
| `electron/preload.ts` | Exposes window-control methods to the renderer via `contextBridge` |
| `electron/ipc/settingsHandlers.ts` | Persists boolean settings (`showSplash`, `hideHeader`) to `userData/settings.json` |
| `src/types.ts` | TypeScript declarations for the exposed `window.api` methods |
| `src/components/ui/TitleBar.tsx` | Custom title bar component (draggable region + minimize/maximize buttons) |
| `src/App.tsx` | Integrates `TitleBar`, applies CSS variables for layout offsets |
| `src/index.css` | Scrollbar theming (light/dark), hide toggle, `--titlebar-height` variable |
| `src/pages/settings/AppearanceSection.tsx` | Settings UI with toggles for splash, header, scrollbars |

---

## 1. Removing the Default Electron Menu

By default, Electron apps show a top menu bar (File, Edit, View, Window, Help). To remove it globally:

**In `electron/main.ts`, inside `app.whenReady()`:**

```ts
import { Menu } from 'electron'

app.whenReady().then(async () => {
  // Remove the default application menu (File/Edit/View/Window/Help).
  Menu.setApplicationMenu(null)

  // ... rest of your initialization
})
```

**Why this matters:**
- `Menu.setApplicationMenu(null)` removes the OS-level menu bar entirely.
- This is the first step toward a "headless" or frameless window where you control all chrome.
- On macOS, this also removes the app name from the top-left menu bar.
- If you later need a custom menu, use `Menu.buildFromTemplate()` instead of `null`.

---

## 2. Frameless Window with Custom Title Bar

### 2.1. BrowserWindow Configuration

**In `electron/main.ts`, the `createWindow()` function:**

```ts
function createWindow(showImmediately: boolean, hideHeader: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f172a',
    titleBarStyle: hideHeader ? 'hidden' : 'hiddenInset',
    frame: !hideHeader,           // false when hideHeader is true → fully frameless
    show: showImmediately,
    icon: join(__dirname, 'assets', 'Mindo-Logo.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ... rest of the function
}
```

**Key options explained:**
- **`frame: !hideHeader`** — When `hideHeader` is true, this becomes `false`, removing the OS title bar, borders, and window controls entirely. The window is now "frameless."
- **`titleBarStyle: hideHeader ? 'hidden' : 'hiddenInset'`** — On macOS, this controls the traffic-light buttons (close/minimize/maximize). `'hidden'` removes them entirely; `'hiddenInset'` keeps them in a small inset. This is a macOS-specific option; on Windows/Linux, `frame` is the primary control.
- **`backgroundColor: '#0f172a'`** — Matches the app's dark background to avoid a white flash during window creation.
- **`icon`** — Sets the app icon in the taskbar and window frame (when visible).

### 2.2. Window Control IPC Handlers

**In `electron/main.ts`, inside `app.whenReady()`:**

```ts
import { ipcMain } from 'electron'

// Window-control IPC for the custom TitleBar (frameless mode)
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
  return true
})

ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
    return false
  }
  mainWindow.maximize()
  return true
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false
})
```

**Why these three handlers:**
- **`window:minimize`** — Calls `BrowserWindow.minimize()`. The renderer can trigger this from a button.
- **`window:toggleMaximize`** — Checks if the window is maximized; if so, restores it; otherwise, maximizes it. Returns the new state (true = maximized, false = restored).
- **`window:isMaximized`** — Returns the current maximize state so the renderer can show the correct icon (square vs. copy/split icon).

### 2.3. Notify Renderer of Maximize State Changes

**In `electron/main.ts`, after creating the window:**

```ts
// Notify the renderer when the window is maximized/unmaximized so the
// TitleBar can swap its maximize/restore icon.
mainWindow.on('maximize', () => {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('window:maximizeChange', true)
})

mainWindow.on('unmaximize', () => {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('window:maximizeChange', false)
})
```

**Why this matters:**
- The user can maximize/restore via keyboard shortcuts (Win+Up/Down, double-click title bar, etc.), not just your custom buttons.
- These event listeners ensure the TitleBar icon stays in sync regardless of how the state changed.
- The renderer subscribes to this event via `onWindowMaximizeChange` (see §2.5).

---

## 3. Exposing IPC to the Renderer (preload.ts)

**In `electron/preload.ts`:**

```ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // ... other API methods ...

  // Window controls (for custom TitleBar in frameless mode)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (cb: (isMaximized: boolean) => void) => {
    const listener = (_e: unknown, isMaximized: boolean) => cb(isMaximized)
    ipcRenderer.on('window:maximizeChange', listener)
    return () => ipcRenderer.removeListener('window:maximizeChange', listener)
  },
})
```

**Why this pattern:**
- **`contextBridge.exposeInMainWorld`** — Safely exposes a subset of Electron APIs to the renderer while maintaining context isolation.
- **`invoke` for one-way calls** — `windowMinimize` and `windowToggleMaximize` are simple request/response calls.
- **`on` for events** — `onWindowMaximizeChange` returns a cleanup function that removes the listener when the component unmounts. This is the React-safe way to handle IPC events.

---

## 4. TypeScript Declarations (types.ts)

**In `src/types.ts`, inside the global `Window` interface:**

```ts
declare global {
  interface Window {
    api: {
      // ... other API methods ...

      // Window controls (for custom TitleBar in frameless mode)
      windowMinimize?: () => Promise<boolean>
      windowToggleMaximize?: () => Promise<boolean>
      windowIsMaximized?: () => Promise<boolean>
      onWindowMaximizeChange?: (cb: (isMaximized: boolean) => void) => () => void
    }
  }
}
```

**Why this matters:**
- TypeScript doesn't know about `window.api` by default; this declaration gives it type information.
- Methods are marked optional (`?`) because they may not exist in web builds (where Electron APIs are absent).
- The return types match the IPC handler signatures.

---

## 5. The TitleBar React Component

**In `src/components/ui/TitleBar.tsx`:**

```tsx
import { useEffect, useState } from 'react'
import { Minus, Square, Copy } from 'lucide-react'

/**
 * Custom title bar for frameless mode.
 * - The entire bar is draggable (`-webkit-app-region: drag`) so the user
 *   can move the window by grabbing any non-button area.
 * - Minimize and maximize/restore buttons are `no-drag` so they're clickable.
 * - No close button — quitting is handled by the "Quit App" button in the NavBar.
 * - Sets `--titlebar-height` on :root so NavBar and main content can offset.
 *   Returns null (and resets the variable) when hideHeader is disabled or
 *   running outside Electron (web/Android), so the rest of the app is unaffected.
 */
export default function TitleBar() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api?.getHideHeader) {
      setEnabled(false)
      return
    }
    let cancelled = false
    window.api.getHideHeader().then(v => {
      if (cancelled) return
      setEnabled(v)
    })
    // Load the app logo for the title bar (same asset as the NavBar header)
    if (window.api?.getAsset) {
      window.api.getAsset('logos/Mindo-Logo.png').then(url => {
        if (!cancelled) setLogoDataUrl(url)
      })
    }
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (enabled) {
      document.documentElement.style.setProperty('--titlebar-height', '32px')
    } else {
      document.documentElement.style.setProperty('--titlebar-height', '0px')
    }
  }, [enabled])

  // Track maximize state for the toggle icon
  useEffect(() => {
    if (!enabled || !window.api?.windowIsMaximized) return
    let cleanup: (() => void) | undefined
    window.api.windowIsMaximized().then(setIsMaximized)
    if (window.api?.onWindowMaximizeChange) {
      cleanup = window.api.onWindowMaximizeChange(setIsMaximized)
    }
    return () => cleanup?.()
  }, [enabled])

  if (!enabled) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 h-8 z-[60] flex items-center justify-between px-2 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* App logo + name — left side, draggable */}
      <div className="flex items-center gap-2 px-2">
        {logoDataUrl ? (
          <img src={logoDataUrl} alt="Mindo" className="w-5 h-5 object-contain" />
        ) : (
          <div className="w-5 h-5 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        )}
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mindo
        </span>
      </div>

      {/* Window controls — right side, clickable */}
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => window.api?.windowMinimize?.()}
          className="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
          title="Minimize"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            window.api?.windowToggleMaximize?.().then(setIsMaximized)
          }}
          className="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}
```

**Key implementation details:**
- **`WebkitAppRegion: 'drag'`** — Makes the entire bar draggable. The user can move the window by clicking anywhere except the buttons.
- **`WebkitAppRegion: 'no-drag'` on buttons** — Overrides the drag region for the control buttons so they're clickable instead of starting a drag operation.
- **`--titlebar-height` CSS variable** — Set to `32px` when enabled, `0px` when disabled. The rest of the app (NavBar, main content) uses this variable to offset their layout.
- **Conditional rendering** — Returns `null` when `hideHeader` is false or when running outside Electron (no `window.api`). This ensures the component doesn't interfere in web builds.
- **Maximize state tracking** — Uses `windowIsMaximized()` for the initial state and `onWindowMaximizeChange()` to stay in sync with keyboard shortcuts and double-click maximization.
- **No close button** — The app is quit via the "Quit App" button in the NavBar, which calls `window.api.quitApp()`. This is a deliberate UX choice.

---

## 6. Integrating TitleBar into App Layout

**In `src/App.tsx`:**

```tsx
import TitleBar from './components/ui/TitleBar'

export default function App() {
  // ... existing code ...

  return (
    <div>
      <TitleBar />
      <NavBar />
      <div
        style={{
          paddingLeft: isAiRoute ? '0px' : 'var(--nav-width, 256px)',
          paddingTop: isAiRoute ? '0px' : 'var(--titlebar-height, 0px)',
          paddingBottom: isAiRoute ? '0px' : 'var(--nav-bottom-height, 0px)',
          // ... other styles
        }}
        className={`${isAiRoute ? 'overflow-hidden' : 'min-h-screen transition-[padding] duration-300 ease-in-out'}`}
      >
        {/* Routes and page content */}
      </div>
    </div>
  )
}
```

**Why this layout:**
- **`<TitleBar />` is rendered first** — It's fixed at the top with `z-[60]`, so it sits above everything else.
- **`paddingTop: 'var(--titlebar-height, 0px)'`** — The main content offsets by the title bar height. When `hideHeader` is disabled, this is `0px` and the content goes to the top of the window.
- **`paddingLeft` and `paddingBottom`** — Offset for the sidebar and bottom nav bar, respectively.
- **`transition-[padding]`** — Smooth animation when the title bar appears/disappears or when the nav bar toggles.

---

## 7. Scrollbar Theming and Hiding

### 7.1. CSS Variables and Base Styles

**In `src/index.css`:**

```css
@layer base {
  :root {
    --nav-width: 256px;
    --titlebar-height: 0px;
  }
  /* ... other base styles ... */
}
```

**Why CSS variables:**
- `--titlebar-height` is set by the `TitleBar` component (32px when enabled, 0px when disabled).
- Other components reference this variable for layout offsets instead of hardcoding values.
- This makes the layout reactive to the hide-header setting without prop drilling.

### 7.2. Themed Scrollbars

**In `src/index.css` (OUTSIDE `@layer base` to ensure normal cascade priority):**

```css
/* ── Themed scrollbars ──
   Kept OUTSIDE @layer base so they have normal cascade priority and
   aren't overridden by Tailwind's preflight or unlayered styles.
   Match the app palette: light track with brand-500 thumb (light mode),
   dark track with brand-400 thumb (dark mode). Thin and rounded.

   IMPORTANT: the bare `::-webkit-scrollbar` selector (no descendant
   combinator) is used so the rules also apply to the ROOT <html>
   scrollbar — `.dark *` / `html.scrollbars-hidden *` would NOT match
   html itself (it's not a descendant of itself), which is why the
   page scrollbar previously stayed white in dark mode and ignored the
   hide toggle.

   Hidden entirely when <html> has the `scrollbars-hidden` class
   (toggled from Settings → Appearance). */

/* Firefox */
* {
  scrollbar-width: thin;
  scrollbar-color: #6366f1 #e2e8f0;
}
html.dark,
html.dark * {
  scrollbar-color: #818cf8 #1e293b;
}
html.scrollbars-hidden,
html.scrollbars-hidden * {
  scrollbar-width: none;
}

/* WebKit / Chromium (Electron) — bare selectors cover the root + all elements */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track {
  background: #e2e8f0;
  border-radius: 5px;
}
::-webkit-scrollbar-thumb {
  background: #6366f1;
  border-radius: 5px;
  border: 2px solid #e2e8f0;
}
::-webkit-scrollbar-thumb:hover {
  background: #4f46e5;
}

/* Dark mode — cover the root scrollbar (html.dark::) AND descendant
   elements' scrollbars (html.dark ::, with the descendant combinator). */
html.dark::-webkit-scrollbar-track,
html.dark ::-webkit-scrollbar-track {
  background: #1e293b;
}
html.dark::-webkit-scrollbar-thumb,
html.dark ::-webkit-scrollbar-thumb {
  background: #818cf8;
  border-color: #1e293b;
}
html.dark::-webkit-scrollbar-thumb:hover,
html.dark ::-webkit-scrollbar-thumb:hover {
  background: #a5b4fc;
}

/* Hide — again cover root + descendants */
html.scrollbars-hidden::-webkit-scrollbar,
html.scrollbars-hidden ::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
```

**Key points:**
- **Bare selectors (`::-webkit-scrollbar`) without a descendant combinator** — This is critical. The main page scrollbar is painted by the `<html>` root element itself, and `<html>` is not a descendant of itself. Using `.dark *` or `html.scrollbars-hidden *` would miss the root scrollbar entirely.
- **Double coverage** — Both `html.dark::-webkit-scrollbar-track` (root) and `html.dark ::-webkit-scrollbar-track` (descendants) are targeted to ensure all scrollbars are themed.
- **Firefox support** — `scrollbar-color` and `scrollbar-width` are used for Firefox; WebKit uses the pseudo-elements.
- **Hide toggle** — When `html` has the `scrollbars-hidden` class, all scrollbars are hidden (`display: none`, `width: 0`, `height: 0`). Scrolling still works via trackpad, mouse wheel, or touch.

### 7.3. Toggling the Hide Scrollbars Setting

**In `src/pages/settings/AppearanceSection.tsx`:**

```tsx
const [hideScrollbars, setHideScrollbars] = useState(
  () => localStorage.getItem('hideScrollbars') === 'true'
)

// Apply the scrollbars-hidden class to <html> whenever the toggle changes
useEffect(() => {
  document.documentElement.classList.toggle('scrollbars-hidden', hideScrollbars)
}, [hideScrollbars])

// In the JSX:
<button
  onClick={() => {
    const next = !hideScrollbars
    setHideScrollbars(next)
    localStorage.setItem('hideScrollbars', String(next))
  }}
  className="w-full flex items-center justify-between p-3 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition text-left"
>
  <div className="flex items-center gap-3">
    <ScrollText className="w-5 h-5 text-slate-500 dark:text-slate-400" />
    <span className="text-slate-700 dark:text-slate-300">Hide Scrollbars</span>
  </div>
  <Toggle on={hideScrollbars} />
</button>
```

**Why this pattern:**
- The setting is persisted to `localStorage` (renderer-only, no IPC needed).
- A `useEffect` toggles the `scrollbars-hidden` class on `document.documentElement` whenever the state changes.
- The CSS rules in `index.css` respond to this class by hiding all scrollbars.

---

## 8. Settings Architecture (Reusable Pattern)

### 8.1. Settings Storage (Main Process)

**In `electron/ipc/settingsHandlers.ts`:**

```ts
// App-level boolean settings persisted to a JSON file in userData.
// Used by the main process (read on boot) and the renderer (toggle in Settings).
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

interface AppSettings {
  showSplash: boolean
  hideHeader: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  showSplash: true,
  hideHeader: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readAppSettings(): AppSettings {
  try {
    const p = settingsPath()
    if (!existsSync(p)) return { ...DEFAULT_SETTINGS }
    const data = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(data)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeAppSettings(settings: AppSettings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch (err) {
    console.error('writeAppSettings error:', err)
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getShowSplash', () => {
    return readAppSettings().showSplash
  })

  ipcMain.handle('settings:setShowSplash', (_e, value: boolean) => {
    const current = readAppSettings()
    current.showSplash = value
    writeAppSettings(current)
    return true
  })

  ipcMain.handle('settings:getHideHeader', () => {
    return readAppSettings().hideHeader
  })

  ipcMain.handle('settings:setHideHeader', (_e, value: boolean) => {
    const current = readAppSettings()
    current.hideHeader = value
    writeAppSettings(current)
    return true
  })
}
```

**Why this architecture:**
- **JSON file in `userData`** — Settings are persisted across app launches in the OS-appropriate user data directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux).
- **Type-safe interface** — `AppSettings` defines the shape; adding a new setting is as simple as adding a field here and a corresponding handler.
- **Default values** — `DEFAULT_SETTINGS` ensures the app has sensible defaults even if the file doesn't exist or is corrupted.
- **Graceful error handling** — If reading/writing fails, the app falls back to defaults instead of crashing.

### 8.2. Reading Settings on Boot

**In `electron/main.ts`:**

```ts
import { registerSettingsHandlers, readAppSettings } from './ipc/settingsHandlers'

app.whenReady().then(async () => {
  // ... other initialization ...

  registerSettingsHandlers()

  const settings = readAppSettings()
  if (settings.showSplash) {
    createSplash()
    setTimeout(() => createWindow(false, settings.hideHeader), 400)
  } else {
    createWindow(true, settings.hideHeader)
  }
})
```

**Why this matters:**
- `readAppSettings()` is called before creating the window, so the `hideHeader` setting takes effect immediately on launch.
- The splash screen logic also reads `showSplash` here.

### 8.3. Exposing Settings to Renderer (preload.ts)

**In `electron/preload.ts`:**

```ts
contextBridge.exposeInMainWorld('api', {
  // ... other API methods ...

  // App-level settings (persisted to userData/settings.json)
  getShowSplash: () => ipcRenderer.invoke('settings:getShowSplash'),
  setShowSplash: (value: boolean) => ipcRenderer.invoke('settings:setShowSplash', value),
  getHideHeader: () => ipcRenderer.invoke('settings:getHideHeader'),
  setHideHeader: (value: boolean) => ipcRenderer.invoke('settings:setHideHeader', value),
})
```

### 8.4. TypeScript Declarations (types.ts)

**In `src/types.ts`:**

```ts
declare global {
  interface Window {
    api: {
      // ... other API methods ...

      // App-level settings (persisted to userData/settings.json)
      getShowSplash?: () => Promise<boolean>
      setShowSplash?: (value: boolean) => Promise<boolean>
      getHideHeader?: () => Promise<boolean>
      setHideHeader?: (value: boolean) => Promise<boolean>
    }
  }
}
```

### 8.5. Settings UI Component

**In `src/pages/settings/AppearanceSection.tsx`:**

```tsx
const [showSplash, setShowSplash] = useState(true)
const [splashSupported, setSplashSupported] = useState(false)
const [hideHeader, setHideHeader] = useState(false)
const [hideHeaderSupported, setHideHeaderSupported] = useState(false)

useEffect(() => {
  let cancelled = false
  // Splash toggle is desktop-only (requires Electron IPC).
  if (window.api?.getShowSplash) {
    setSplashSupported(true)
    window.api.getShowSplash().then(v => { if (!cancelled) setShowSplash(v) })
  }
  // Hide-header toggle is desktop-only (requires Electron IPC).
  if (window.api?.getHideHeader) {
    setHideHeaderSupported(true)
    window.api.getHideHeader().then(v => { if (!cancelled) setHideHeader(v) })
  }
  return () => { cancelled = true }
}, [])

// In the JSX:
{splashSupported && (
  <div className="mt-3">
    <button
      onClick={() => {
        const next = !showSplash
        setShowSplash(next)
        window.api?.setShowSplash?.(next)
      }}
      className="w-full flex items-center justify-between p-3 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition text-left"
    >
      <div className="flex items-center gap-3">
        <Eye className="w-5 h-5 text-slate-500 dark:text-slate-400" />
        <span className="text-slate-700 dark:text-slate-300">Show Splash Screen on Startup</span>
      </div>
      <Toggle on={showSplash} />
    </button>
    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-11">
      Display the Mindo splash screen while the app loads. Takes effect on next launch.
    </p>
  </div>
)}

{hideHeaderSupported && (
  <div className="mt-3">
    <button
      onClick={() => {
        const next = !hideHeader
        setHideHeader(next)
        window.api?.setHideHeader?.(next)
      }}
      className="w-full flex items-center justify-between p-3 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition text-left"
    >
      <div className="flex items-center gap-3">
        <PanelTopClose className="w-5 h-5 text-slate-500 dark:text-slate-400" />
        <span className="text-slate-700 dark:text-slate-300">Hide Header (Headless Mode)</span>
      </div>
      <Toggle on={hideHeader} />
    </button>
    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-11">
      Remove the OS title bar and run frameless. A draggable bar with minimize and maximize controls replaces it. Takes effect on next launch.
    </p>
  </div>
)}
```

**Why this pattern:**
- **Feature detection** — The UI checks if `window.api.getShowSplash` / `window.api.getHideHeader` exist before rendering the toggle. This ensures the settings only appear in Electron builds, not web builds.
- **Optimistic UI** — The local state updates immediately when the user clicks, then the IPC call persists the change. This makes the UI feel snappy.
- **"Takes effect on next launch"** — The user is informed that these settings require a restart because they affect window creation (which happens once at boot).

---

## 9. Reuse Checklist

To port this header customization system to another Electron app:

1. **Remove the default menu** — Add `Menu.setApplicationMenu(null)` in `app.whenReady()` in your main process.
2. **Add the settings handlers** — Copy `settingsHandlers.ts` (or extend it with your own settings). Register it in your main process.
3. **Add window-control IPC handlers** — Copy the `window:minimize`, `window:toggleMaximize`, and `window:isMaximized` handlers into your main process. Add the `maximize`/`unmaximize` event listeners to notify the renderer.
4. **Expose IPC in preload** — Add the window-control methods and settings getters/setters to your `contextBridge.exposeInMainWorld` call.
5. **Add TypeScript declarations** — Extend the `Window` interface in your types file with the new `window.api` methods.
6. **Copy the TitleBar component** — Adapt the logo path and app name to your branding. Adjust the height (32px) if you want a different size.
7. **Integrate TitleBar into your app** — Render it at the top of your app component. Add `paddingTop: 'var(--titlebar-height, 0px)'` to your main content container.
8. **Add the CSS** — Copy the scrollbar theming rules from `index.css`. Add the `--titlebar-height` variable to your `:root`.
9. **Add the settings UI** — Copy the toggle buttons from `AppearanceSection.tsx`. Adjust the icons and labels to match your app.
10. **Wire up the frame option** — In your `BrowserWindow` config, add `frame: !hideHeader` and read the setting on boot via `readAppSettings()`.

---

## 10. Common Pitfalls

### 10.1. Scrollbar Theming Not Working on the Root

**Symptom:** The page scrollbar stays white in dark mode, or the hide toggle doesn't affect it.

**Cause:** Using a descendant combinator (`.dark *::-webkit-scrollbar`) instead of targeting the root directly.

**Fix:** Use bare selectors for the root AND descendant selectors for children:
```css
/* Correct */
html.dark::-webkit-scrollbar-track,
html.dark ::-webkit-scrollbar-track {
  background: #1e293b;
}

/* Incorrect — misses the root scrollbar */
html.dark *::-webkit-scrollbar-track {
  background: #1e293b;
}
```

### 10.2. TitleBar Buttons Not Clickable

**Symptom:** Clicking the minimize/maximize buttons starts a drag operation instead.

**Cause:** The button container inherits `WebkitAppRegion: 'drag'` from the parent.

**Fix:** Override the drag region on the button container:
```tsx
<div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
  <button onClick={...}>Minimize</button>
</div>
```

### 10.3. Maximize Icon Out of Sync

**Symptom:** The maximize/restore icon doesn't update when the user maximizes via keyboard shortcuts.

**Cause:** Only tracking the button click, not the actual window state.

**Fix:** Subscribe to the `window:maximizeChange` event from the main process:
```tsx
useEffect(() => {
  if (!enabled || !window.api?.onWindowMaximizeChange) return
  const cleanup = window.api.onWindowMaximizeChange(setIsMaximized)
  return () => cleanup?.()
}, [enabled])
```

### 10.4. Settings Not Persisting

**Symptom:** Settings reset to defaults after restarting the app.

**Cause:** Not calling `writeAppSettings()` after changing a value, or the file path is incorrect.

**Fix:** Ensure each setter calls `writeAppSettings()`:
```ts
ipcMain.handle('settings:setHideHeader', (_e, value: boolean) => {
  const current = readAppSettings()
  current.hideHeader = value
  writeAppSettings(current)  // ← Don't forget this
  return true
})
```

### 10.5. TitleBar Appears in Web Builds

**Symptom:** The title bar shows up when running the app in a browser (where Electron APIs don't exist).

**Cause:** Not checking for `window.api` existence before enabling the component.

**Fix:** Guard the component with a feature check:
```tsx
useEffect(() => {
  if (!window.api?.getHideHeader) {
    setEnabled(false)
    return
  }
  // ... rest of the effect
}, [])
```

---

## 11. Color Palette Reference

All colors used by the header customization system:

| Token | Hex | Used for |
| --- | --- | --- |
| Title bar background (light) | `#f1f5f9` (slate-100) | `bg-slate-100` in TitleBar |
| Title bar background (dark) | `#0f172a` (slate-900) | `bg-slate-900` in TitleBar |
| Title bar border (light) | `#e2e8f0` (slate-200) | `border-slate-200` in TitleBar |
| Title bar border (dark) | `#1e293b` (slate-800) | `border-slate-800` in TitleBar |
| Button text (light) | `#64748b` (slate-500) | `text-slate-500` in TitleBar |
| Button text (dark) | `#94a3b8` (slate-400) | `text-slate-400` in TitleBar |
| Button hover (light) | `#e2e8f0` (slate-200) | `hover:bg-slate-200` in TitleBar |
| Button hover (dark) | `#1e293b` (slate-700) | `hover:bg-slate-700` in TitleBar |
| Scrollbar track (light) | `#e2e8f0` (slate-200) | `::-webkit-scrollbar-track` |
| Scrollbar track (dark) | `#1e293b` (slate-800) | `html.dark::-webkit-scrollbar-track` |
| Scrollbar thumb (light) | `#6366f1` (indigo-500) | `::-webkit-scrollbar-thumb` |
| Scrollbar thumb (dark) | `#818cf8` (indigo-400) | `html.dark::-webkit-scrollbar-thumb` |
| Scrollbar thumb hover (light) | `#4f46e5` (indigo-600) | `::-webkit-scrollbar-thumb:hover` |
| Scrollbar thumb hover (dark) | `#a5b4fc` (indigo-300) | `html.dark::-webkit-scrollbar-thumb:hover` |

---

## 12. Dimension Reference

| Element | Size |
| --- | --- |
| Title bar height | 32 px (`h-8`) |
| Title bar z-index | 60 (`z-[60]`) |
| Title bar padding (horizontal) | 8 px (`px-2`) |
| Button size | 32 × 32 px (`w-8 h-8`) |
| Button border-radius | 6 px (`rounded-md`) |
| Logo size | 20 × 20 px (`w-5 h-5`) |
| Scrollbar width/height | 10 px |
| Scrollbar border-radius | 5 px |
| Scrollbar thumb border | 2 px |

---

## 13. Settings Architecture Reference

| Setting | Type | Default | IPC Channel | Storage |
| --- | --- | --- | --- | --- |
| `showSplash` | boolean | `true` | `settings:getShowSplash` / `settings:setShowSplash` | `userData/settings.json` |
| `hideHeader` | boolean | `false` | `settings:getHideHeader` / `settings:setHideHeader` | `userData/settings.json` |
| `hideScrollbars` | boolean | `false` | (none) | `localStorage` |
| `navBarStatic` | boolean | `false` | (none) | `localStorage` |
| `navBarBottom` | boolean | (auto) | (none) | `localStorage` |
| `uiScale` | number | `1.0` | (none) | `localStorage` |

**Note:** Settings that affect window creation (`showSplash`, `hideHeader`) are stored in the main process via a JSON file because they must be read before the renderer loads. Settings that only affect the renderer (`hideScrollbars`, `navBarStatic`, etc.) are stored in `localStorage` for simplicity.
