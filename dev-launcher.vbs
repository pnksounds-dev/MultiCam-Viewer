' Silent dev launcher for MultiCam Viewer
' Clears ELECTRON_RUN_AS_NODE (set by some IDEs) and launches the local
' Electron binary without showing a console window.
On Error Resume Next
Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("PROCESS")
WshEnv.Remove("ELECTRON_RUN_AS_NODE")
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
exePath = appDir & "\node_modules\electron\dist\electron.exe"
' 0 = hidden window, False = don't wait for app to exit
WshShell.Run """" & exePath & """ """ & appDir & """", 0, False
Set WshShell = Nothing
