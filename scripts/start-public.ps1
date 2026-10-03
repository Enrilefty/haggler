# Starts Quote Room on this PC plus a Cloudflare quick tunnel (public HTTPS link), both detached
# so they survive the terminal closing. Keeps the PC awake while the server runs.
# The tunnel starts first; the server then starts with PUBLIC_URL = the tunnel's URL (Slack image
# links) and HOST = 127.0.0.1 (only the local tunnel can reach it).
# Usage: powershell -File scripts/start-public.ps1        (fresh start: new tunnel + server)
#        powershell -File scripts/start-public.ps1 -Stop  (stop server, tunnel and keep-awake)
#        powershell -File scripts/start-public.ps1 -RestartServer  (new code, same public link)
param([switch]$Stop, [switch]$RestartServer)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root '.state'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$rec = Join-Path $state 'public.json'

function Stop-Recorded {
  if (Test-Path $rec) {
    $r = Get-Content $rec -Raw | ConvertFrom-Json
    foreach ($id in @($r.server, $r.tunnel, $r.awake)) { if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
    Remove-Item $rec -Force
  }
}
if ($Stop) { Stop-Recorded; 'Stopped.'; exit 0 }
$keep = $null
if ($RestartServer -and (Test-Path $rec)) {
  $keep = Get-Content $rec -Raw | ConvertFrom-Json
  foreach ($id in @($keep.server, $keep.awake)) { if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
  Start-Sleep -Seconds 1
} else { Stop-Recorded }

# 1) Tunnel first: reuse the recorded one on -RestartServer (same URL), else start a new one.
$cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$tlog = Join-Path $state 'tunnel.log'
$url = $null
if ($keep -and $keep.tunnel -and (Get-Process -Id $keep.tunnel -ErrorAction SilentlyContinue)) {
  $tunnel = Get-Process -Id $keep.tunnel
  $url = $keep.url
} else {
  if (Test-Path $tlog) { Remove-Item $tlog -Force }
  $tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:3000', '--no-autoupdate', '--logfile', $tlog) -WindowStyle Hidden -PassThru
}
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $tlog) { $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
}
if (-not $url) { Write-Warning 'No tunnel URL after 30s; starting the server without PUBLIC_URL (Slack photos may not load).' }

# 2) Server: loopback only, told its public origin.
$env:HOST = '127.0.0.1'
if ($url) { $env:PUBLIC_URL = $url }
$node = (Get-Command node.exe).Source
$server = Start-Process -FilePath $node -ArgumentList @('--experimental-strip-types', '--no-warnings', 'src/server.ts') -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $state 'server.log') -RedirectStandardError (Join-Path $state 'server.err.log') -PassThru

# keep the PC from sleeping while the server runs (released when this helper exits)
$awakeCmd = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\""kernel32.dll\"")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(0x80000003) | Out-Null; while (Get-Process -Id $($server.Id) -ErrorAction SilentlyContinue) { Start-Sleep 30 }"
$awake = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $awakeCmd) -WindowStyle Hidden -PassThru

@{ server = $server.Id; tunnel = $tunnel.Id; awake = $awake.Id; url = $url; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content $rec
"server pid $($server.Id) · tunnel pid $($tunnel.Id) · keep-awake pid $($awake.Id)"
"PUBLIC URL: $url"
