' Start CommandCodeGo Manager in background (no console window)
' Working directory is derived from this script's own location, so the whole
' folder can be copied to another machine without editing any path.
Option Explicit
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "cmd /c node server.mjs", 0, False
