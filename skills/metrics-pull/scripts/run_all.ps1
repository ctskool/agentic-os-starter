# run_all.ps1 — wrapper invoked by Windows Task Scheduler.
# Runs all four metric-pull scripts in parallel via Start-Job, waits with a
# timeout, then logs each result. Designed to never throw — scheduler should
# never see a failure even if every source dies.

$ErrorActionPreference = "Continue"

$root = "~\.claude\skills\metrics-pull\scripts"
$logDir = "~\.claude\skills\metrics-pull\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$ts = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss")
$logFile = Join-Path $logDir "run-$ts.log"

$sources = @("pull_claude_usage.py", "pull_youtube.py", "pull_instagram.py", "pull_tiktok.py")

"=== Chase Metrics Pull run started at $ts ===" | Out-File -FilePath $logFile -Encoding utf8

$jobs = @()
foreach ($src in $sources) {
    $path = Join-Path $root $src
    $jobs += Start-Job -ArgumentList $path -ScriptBlock {
        param($scriptPath)
        try {
            python $scriptPath 2>&1
        } catch {
            "ERROR: $($_.Exception.Message)"
        }
    }
}

# Wait up to 90 seconds total for all jobs
$timeout = 90
Wait-Job -Job $jobs -Timeout $timeout | Out-Null

foreach ($job in $jobs) {
    $name = $job.Name
    $state = $job.State
    "--- job $name state=$state ---" | Out-File -FilePath $logFile -Append -Encoding utf8
    if ($state -eq "Running") {
        Stop-Job -Job $job
        "(stopped due to timeout)" | Out-File -FilePath $logFile -Append -Encoding utf8
    }
    Receive-Job -Job $job 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    Remove-Job -Job $job -Force
}

"=== run finished at $((Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')) ===" | Out-File -FilePath $logFile -Append -Encoding utf8
exit 0
