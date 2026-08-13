# Start / stop the A2A bridge (LLM-backed A2A server).
# Usage:
#   .\a2a-bridge.ps1 start            # bind 127.0.0.1:<port>
#   .\a2a-bridge.ps1 start -Lan       # bind 0.0.0.0:<port> (cross-network)
#   .\a2a-bridge.ps1 stop
#
# Required environment for the server itself (see bridge/server.mjs):
#   $env:DEEPSEEK_BASE = '<OpenAI-compatible API base URL>'
#   $env:DEEPSEEK_MODEL = '<model id>'   (optional)
#   $env:DEEPSEEK_API_KEY = '<key>'      (optional; falls back to ~/.dsh/.credentials.yaml)
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop')]
  [string]$Action = 'start',
  [switch]$Lan,
  [int]$Port = 4123
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path $MyInvocation.MyCommand.Path -Parent
$server = Join-Path $dir 'server.mjs'
$log = Join-Path $dir 'a2a-bridge.log'

if ($Action -eq 'stop') {
  $p = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
  if ($p) { Stop-Process -Id $p -Force; Write-Host "Stopped A2A bridge on port $Port" }
  else { Write-Host 'A2A bridge not running' }
  exit 0
}

$env:A2A_PORT = [string]$Port
$env:A2A_HOST = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$hostText = if ($Lan) { '0.0.0.0 (LAN, cross-network)' } else { '127.0.0.1 (local)' }

$p = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($p) { Write-Host "Port $Port already in use — bridge may already be running."; exit 1 }

Start-Process -FilePath 'node' -ArgumentList $server -WorkingDirectory $dir `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden
Start-Sleep -Seconds 2
Write-Host "A2A bridge starting on http://$env:A2A_HOST`:$Port (log: $log)"
Write-Host "Agent card: http://$env:A2A_HOST`:$Port/.well-known/agent-card.json"
