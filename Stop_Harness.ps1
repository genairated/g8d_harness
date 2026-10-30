# Stop_Harness.ps1
# Stop production AND its supervisor. Sets the stop-flag (so the supervisor loop exits instead of
# relaunching), asks the server to exit gracefully, then makes sure nothing lingers on the port.

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_harness-release-lib.ps1"

# Fixed, not read from ambient $env:HARNESS_PORT — see Deploy_Harness.ps1 for why.
$PROD_PORT = 3400
function Say { param([string]$m, [string]$c = "Gray") Write-Host $m -ForegroundColor $c }

$hadSupervisor = Test-SupervisorFlag
Set-StopFlag

$up = Test-HarnessHealth -Port $PROD_PORT -TimeoutSec 2
if ($up) {
    # Graceful: server exits, the supervisor sees the stop-flag and breaks its loop (no relaunch).
    Request-HarnessRestart -Port $PROD_PORT -Reason "stop" | Out-Null
    Start-Sleep -Seconds 1
}
$freed = Stop-HarnessOnPort $PROD_PORT   # safety net (and the path when no supervisor was running)
if (-not $freed) {
    Say ("[X] :{0} 仍被佔用，停止失敗：{1}" -f $PROD_PORT, (Get-LastPortStopError)) "Red"
    Say ("    本次執行權限：{0}。若伺服器是以較高權限啟動的，請改用系統管理員身分重跑，或先跑 ./Fix_Harness_AutoStart.ps1。" -f $(if (Test-IsElevated) { "系統管理員" } else { "一般使用者" })) "Yellow"
    if (-not $hadSupervisor) { Clear-StopFlag }
    exit 1
}

# If nobody is looping, clear our own flag so a future direct launch isn't confused.
if (-not $hadSupervisor) { Clear-StopFlag }

Say ("[OK] Stopped harness on :{0}." -f $PROD_PORT) "Green"
