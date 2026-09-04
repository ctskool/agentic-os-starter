# Agentic OS starter — Windows installer.
# Idempotent: safe to re-run. Never overwrites existing vault notes or your .env.
# Run from an unblocked PowerShell:  powershell -ExecutionPolicy Bypass -File .\install.ps1
param(
    # Non-interactive flags (used by the /setup-agentic-os skill)
    [string]$Vault = "",
    [ValidateSet("", "yes", "no")][string]$Autostart = "",
    [ValidateSet("", "yes", "no")][string]$Voice = ""
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "=== Agentic OS installer (Windows) ===" -ForegroundColor Cyan
Write-Host ""

# 1. Vault location
$DefaultVault = Join-Path $env:USERPROFILE "the-vault"
if ([string]::IsNullOrWhiteSpace($Vault)) {
    $Vault = Read-Host "Vault folder [$DefaultVault]"
    if ([string]::IsNullOrWhiteSpace($Vault)) { $Vault = $DefaultVault }
}
New-Item -ItemType Directory -Force -Path $Vault | Out-Null

# 2. Vault template (copy without clobbering existing files)
Write-Host "-> Copying vault template into $Vault (existing files kept)"
$src = Join-Path $Repo "vault-template"
Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1)
    $dest = Join-Path $Vault $rel
    if (-not (Test-Path $dest)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        Copy-Item $_.FullName $dest
    }
}

# 3. Obsidian plugin
$Plug = Join-Path $Vault ".obsidian\plugins\chase-command-center"
Write-Host "-> Installing cockpit plugin to $Plug"
New-Item -ItemType Directory -Force -Path $Plug | Out-Null
Copy-Item -Recurse -Force (Join-Path $Repo "plugin\chase-command-center\*") $Plug

# 4. Skills
Write-Host "-> Installing global skills to ~\.claude\skills"
$GSkills = Join-Path $env:USERPROFILE ".claude\skills"
New-Item -ItemType Directory -Force -Path $GSkills | Out-Null
Copy-Item -Recurse -Force (Join-Path $Repo "skills\*") $GSkills
Write-Host "-> Installing vault-level skills to $Vault\.claude\skills"
$VSkills = Join-Path $Vault ".claude\skills"
New-Item -ItemType Directory -Force -Path $VSkills | Out-Null
Copy-Item -Recurse -Force (Join-Path $Repo "skills-vault\*") $VSkills

# 5. Runner
$Runner = Join-Path $env:USERPROFILE ".claude\agentic-os-runner"
Write-Host "-> Installing runner to $Runner"
New-Item -ItemType Directory -Force -Path $Runner | Out-Null
Copy-Item -Force (Join-Path $Repo "runner\runner.js") $Runner
Copy-Item -Force (Join-Path $Repo "runner\package.json") $Runner
Copy-Item -Force (Join-Path $Repo "runner\start-runner.vbs") $Runner
Copy-Item -Force (Join-Path $Repo "runner\run-hidden.vbs") $Runner

# 6. Env file (never overwrite)
$EnvF = Join-Path $env:USERPROFILE ".claude\.env"
if (-not (Test-Path $EnvF)) {
    Write-Host "-> Creating $EnvF from template"
    Copy-Item (Join-Path $Repo ".env.example") $EnvF
}
$envText = Get-Content $EnvF -Raw
if ($envText -match "(?m)^AGENTIC_OS_VAULT=[^\r\n]*[^\s]") {
    Write-Host "-> AGENTIC_OS_VAULT already set (leaving as-is)"
} else {
    $vaultFwd = $Vault -replace "\\", "/"
    $envText = $envText -replace "(?m)^AGENTIC_OS_VAULT=[^\r\n]*", "AGENTIC_OS_VAULT=$vaultFwd"
    [IO.File]::WriteAllText($EnvF, $envText, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "-> Set AGENTIC_OS_VAULT=$vaultFwd"
}

# 7. Autostart + schedule
if ($Autostart -eq "") {
    $YN = Read-Host "Install autostart (runner at login) + metrics task every 6h? [Y/n]"
} else {
    $YN = if ($Autostart -eq "yes") { "Y" } else { "n" }
}
if ($YN -ne "n" -and $YN -ne "N") {
    # runner: VBS shortcut in shell:startup (no admin needed)
    $Startup = [Environment]::GetFolderPath("Startup")
    $Ws = New-Object -ComObject WScript.Shell
    $Lnk = $Ws.CreateShortcut((Join-Path $Startup "agentic-os-runner.lnk"))
    $Lnk.TargetPath = "wscript.exe"
    $Lnk.Arguments = """$Runner\start-runner.vbs"""
    $Lnk.Save()
    Write-Host "-> Runner autostart shortcut added to shell:startup"
    # metrics: scheduled task every 6h. Registered through run-hidden.vbs —
    # "powershell -WindowStyle Hidden" still flashes a console for a frame on
    # every fire; a wscript-launched window never shows. The ScheduledTasks
    # cmdlets avoid schtasks' 261-char action limit on long usernames.
    $HiddenVbs = Join-Path $Runner "run-hidden.vbs"
    $RunAll = Join-Path $GSkills "metrics-pull\scripts\run_all.ps1"
    $TaskAction = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$HiddenVbs`" powershell -NoProfile -ExecutionPolicy Bypass -File `"$RunAll`""
    $TaskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6)
    Register-ScheduledTask -TaskName "AgenticOS Metrics Pull" -Action $TaskAction -Trigger $TaskTrigger -Force | Out-Null
    Write-Host "-> Scheduled task 'AgenticOS Metrics Pull' registered (every 6h, hidden)"
    # start the runner now
    Start-Process wscript.exe -ArgumentList """$Runner\start-runner.vbs"""
    Write-Host "-> Runner started"
}

# 8. Voice module (optional — ~350MB model download)
if ($Voice -eq "") {
    $VYN = Read-Host "Install voice mode (orb TTS/STT - local Kokoro + whisper, ~350MB download)? [y/N]"
} else {
    $VYN = if ($Voice -eq "yes") { "y" } else { "n" }
}
if ($VYN -eq "y" -or $VYN -eq "Y") {
    $VAuto = if ($Autostart -eq "") { "yes" } else { $Autostart }
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Repo "voice\install-voice.ps1") -Autostart $VAuto
}

Write-Host ""
Write-Host "=== Done. Next steps (see docs\setup-windows.md for detail) ===" -ForegroundColor Green
Write-Host "1. Fill in API keys:        notepad $EnvF"
Write-Host "2. Open the vault in Obsidian, then Settings > Community plugins >"
Write-Host "   enable 'Chase Command Center'."
Write-Host "3. Authenticate Claude Code MCP connectors (Gmail/Calendar): run"
Write-Host "   'claude' inside the vault folder, then /mcp."
Write-Host "4. Test: click a cockpit button, or run the metrics task from Task Scheduler."
Write-Host ""
