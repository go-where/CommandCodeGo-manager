' Start CommandCodeGo Manager in background (no console window)
' Working directory is derived from this script's own location, so the whole
' folder can be copied to another machine without editing any path.
Option Explicit
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
' Upstream stream idle timeout in ms. The 30000 default kills legitimate long
' reasoning / slow first token (issue #19); 180000 leaves enough headroom.
sh.Environment("PROCESS")("CC_STREAM_IDLE_MS") = "180000"
sh.Run "cmd /c node server.mjs", 0, False
