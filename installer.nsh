; Override the default shortcut macros so Start Menu / Desktop shortcuts
; point to the silent VBS launcher, which clears the ELECTRON_RUN_AS_NODE
; environment variable that some IDEs set globally.

!macro addStartMenuLink keepShortcuts
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} $keepShortcuts == "false"
      !insertmacro cleanupOldMenuDirectory
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$INSTDIR\launcher.vbs" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${elseif} $oldStartMenuLink != $newStartMenuLink
    ${andIf} ${FileExists} "$oldStartMenuLink"
      !insertmacro createMenuDirectory
      Rename $oldStartMenuLink $newStartMenuLink
      WinShell::UninstShortcut "$oldStartMenuLink"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      !insertmacro cleanupOldMenuDirectory
    ${endIf}
  !endif
!macroend

!macro addDesktopLink keepShortcuts
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      ${if} $keepShortcuts == "false"
        CreateShortCut "$newDesktopLink" "$INSTDIR\launcher.vbs" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${elseif} $oldDesktopLink != $newDesktopLink
      ${andIf} ${FileExists} "$oldDesktopLink"
        Rename $oldDesktopLink $newDesktopLink
        WinShell::UninstShortcut "$oldDesktopLink"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
    ${endIf}
  !endif
!macroend

; Register the MultiCam virtual camera driver at install time.
; NSIS runs elevated for admin installs, so no UAC prompt is needed.
; /s keeps regsvr32 silent (no native MessageBoxA dialogs); exit codes
; are checked and logged as warnings but do NOT abort the install —
; the app still works via Window Capture without the driver.
!macro customInstall
  DetailPrint "Registering MultiCam virtual camera driver..."
  ExecWait 'regsvr32 /s /i:UnityCaptureDevices=4 "$INSTDIR\resources\vcam\UnityCaptureFilter64.dll"' $0
  ${if} $0 != 0
    DetailPrint "Warning: 64-bit driver registration failed (code $0). You can register it later from Settings."
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\vcam\UnityCaptureFilter32.dll"
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /s /i:UnityCaptureDevices=4 "$INSTDIR\resources\vcam\UnityCaptureFilter32.dll"' $1
    ${if} $1 != 0
      DetailPrint "Warning: 32-bit driver registration failed (code $1). 64-bit OBS will still work."
    ${endif}
  ${endif}
!macroend

; Unregister the virtual camera driver on uninstall so the app cleans
; up after itself. NSIS runs customUnInstall before removing files by
; default, so the DLLs are still present when regsvr32 /u runs.
!macro customUnInstall
  DetailPrint "Unregistering MultiCam virtual camera driver..."
  ExecWait 'regsvr32 /u /s "$INSTDIR\resources\vcam\UnityCaptureFilter64.dll"' $0
  ${if} $0 != 0
    DetailPrint "Warning: 64-bit driver unregistration failed (code $0)."
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\vcam\UnityCaptureFilter32.dll"
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\vcam\UnityCaptureFilter32.dll"' $1
    ${if} $1 != 0
      DetailPrint "Warning: 32-bit driver unregistration failed (code $1)."
    ${endif}
  ${endif}
!macroend
