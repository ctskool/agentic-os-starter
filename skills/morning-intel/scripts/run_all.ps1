# morning-intel fetch layer — run all fetchers in parallel (metrics-pull pattern).
# Cron-friendly: never throws; each fetcher writes its own status JSON.
$scripts = @("fetch_smol.py", "fetch_hn.py", "fetch_youtube.py", "fetch_github.py", "fetch_changelogs.py", "fetch_outliers.py")
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jobs = @()
foreach ($s in $scripts) {
    $path = Join-Path $dir $s
    $jobs += Start-Job -ScriptBlock { param($p) python $p } -ArgumentList $path
}
$done = Wait-Job -Job $jobs -Timeout 360
foreach ($j in $jobs) {
    try { Receive-Job -Job $j -ErrorAction SilentlyContinue } catch {}
    try { Remove-Job -Job $j -Force -ErrorAction SilentlyContinue } catch {}
}
exit 0
