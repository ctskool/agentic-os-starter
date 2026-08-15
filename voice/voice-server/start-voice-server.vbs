' start-voice-server.vbs — launches the local Kokoro TTS server hidden.
' Drop a shortcut into shell:startup to run it at login (same pattern as
' the agentic-os runner).

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' Wake word off — speaker bleed into the mic made hands-free overlap with
' Jarvis's own replies (2026-06-12, Chase's call: push-to-talk only).
' Delete this line (or set "on") to re-arm hands-free.
WshShell.Environment("PROCESS")("WAKE_WORD") = "off"

' -u + redirect: unbuffered output into voice-server.log so a silent crash
' leaves a cause behind.
WshShell.Run "cmd /c """"" & dir & "\.venv\Scripts\python.exe"" -u """ & dir & "\server.py"" >> """ & dir & "\voice-server.log"" 2>&1""", 0, False
Set WshShell = Nothing
