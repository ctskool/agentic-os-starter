' start-hud.vbs — launches the Jarvis HUD Next server hidden on :3107.
' Serves the voice router + TTS proxy for BOTH the browser HUD and the
' Obsidian cockpit orb. Drop a shortcut into shell:startup to run at login
' (same pattern as the agentic-os runner and the voice server).

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

WshShell.CurrentDirectory = dir
' Output goes to .next-dev.log so a silent crash leaves a cause behind.
WshShell.Run "cmd /c npx next dev -p 3107 >> .next-dev.log 2>&1", 0, False
Set WshShell = Nothing
