' run-hidden.vbs — run any command with a fully hidden window.
' Usage: wscript.exe run-hidden.vbs <exe> [args...]
' Inherits the caller's working directory; waits for exit and passes through the exit code.

Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 And Left(a, 1) <> Chr(34) Then a = Chr(34) & a & Chr(34)
  cmd = cmd & a & " "
Next
If Len(Trim(cmd)) > 0 Then
  rc = sh.Run(Trim(cmd), 0, True)
  WScript.Quit rc
End If
