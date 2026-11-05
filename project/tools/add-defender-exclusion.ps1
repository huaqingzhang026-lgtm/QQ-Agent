# Add Windows Defender / SmartScreen exclusions for the Xiaohongshu MCP binary.
# MUST be run as Administrator:
#   Right-click this file -> "Run with PowerShell" as admin, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\add-defender-exclusion.ps1
#
# What it does:
#   1. Adds folder exclusions for xhs-mcp and its browser profile to Defender.
#   2. Prints the current SmartScreen ("check apps and files") state so you know
#      whether the "unknown publisher" prompt can still appear.

$ErrorActionPreference = 'Stop'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This script must run as Administrator.' -ForegroundColor Red
  Write-Host 'Right-click -> Run as administrator, or open an elevated PowerShell and run it again.'
  exit 1
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$paths = @(
  (Join-Path $root 'xhs-mcp'),
  (Join-Path $env:LOCALAPPDATA 'xiaohongshu-mcp')
)

foreach ($p in $paths) {
  $resolved = [System.IO.Path]::GetFullPath($p)
  Write-Host "Adding Defender exclusion: $resolved"
  Add-MpPreference -ExclusionPath $resolved
}

Write-Host ''
Write-Host 'Current exclusions:'
(Get-MpPreference).ExclusionPath | ForEach-Object { "  $_" }

Write-Host ''
$smartscreen = $null
try {
  $smartscreen = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellExecuteHooks' -ErrorAction SilentlyContinue
} catch {}
Write-Host 'Note: the "unknown publisher" dialog is SmartScreen (reputation-based), not antivirus.'
Write-Host 'Defender exclusions do NOT always suppress it. If it still appears, either:'
Write-Host '  - click "Run" once, or'
Write-Host '  - Windows Security -> App & browser control -> Reputation-based protection -> turn off "Check apps and files" (system-wide, not recommended).'
