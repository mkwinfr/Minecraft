Option Explicit

Dim shell, fso, scriptDir, launcherPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = scriptDir & "\Launch Bedrock Panel.cmd"

' 0 = hidden window, False = do not wait
shell.Run """" & launcherPath & """", 0, False
