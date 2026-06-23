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

!macro customUnInstall
  ; electron-builder handles default shortcut removal; no extra needed.
!macroend
