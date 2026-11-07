# Rollplayer 服务管理（唯一逻辑入口，由 start.bat 调用）
# 判定原则：只认「服务自己写的运行记录」，并做四重校验；不按端口猜、不笼统杀 node。
param(
  [ValidateSet('precheck','stop','status','cleanup')] [string]$Action = 'status',
  [ValidateSet('local','lan')]              [string]$Mode   = 'local'
)

$ErrorActionPreference = 'Continue'
$projRoot = Split-Path -Parent $PSScriptRoot
$runFile  = Join-Path $projRoot 'data\run\service.json'
$portLo   = 9898
$portHi   = 9902

function Read-Record {
  if (-not (Test-Path -LiteralPath $runFile)) { return $null }
  try {
    $obj = ([IO.File]::ReadAllText($runFile)) | ConvertFrom-Json
    if (-not $obj.pid -or -not $obj.port) { return $null }
    return $obj
  } catch { return $null }
}

function Get-CimOf($procId) {
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop } catch { return $null }
}

# 四重校验：pid 存活 / 进程名 node / 命令行含 server.mjs / 启动时刻吻合（防 pid 复用）
function Test-RecordMatchesProcess($rec) {
  $p = Get-Process -Id $rec.pid -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  if ($p.ProcessName -notlike 'node*') { return $false }
  $cim = Get-CimOf $rec.pid
  if (-not $cim) { return $false }
  if (-not $cim.CommandLine -or $cim.CommandLine -notlike '*server.mjs*') { return $false }
  if ($rec.exe -and $cim.ExecutablePath -and ($cim.ExecutablePath -ne $rec.exe)) { return $false }
  try {
    $recTime = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$rec.startedAt).LocalDateTime
    $diffSec = [Math]::Abs((New-TimeSpan -Start $recTime -End $p.StartTime).TotalSeconds)
    if ($diffSec -gt 15) { return $false }
  } catch {}
  return $true
}

function Get-LanUrls($port) {
  $out = @()
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object {
      if ($_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*') {
        $out += ("http://{0}:{1}" -f $_.IPAddress, $port)
      }
    }
  } catch {}
  return $out
}

function Show-Addresses($rec) {
  Write-Host ("           本机    http://127.0.0.1:{0}" -f $rec.port)
  if ($rec.host -eq '0.0.0.0') {
    $lan = Get-LanUrls $rec.port
    if ($lan.Count -gt 0) { $lan | ForEach-Object { Write-Host ("           局域网  {0}" -f $_) } }
    else { Write-Host "           局域网  （未检测到可用的局域网 IPv4 地址）" -ForegroundColor Yellow }
  }
}

function Test-IsOurStray($port, $cim) {
  if (-not $cim) { return $false }
  if ($cim.Name -notlike 'node*') { return $false }
  if (-not $cim.CommandLine -or $cim.CommandLine -notlike '*server.mjs*') { return $false }
  return $true
}

function Find-Strays {
  $found = @()
  foreach ($port in $portLo..$portHi) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $cim = Get-CimOf $c.OwningProcess
      if (Test-IsOurStray $port $cim) {
        $found += [pscustomobject]@{ pid = [int]$c.OwningProcess; port = $port; host = '?'; source = '特征识别' }
      }
    }
  }
  return $found
}

# ---------- 预检：能不能启动 ----------
if ($Action -eq 'precheck') {
  Write-Host "覆盖检查方式：运行记录（data\run\service.json）+ 进程四重校验" -ForegroundColor DarkGray

  $rec = Read-Record
  if ($rec) {
    if (Test-RecordMatchesProcess $rec) {
      Write-Host ""
      Write-Host "[已在运行] 服务已经启动，本次不重复开启。" -ForegroundColor Green
      Write-Host ("           进程    pid {0}" -f $rec.pid)
      Write-Host ("           端口    {0}（监听 {1}）" -f $rec.port, $rec.host)
      Show-Addresses $rec
      Write-Host "           要停止：再次双击本文件，选 3（停止服务）"
      exit 1
    } else {
      Write-Host "[提示] 上次的运行记录已失效（进程不符或已退出），记录已清理。" -ForegroundColor Yellow
      Remove-Item -LiteralPath $runFile -Force -ErrorAction SilentlyContinue
    }
  }

  $strays = Find-Strays
  if ($strays.Count -gt 0) {
    Write-Host ""
    Write-Host "[发现未登记的实例] 下面这些进程监听本工具端口且命令行含 server.mjs，但没有运行记录（多半是上次非正常关闭）：" -ForegroundColor Yellow
    $strays | ForEach-Object { Write-Host ("           pid {0}  端口 {1}" -f $_.pid, $_.port) }
    Write-Host "           处理方式：再次双击本文件，选 3（停止服务）。脚本会按上述特征识别并清理。"
    exit 1
  }

  $c = Get-NetTCPConnection -LocalPort $portLo -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    $cim = Get-CimOf $c.OwningProcess
    $who = "pid " + $c.OwningProcess
    if ($cim) { $who = "pid " + $c.OwningProcess + " (" + $cim.Name + ")" }
    Write-Host ""
    Write-Host ("[提示] 端口 {0} 已被其他程序占用（{1}），本工具会自动顺延到下一个空闲端口。" -f $portLo, $who) -ForegroundColor Yellow
    Write-Host "       这不是本工具自己的进程，脚本不会去动它。"
  }

  if ($Mode -eq 'lan') {
    Write-Host ""
    Write-Host "[模式] 局域网：同网段的 iPad / 手机可访问（服务会监听 0.0.0.0）。" -ForegroundColor Cyan
  } else {
    Write-Host ""
    Write-Host "[模式] 本机：只监听 127.0.0.1，其他设备访问不到。" -ForegroundColor Cyan
  }
  exit 0
}

# ---------- 状态 ----------
if ($Action -eq 'status') {
  $rec = Read-Record
  if ($rec -and (Test-RecordMatchesProcess $rec)) {
    $up = (New-TimeSpan -Start ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$rec.startedAt).LocalDateTime) -End (Get-Date)).TotalMinutes
    Write-Host "[运行中]" -ForegroundColor Green
    Write-Host ("           进程    pid {0}" -f $rec.pid)
    Write-Host ("           端口    {0}（监听 {1}）" -f $rec.port, $rec.host)
    Write-Host ("           已运行  {0:N1} 分钟" -f $up)
    Show-Addresses $rec
    Write-Host "           关闭   再次双击本文件，选 3"
    exit 0
  }
  if ($rec) {
    Write-Host "[未运行] 记录已失效，正在清理。" -ForegroundColor Yellow
    Remove-Item -LiteralPath $runFile -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "[未运行] 没有找到运行记录。" -ForegroundColor Gray
  }
  $strays = Find-Strays
  if ($strays.Count -gt 0) {
    Write-Host "[注意] 仍有未登记的实例在监听本工具端口：" -ForegroundColor Yellow
    $strays | ForEach-Object { Write-Host ("       pid {0}  端口 {1}" -f $_.pid, $_.port) }
    Write-Host "       选 3（停止服务）可清理。"
    exit 1
  }
  Write-Host ("       端口段 {0}-{1} 当前空闲。" -f $portLo, $portHi)
  exit 0
}

# ---------- 退出清理：只处理记录，绝不动任何进程 ----------
if ($Action -eq 'cleanup') {
  $rec = Read-Record
  if (-not $rec) {
    Write-Host "[清理] 没有遗留的运行记录，终端退出不留痕迹。"
    exit 0
  }
  if (Test-RecordMatchesProcess $rec) {
    Write-Host ("[保留] 服务仍在运行（pid {0}，端口 {1}），记录保留，下次仍可精确管理。" -f $rec.pid, $rec.port) -ForegroundColor Gray
    exit 2
  }
  Remove-Item -LiteralPath $runFile -Force -ErrorAction SilentlyContinue
  Write-Host ("[清理] 已删除失效的运行记录（记录的 pid {0} 早就不在了）" -f $rec.pid) -ForegroundColor Yellow
  exit 0
}
# ---------- 停止 ----------
Write-Host "正在停止 Rollplayer 服务 ..."
$rec = Read-Record
$targets = @()

if ($rec) {
  if (Test-RecordMatchesProcess $rec) {
    $targets += [pscustomobject]@{ pid = [int]$rec.pid; port = [int]$rec.port; host = $rec.host; source = '运行记录' }
  } else {
    Write-Host "[提示] 运行记录与当前进程不符，记录已清理（不会动任何进程）。" -ForegroundColor Yellow
    Remove-Item -LiteralPath $runFile -Force -ErrorAction SilentlyContinue
  }
}

foreach ($s in (Find-Strays)) {
  if (-not ($targets | Where-Object { $_.pid -eq $s.pid })) { $targets += $s }
}

if ($targets.Count -eq 0) {
  Write-Host "[结果] 没有发现本工具的实例，无需停止。" -ForegroundColor Gray
  Write-Host ("       端口段 {0}-{1} 当前空闲。" -f $portLo, $portHi)
  exit 0
}

foreach ($t in $targets) {
  $p = Get-Process -Id $t.pid -ErrorAction SilentlyContinue
  if (-not $p) { Write-Host ("[跳过] pid {0} 已不存在" -f $t.pid) -ForegroundColor Gray; continue }
  try {
    Stop-Process -Id $t.pid -Force -ErrorAction Stop
    Write-Host ("[已停止] pid {0} / 端口 {1}（依据：{2}）" -f $t.pid, $t.port, $t.source) -ForegroundColor Green
  } catch {
    Write-Host ("[失败] pid {0}: {1}" -f $t.pid, $_.Exception.Message) -ForegroundColor Red
  }
}

Start-Sleep -Milliseconds 800

$still = @()
foreach ($port in $portLo..$portHi) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { $still += ("{0}(pid {1})" -f $port, $c.OwningProcess) }
}

if (Test-Path -LiteralPath $runFile) {
  Remove-Item -LiteralPath $runFile -Force -ErrorAction SilentlyContinue
  Write-Host "[清理] 运行记录已删除" -ForegroundColor Gray
}

if ($still.Count -gt 0) {
  Write-Host ("[注意] 端口仍被占用：{0}" -f ($still -join ', ')) -ForegroundColor Red
  exit 1
}
Write-Host ("[完成] 服务已停止，端口段 {0}-{1} 全部空闲" -f $portLo, $portHi) -ForegroundColor Green
exit 0