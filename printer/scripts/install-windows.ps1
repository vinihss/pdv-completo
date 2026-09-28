$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$InstallDir = if ($env:PDV_PRINTER_HOME) { $env:PDV_PRINTER_HOME } else { 'C:\Program Files\PDV Printer' }
$ConfigDir = Join-Path $env:ProgramData 'PDV Printer'
$ServiceName = 'PDVPrinterDaemon'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go 1.22+ é necessário.' }
New-Item -ItemType Directory -Force -Path $InstallDir, $ConfigDir | Out-Null
go build -trimpath -ldflags '-s -w' -o (Join-Path $InstallDir 'pdv-printer-daemon.exe') (Join-Path $Root 'daemon')
Copy-Item (Join-Path $Root 'daemon\templates') (Join-Path $InstallDir 'templates') -Recurse -Force
$config = Join-Path $ConfigDir 'config.json'
if (-not (Test-Path $config)) { Copy-Item (Join-Path $Root 'daemon\config.example.json') $config }

$binary = Join-Path $InstallDir 'pdv-printer-daemon.exe'
sc.exe stop $ServiceName 2>$null | Out-Null
sc.exe delete $ServiceName 2>$null | Out-Null
sc.exe create $ServiceName binPath= "`"$binary`"" start= auto DisplayName= "PDV Printer Daemon" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/10000 | Out-Null
[Environment]::SetEnvironmentVariable('PDV_PRINTER_CONFIG', $config, 'Machine')
sc.exe start $ServiceName | Out-Null
Write-Host "Daemon instalado como $ServiceName. Edite $config e reinicie o serviço."
