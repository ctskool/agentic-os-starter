# Voice module installer — Windows. Idempotent.
# Installs the HUD/voice-router server (:3107) + Kokoro/whisper voice server
# (:3108), downloads models (~350MB), and optionally registers autostart.
param(
    [ValidateSet("", "yes", "no")][string]$Autostart = ""
)
$ErrorActionPreference = "Stop"
$VDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "=== Voice module installer (Windows) ===" -ForegroundColor Cyan
Write-Host ""

# 1. HUD server deps
Write-Host "-> npm install (HUD server)"
Push-Location (Join-Path $VDir "hud-server")
npm install --no-audit --no-fund
Pop-Location

# 2. Python venv + deps
Write-Host "-> Python venv + deps (voice server)"
$VS = Join-Path $VDir "voice-server"
Push-Location $VS
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install -q --upgrade pip
& ".\.venv\Scripts\python.exe" -m pip install -q -r requirements.txt

# 3. Models (~350MB, idempotent)
Write-Host "-> Downloading voice models"
& ".\.venv\Scripts\python.exe" download_models.py
Pop-Location

# 4. Autostart (Startup-folder shortcuts, no admin)
if ($Autostart -eq "") {
    $YN = Read-Host "Start voice servers at login? [Y/n]"
} else {
    $YN = if ($Autostart -eq "yes") { "Y" } else { "n" }
}
if ($YN -ne "n" -and $YN -ne "N") {
    $Startup = [Environment]::GetFolderPath("Startup")
    $Ws = New-Object -ComObject WScript.Shell
    $L1 = $Ws.CreateShortcut((Join-Path $Startup "agentic-os-voice-server.lnk"))
    $L1.TargetPath = "wscript.exe"
    $L1.Arguments = """$VS\start-voice-server.vbs"""
    $L1.Save()
    $L2 = $Ws.CreateShortcut((Join-Path $Startup "agentic-os-hud.lnk"))
    $L2.TargetPath = "wscript.exe"
    $L2.Arguments = """$VDir\hud-server\start-hud.vbs"""
    $L2.Save()
    Write-Host "-> Startup shortcuts added"
    Start-Process wscript.exe -ArgumentList """$VS\start-voice-server.vbs"""
    Start-Process wscript.exe -ArgumentList """$VDir\hud-server\start-hud.vbs"""
    Write-Host "-> Both servers started"
}

Write-Host ""
Write-Host "=== Voice module done ===" -ForegroundColor Green
Write-Host "Test TTS: Invoke-WebRequest 'http://127.0.0.1:3108/speak?text=voice+online' -OutFile `$env:TEMP\t.wav; start `$env:TEMP\t.wav"
Write-Host "Then in Obsidian: plugin settings -> enable the orb. First reply may be slow while whisper downloads its model."
Write-Host ""
