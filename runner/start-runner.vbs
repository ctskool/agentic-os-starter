' start-runner.vbs — (re)launches the Chase Agentic OS Runner hidden.
' Dropped into shell:startup so it fires on every login without admin rights.
' Kills the previous instance first (pid from runner.pid) so a relaunch
' actually picks up runner.js edits — before 2026-08-13 this only spawned,
' and the singleton lock made "restarts" silently keep the OLD process.

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile = dir & "\runner.pid"

If fso.FileExists(pidFile) Then
  On Error Resume Next
  pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
  If Len(pid) > 0 And IsNumeric(pid) Then
    ' /F force, /T include children; exits quietly if pid is gone
    WshShell.Run "taskkill /PID " & pid & " /F /T", 0, True
  End If
  fso.DeleteFile pidFile, True
  On Error GoTo 0
End If

WScript.Sleep 1500
WshShell.Run "node.exe """ & dir & "\runner.js""", 0, False
Set WshShell = Nothing
