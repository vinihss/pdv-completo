# Instalação manual do daemon de impressão (fora do instalador do PDV).
#
# O caminho normal é o instalador do app: ele copia o daemon, cria o serviço e
# mantém os dois na mesma versão. Este script continua existindo para
# instalar/atualizar o daemon sozinho, sem reinstalar o PDV inteiro — é o
# que se usa quando se mexe no daemon durante o desenvolvimento.
#
# build-sidecar.sh gera o mesmo .exe que o instalador embute.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$InstallDir = if ($env:PDV_PRINTER_HOME) { $env:PDV_PRINTER_HOME } else { 'C:\Program Files\PDV Printer' }
$ConfigDir = Join-Path $env:ProgramData 'PDV Printer'
$ServiceName = 'PDVPrinterDaemon'
$binary = Join-Path $InstallDir 'pdv-printer-daemon.exe'

# Recompila em vez de exigir o sidecar pronto: quem roda isto costuma estar
# mexendo no código do daemon. Use o .exe já gerado se só quiser reinstalar.
if (Get-Command go -ErrorAction SilentlyContinue) {
    Write-Host 'Compilando o daemon...'
    Push-Location (Join-Path $Root 'daemon')
    try { go vet ./...; go test ./... } finally { Pop-Location }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Push-Location (Join-Path $Root 'daemon')
    try { go build -trimpath -ldflags '-s -w' -o $binary . } finally { Pop-Location }
} elseif (-not (Test-Path $binary)) {
    throw "Sem Go para recompilar e sem daemon em $binary. Rode build-sidecar.sh antes."
}

# O config é criado pelo próprio daemon no primeiro start; o diretório é que
# precisa existir e ficar gravável (o serviço roda como LocalSystem).
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# Para e remove antes de recriar: o mesmo caminho do instalador, para que os
# dois ambientes não diverjam. sc delete responde 1060/1072 se não houver
# serviço, o que não é erro aqui.
sc.exe stop $ServiceName 2>$null | Out-Null
Start-Sleep -Milliseconds 1500
sc.exe delete $ServiceName 2>$null | Out-Null

sc.exe create $ServiceName binPath= "`"$binary`"" start= auto DisplayName= "PDV Impressora" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/10000 | Out-Null
sc.exe start $ServiceName | Out-Null

$config = Join-Path $ConfigDir 'config.json'
if (Test-Path $config) {
    Write-Host "Daemon instalado e iniciado. Config existente preservado em $config"
} else {
    Write-Host "Daemon instalado e iniciado. Ajuste o IP da impressora em $config e reinicie o serviço."
}
