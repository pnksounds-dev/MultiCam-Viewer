' Silent launcher for MultiCam Viewer
' Removes the ELECTRON_RUN_AS_NODE environment variable that some IDEs
' set globally, which would otherwise break the packaged Electron app.
On Error Resume Next
Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("PROCESS")
WshEnv.Remove("ELECTRON_RUN_AS_NODE")
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
exePath = appDir & "\MultiCam Viewer.exe"
' 1 = normal window, False = don't wait for app to exit
WshShell.Run """" & exePath & """", 1, False
Set WshShell = Nothing
