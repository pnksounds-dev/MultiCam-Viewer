# Virtual Camera Driver (UnityCapture)

This folder should contain the UnityCapture DirectShow filter DLL.

## Branded build

The source code in `useful files\UnityCapture-master\Source\UnityCaptureFilter.cpp` has been updated so the device appears as **"MultiCam"** in OBS instead of "Unity Video Capture".

To use the branded name:

1. Open `useful files\UnityCapture-master\Source\UnityCaptureFilter.sln` in Visual Studio.
2. Build the **Release x64** configuration.
3. Copy `Build\Release-UnityCaptureFilter64\UnityCaptureFilter64.dll` into this `vcam/` folder.

## Steps to use the original DLL

1. Download UnityCapture from: https://github.com/schellingb/UnityCapture
2. Click "Download ZIP" or clone the repository.
3. In the downloaded ZIP, find: `Install/UnityCaptureFilter64bit.dll`
4. Rename it to `UnityCaptureFilter64.dll` and copy it into this `vcam/` folder.

## Registering the DLL

The app will attempt to register the DLL automatically (requires Administrator).

You can also register it manually from an elevated command prompt:

```
regsvr32 "path\to\vcam\UnityCaptureFilter64.dll"
```

To support multiple simultaneous virtual cameras (one per app window), run `install-multiple-devices.bat` as Administrator.

## What this enables

Once registered, apps like OBS will see new video capture devices:
- "MultiCam" (slot 1, first app window)
- "MultiCam 2" (slot 2, second app window)
- etc.

**Important:** For the video feed to appear, the app must also have a native frame-writing bridge (`vcam-native.wasm`). This bridge is not currently shipped. Until it is available, **OBS Window Capture** is the recommended and reliable method: Add Source → Window Capture → select "MultiCam Viewer".
