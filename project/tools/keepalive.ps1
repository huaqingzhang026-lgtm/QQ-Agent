# Keep-alive for her home (HerWatchdog, every 5 minutes).
# Reads tools/readiness.mjs output and restarts only unhealthy services,
# with per-task cooldown and hourly restart cap. ASCII only.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'keepalive.log'
$stateFile = Join-Path $root 'keepalive-state.json'
$node = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$readiness = Join-Path $root 'readiness.mjs'

function Write-Log([string]$msg) {
  Add-Content -LiteralPath $log -Encoding utf8 -Value ("[{0}] {1}" -f (Get-Date -Format 's'), $msg)
}

$state = @{ lastRestart = @{}; restartsLastHour = @{} }
if (Test-Path -LiteralPath $stateFile) {
  try {
    $loaded = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($loaded.lastRestart) { $state.lastRestart = $loaded.lastRestart }
    if ($loaded.restartsLastHour) { $state.restartsLastHour = $loaded.restartsLastHour }
  } catch {}
}

# 这些任务不做自动重启（例如需要人工处理 SmartScreen/登录的任务）
$skipTasks = @()
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$cooldownMs = 600000
$optionalCooldownMs = 1800000
$hourMs = 3600000
$maxPerHour = 3

function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

# 1) readiness probe
$json = $null
try {
  $raw = & $node $readiness --json 2>$null
  $json = ($raw | Out-String) | ConvertFrom-Json
} catch {
  Write-Log 'readiness probe failed to run'
}

if ($json) {
  if ($json.ok -eq $true -and @($json.checks | Where-Object { $_.ok -eq $false }).Count -gt 0) {
    $bad = @($json.checks | Where-Object { $_.ok -eq $false } | ForEach-Object { $_.name }) -join ","
    Write-Log ("degraded: {0}" -f $bad)
  }
  foreach ($c in @($json.checks)) {
    if ($c.ok -ne $false) { continue }
    $task = [string]$c.task
    if (-not $task) { continue }
    if ($skipTasks -contains $task) { Write-Log ("skip {0}: in skipTasks ({1})" -f $task, $c.name); continue }

    # QQ not logged in: restarting SnowLuma does not help; alert only.
    if ($c.name -eq 'qq-login' -and $c.detail -notmatch 'unreachable') {
      Write-Log ("ALERT qq not logged in ({0}) - manual login required" -f $c.detail)
      continue
    }

    $lastVal = Get-Prop $state.lastRestart $task; $last = 0; if ($null -ne $lastVal) { [void][int64]::TryParse([string]$lastVal, [ref]$last) }
    $countVal = Get-Prop $state.restartsLastHour $task; $count = 0; if ($null -ne $countVal) { [void][int]::TryParse([string]$countVal, [ref]$count) }
    $isOptional = ($c.required -eq $false)
    $cd = $cooldownMs
    if ($isOptional) { $cd = $optionalCooldownMs }
    if (($now - $last) -lt $cd) {
      Write-Log ("skip {0}: cooldown ({1})" -f $task, $c.name)
      continue
    }
    $cap = $maxPerHour
    if ($isOptional) { $cap = 1 }
    if ($count -ge $cap) {
      Write-Log ("skip {0}: hourly cap reached ({1})" -f $task, $c.name)
      continue
    }
    & schtasks /Run /TN $task 2>&1 | Out-Null
    Write-Log ("restart {0} ({1}: {2})" -f $task, $c.name, $c.detail)
    $state.lastRestart | Add-Member -NotePropertyName $task -NotePropertyValue $now -Force
    $state.restartsLastHour | Add-Member -NotePropertyName $task -NotePropertyValue ($count + 1) -Force
  }
} else {
  Write-Log 'no readiness result'
}

# 2) heartbeat process (not port based)
$hb = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'life-loop' }
if (-not $hb) {
  & schtasks /Run /TN 'HerHeartbeat' 2>&1 | Out-Null
  Write-Log 'restart HerHeartbeat (process missing)'
}

# 3) decay hourly counters
$props = @($state.restartsLastHour.PSObject.Properties)
foreach ($p in $props) {
  $lastVal2 = Get-Prop $state.lastRestart $p.Name; $last2 = 0; if ($null -ne $lastVal2) { [void][int64]::TryParse([string]$lastVal2, [ref]$last2) }
  if (($now - $last2) -gt $hourMs) {
    $state.restartsLastHour | Add-Member -NotePropertyName $p.Name -NotePropertyValue 0 -Force
  }
}

try {
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding utf8
} catch {}
