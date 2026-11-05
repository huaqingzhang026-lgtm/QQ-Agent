# Start the local vision helper model (llama.cpp + mmproj) for bridge vision.js.
#
# Usage (after model files are in place):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-vision-server.ps1
#
# Expected files in llm\vision\:
#   * one model gguf, e.g. MiniCPM-V-2_6-Q4_K_M.gguf
#   * one projector gguf, e.g. mmproj-model-f16.gguf
# Listens on 11437; config.socialV2.vision.baseUrl defaults to it.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$llm = Join-Path $root 'llm'
$server = Join-Path $llm 'vulkan\llama-server.exe'
$dir = Join-Path $llm 'vision'
$log = Join-Path $dir 'server.log'

if (-not (Test-Path $server)) { Write-Host "llama-server not found: $server" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$model = Get-ChildItem $dir -Filter '*.gguf' | Where-Object { $_.Name -notmatch 'mmproj' } | Sort-Object Length -Descending | Select-Object -First 1
$mmproj = Get-ChildItem $dir -Filter '*mmproj*.gguf' | Select-Object -First 1
if (-not $model -or -not $mmproj) {
  Write-Host "Put one model gguf and one mmproj gguf into llm\vision" -ForegroundColor Yellow
  exit 2
}

$busy = Get-NetTCPConnection -LocalPort 11437 -State Listen -ErrorAction SilentlyContinue
if ($busy) { Write-Host "port 11437 already listening, skip"; exit 0 }

"[{0}] start {1} + {2}" -f (Get-Date -Format 's'), $model.Name, $mmproj.Name | Add-Content -LiteralPath $log -Encoding utf8
$argsList = @('-m', $model.FullName, '--mmproj', $mmproj.FullName, '--host', '127.0.0.1', '--port', '11437', '-c', '4096', '-ngl', '99', '--jinja')
$p = Start-Process -FilePath $server -ArgumentList $argsList -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
Write-Host ("started pid=" + $p.Id)
