# Virtual Camera Driver (UnityCapture)

This folder should contain the UnityCapture DirectShow filter DLL.

## Steps to get the DLL

1. Download UnityCapture from: https://github.com/schellingb/UnityCapture
2. Click "Download ZIP" or clone the repository
3. In the downloaded ZIP, find: `Install/UnityCaptureFilter64bit.dll`
4. Copy `UnityCaptureFilter64bit.dll` into THIS folder (`vcam/`)

## Registering the DLL

The app will attempt to register the DLL automatically on first run (requires Administrator).

You can also register it manually from an elevated command prompt:

```
regsvr32 "path\to\vcam\UnityCaptureFilter64bit.dll"
```

To support multiple simultaneous virtual cameras (one per app window), 
run `InstallMultipleDevices.bat` from the UnityCapture repository instead, 
specifying the number of devices you need (e.g. 4).

## What this enables

Once registered, apps like OBS will see new video capture devices:
- "Unity Video Capture" (slot 1, first app window)
- "Unity Video Capture 2" (slot 2, second app window)
- etc.

In OBS: Add Source → Video Capture Device → Select "Unity Video Capture"
