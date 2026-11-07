# _harness-deferred-golive.ps1
# "Go live LATER": the no-supervisor counterpart of the server's deferred /api/restart.
#
# WHY THIS EXISTS: when a supervisor (Start_Harness.ps1) owns :3400, a deploy only SIGNALS a restart
# and the server itself waits until every running job (chat turn / scheduled run) has finished and
# saved before exiting. With NO supervisor (orphan server — e.g. the supervisor console was closed),
# Switch-LiveVersion used to hard-kill :3400 immediately. When the deploy was run BY a chat turn
# (Hana self-healing), that killed the very server carrying the turn: the reply never came back and
# the commander was left not knowing what happened.
#
# Deploy now spawns this script DETACHED and returns "DEFERRED". It:
#   1. polls POST /api/chat/flush (its `flushed` = number of running jobs; also snapshots them) until
#      the server is idle twice in a row, or MaxWaitMin elapses (same 10-min safety cap as the server);
#   2. re-reads current.json AT THAT MOMENT (a later deploy may have promoted something newer);
#   3. if a supervisor appeared meanwhile, just asks it to restart; otherwise stop -> start -> health,
#      record last-known-good after 30s healthy, or roll back to the version that was live.
# Only ONE waiter runs at a time (lock file); a second deploy just lets the first one pick up its
# newer current.json. Log: .harness\runtime\deferred-golive.log

param(
    [int]$Port = 3400,
    [string]$HarnessHome,
    [int]$MaxWaitMin = 10
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_harness-release-lib.ps1"
if (-not $HarnessHome) { $HarnessHome = Get-HarnessRoot }

$rtDir = Join-Path $HarnessHome ".harness\runtime"
New-Item -ItemType Directory -Force -Path $rtDir | Out-Null
$logPath  = Join-Path $rtDir "deferred-golive.log"
$lockPath = Join-Path $rtDir ("deferred-golive-{0}.lock" -f $Port)
function Log { param([string]$m) try { Add-Content -Path $logPath -Value ("[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $m) -Encoding UTF8 } catch { } }

# Single waiter per port.
if (Test-Path $lockPath) {
    $other = 0
    try { [int]::TryParse((Get-Content $lockPath -Raw).Trim(), [ref]$other) | Out-Null } catch { }
    if ($other -gt 0 -and $other -ne $PID -and (Get-Process -Id $other -ErrorAction SilentlyContinue)) {
        Log ("another waiter (PID {0}) is already queued; it will pick up the latest current.json. exiting." -f $other)
        exit 0
    }
}
Set-Content -Path $lockPath -Value ("{0}" -f $PID)

try {
    Log ("waiting for :{0} to become idle (max {1} min) ..." -f $Port, $MaxWaitMin)
    $deadline = (Get-Date).AddMinutes($MaxWaitMin)
    $idle = 0
    while ($true) {
        $busy = -1
        try { $r = Invoke-RestMethod -Method Post -Uri ("http://localhost:{0}/api/chat/flush" -f $Port) -TimeoutSec 5; $busy = [int]$r.flushed } catch { }
        if ($busy -lt 0) { Log "server not answering - going live now."; break }
        if ($busy -eq 0) { $idle++; if ($idle -ge 2) { Log "idle - going live."; break } }
        else { $idle = 0 }
        if ((Get-Date) -gt $deadline) { Log ("still {0} job(s) running after {1} min - going live anyway (safety cap)." -f $busy, $MaxWaitMin); break }
        Start-Sleep -Seconds 3
    }

    $target = Get-CurrentVersion
    $liveVer = $null
    try { $liveVer = (Invoke-RestMethod -Uri ("http://localhost:{0}/api/ping" -f $Port) -TimeoutSec 3).version } catch { }
    if ($liveVer -and $liveVer -eq $target) { Log ("{0} is already live - nothing to do." -f $target); exit 0 }

    if (Test-SupervisorFlag) {
        Log ("a supervisor appeared - asking it to restart onto {0}." -f $target)
        Request-HarnessRestart -Port $Port -Reason ("deploy-" + $target) | Out-Null
        exit 0
    }

    if (-not (Stop-HarnessOnPort $Port)) {
        $why = Get-LastPortStopError
        if ($liveVer) { Set-CurrentVersion $liveVer }
        Log ("BLOCKED: could not stop :{0} ({1}). {2} NOT live; current.json put back to {3}." -f $Port, $why, $target, $liveVer)
        exit 1
    }
    Start-HarnessRelease -Version $target -Port $Port -HarnessHome $HarnessHome | Out-Null
    $boot = Test-HarnessHealth -Port $Port -TimeoutSec 60
    if ($boot) {
        Start-Sleep -Seconds 30
        $v = $null
        try { $v = (Invoke-RestMethod -Uri ("http://localhost:{0}/api/ping" -f $Port) -TimeoutSec 3).version } catch { }
        if ($v -eq $target) {
            Set-LastKnownGood $target
            Log ("[OK] {0} is LIVE on :{1} (bootId {2}); recorded last-known-good." -f $target, $Port, $boot)
            exit 0
        }
        Log ("{0} answered once but did not stay up (now: {1}) - rolling back." -f $target, $v)
    } else {
        Log ("{0} did not come up within 60s - rolling back." -f $target)
    }

    $fallback = $liveVer
    if (-not $fallback) { $fallback = Get-LastKnownGood }
    if ($fallback -and $fallback -ne $target -and (Test-ReleaseExists $fallback)) {
        Stop-HarnessOnPort $Port | Out-Null
        Set-CurrentVersion $fallback
        Start-HarnessRelease -Version $fallback -Port $Port -HarnessHome $HarnessHome | Out-Null
        if (Test-HarnessHealth -Port $Port -TimeoutSec 60) { Log ("[OK] rolled back to {0}." -f $fallback) }
        else { Log ("[X] rollback to {0} also failed. Manual rescue: run Start_Harness.ps1." -f $fallback) }
    } else {
        Log "[X] no previous release to roll back to."
    }
    exit 1
} catch {
    Log ("[X] waiter crashed: {0}" -f $_.Exception.Message)
    exit 1
} finally {
    try { if ((Get-Content $lockPath -Raw -ErrorAction Stop).Trim() -eq "$PID") { Remove-Item -Force $lockPath -ErrorAction SilentlyContinue } } catch { }
}
