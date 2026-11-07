# boot-smoke.ps1 - 隔離開機檢查（pwsh 7 執行；本檔含中文，須存 UTF-8 with BOM）
# 目的：node --check 只查語法，查不出「合起來開不開得起來」。這支腳本用空的資料目錄
#       真的把 server.js 開起來，確認 /api/ping 回得出 bootId。
# 用法：pwsh -File portal/checks/boot-smoke.ps1 [-ServerPath <server.js>] [-Port 3398] [-TimeoutSec 30]
# 結束碼：0 = PASS；1 = FAIL。
# 安全：HARNESS_HOME 指到工作區 _tmp/boot-smoke-<隨機碼>/ 的空目錄（沒有 secrets/telegram.json，
#       Telegram 輪詢自動略過）；不碰正式資料；結束前一定殺掉子行程並刪暫存目錄。
param(
    [string]$ServerPath = "",
    [int]$Port = 3398,
    [int]$TimeoutSec = 30
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $root "_harness-release-lib.ps1")   # 重用 Start-HarnessNode / Test-HarnessHealth / Stop-HarnessOnPort

if (-not $ServerPath) { $ServerPath = Join-Path $root "portal\server.js" }
$venv = Join-Path $root ".venv\Scripts\python.exe"

function Finish([bool]$ok, [string]$reason) {
    if ($ok) { Write-Host "BOOT-SMOKE PASS"; exit 0 }
    Write-Host ("BOOT-SMOKE FAIL: {0}" -f $reason); exit 1
}

if ($Port -in 3400, 3499) { Finish $false "不可使用正式埠或部署冒煙埠（$Port）" }
if (-not (Test-Path $ServerPath)) { Finish $false "找不到 server 檔：$ServerPath" }
$ServerPath = (Resolve-Path $ServerPath).Path
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Finish $false "埠 $Port 已被占用（可能有另一個開機檢查在跑），為免誤殺不處理"
}

$rand = -join ((48..57) + (97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$tmpHome = Join-Path $root "_tmp\boot-smoke-$rand"
New-Item -ItemType Directory -Force -Path $tmpHome | Out-Null
$outLog = Join-Path $tmpHome "boot-stdout.log"
$errLog = Join-Path $tmpHome "boot-stderr.log"
$proc = $null
$ok = $false; $reason = ""
$oldVenv = $env:HARNESS_VENV
try {
    $env:HARNESS_VENV = $venv
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $proc = Start-HarnessNode -ServerPath $ServerPath -Port $Port -HarnessHome $tmpHome `
        -StartArgs @{ WindowStyle = "Hidden"; RedirectStandardOutput = $outLog; RedirectStandardError = $errLog }
    $env:HARNESS_VENV = $oldVenv   # 子行程已繼承，立刻還原

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $bootId = $null
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { $reason = "server 開機途中就結束了（exit code $($proc.ExitCode)）"; break }
        $bootId = Test-HarnessHealth -Port $Port -TimeoutSec 2
        if ($bootId) { break }
    }
    if ($bootId) { $ok = $true; Write-Host ("開機成功：bootId={0}，耗時 {1:N1} 秒" -f $bootId, $sw.Elapsed.TotalSeconds) }
    elseif (-not $reason) { $reason = "$TimeoutSec 秒內 /api/ping 沒有回應" }
} catch {
    $reason = "檢查腳本本身出錯：$($_.Exception.Message)"
} finally {
    $env:HARNESS_VENV = $oldVenv
    if (-not $ok) {
        foreach ($f in @($errLog, $outLog)) {
            if (Test-Path $f) {
                $tail = Get-Content $f -Tail 40 -ErrorAction SilentlyContinue
                if ($tail) { Write-Host ("---- {0} 最後 40 行 ----" -f (Split-Path $f -Leaf)); $tail | ForEach-Object { Write-Host $_ } }
            }
        }
    }
    if ($proc -and -not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
    Stop-HarnessOnPort -Port $Port | Out-Null
    Start-Sleep -Milliseconds 300
    try { Remove-Item -Recurse -Force $tmpHome -ErrorAction Stop } catch { Write-Host "（提醒）暫存目錄未能刪除：$tmpHome" }
}
Finish $ok $reason
