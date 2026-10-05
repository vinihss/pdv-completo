# Instalação do daemon de impressão do PDV como serviço do Windows.
#
# Dois usos:
#
#   1. Cliente que NÃO tem o app desktop (PWA no navegador): baixe o
#      zip gerado por printer/scripts/package-daemon-windows.sh,
#      descompacte e rode este script. Ele instala o .exe que está AO
#      LADO dele — Go não é preciso na máquina. O daemon atende a
#      máquina onde o navegador roda, que é como o PDV o procura.
#
#   2. Quem está mexendo no daemon durante o desenvolvimento: com Go
#      na máquina, o script recompila a partir de printer/daemon se
#      não achar um .exe ao lado de si mesmo.
#
# O caminho normal do PDV é outro: o instalador do app embute o
# daemon como sidecar e o registra sozinho (ver
# frontend/src-tauri/installer-hooks.nsh). Os dois converge para o
# mesmo serviço (PDVPrinterDaemon) e para a mesma configuração
# (%ProgramData%\PDV Printer\config.json), então é o mesmo daemon
# rodando — muda quem executa a instalação.
#
# Idempotente: pode rodar várias vezes. Para o serviço antes de
# copiar o .exe, porque um executável em uso não pode ser
# sobrescrito.
param(
    # Caminho do .exe a instalar. Sem isso, usa o que está na mesma
    # pasta do script; sem nenhum dos dois, compila com Go.
    [string]$Binary,

    # Onde o executável do serviço fica. O mesmo caminho do
    # instalador do app (C:\Program Files\PDV\printer) de propósito:
    # se a loja instalar o pacote avulso e depois o app, o serviço
    # aponta para o mesmo lugar e não sobra binário órfão.
    # PDV_PRINTER_HOME continua valendo como fallback.
    [string]$InstallDir,

    # Origem do PDV que o navegador vai usar para falar com o daemon.
    # Sem esta origem em allowed_origins o daemon sobe, o /health
    # responde "ok" e a impressão não sai: o navegador bloqueia a
    # resposta por CORS e o erro na tela é genérico.
    [string]$PwaOrigin = 'https://app.umamisushiarte.com.br',

    # Endereço de escuta. Loopback é o certo (o daemon é da máquina);
    # mudar exige liberar a porta no firewall e não é o caso padrão.
    [string]$Listen = '127.0.0.1:8080',

    # Endereços das impressoras, no formato destino=host:porta:
    #   -PrinterAddress kitchen=192.168.1.50:9100
    # Aceita vários: -PrinterAddress kitchen=1.2.3.4:9100,courier=1.2.3.4:9100
    # Sem isto, a impressão só passa a funcionar depois de editar o
    # config na mão.
    [string[]]$PrinterAddress = @(),

    # Token da API local (Authorization: Bearer ...). Sem este parâmetro o
    # script gera um aleatório e grava no config. Sem token, qualquer
    # programa da máquina consegue mandar imprimir.
    [string]$ApiToken = '',

    # Não configura token (só para migrar uma loja cujo PDV ainda não envia
    # o cabeçalho Authorization). Não recomendado.
    [switch]$NoApiToken,

    # Imprime o que faria, sem executar nada. Para conferir o script
    # antes de mexer no serviço de uma máquina em produção.
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'PDVPrinterDaemon'
$ServiceDisplayName = 'PDV Impressora'
$ExeName = 'pdv-printer-daemon.exe'

# O sc.exe e o %ProgramData% só existem no Windows. Em dry-run o
# sc.exe nunca é chamado, e resolver o caminho aqui quebraria o
# Join-Path numa máquina não-Windows — o que impediria de rodar
# `./install-windows.ps1 -DryRun` no Linux/macOS, que é a única
# forma de o script ser validado fora de um Windows (ver
# docs/11-desktop-instalador.md §9.2: nada disso aqui foi provado
# num Windows de verdade ainda).
$ScExe = if ($DryRun) { 'sc.exe' } else { Join-Path $env:SystemRoot 'System32\sc.exe' }
$ConfigDir = if ($DryRun -and -not $env:ProgramData) {
    Join-Path ([System.IO.Path]::GetTempPath()) 'PDV Printer'
} else {
    Join-Path $env:ProgramData 'PDV Printer'
}
$ConfigPath = Join-Path $ConfigDir 'config.json'

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Root = Split-Path -Parent $ScriptDir   # raiz da distribuição estruturada

function Write-Step($msg) { Write-Host "==> $msg" }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "ERRO: $msg" -ForegroundColor Red }

# Roda o sc.exe com a linha de comando montada como um texto só.
#
# Não dá para passar o binPath como argumento separado do PowerShell:
# o caminho tem espaço (C:\Program Files\...), o PowerShell embrulha
# o argumento em aspas, o sc.exe re-faz o parse da linha e sobra
# aspa dentro do binPath — serviço que não sobe, com mensagem
# críptica. Start-Process junta o ArgumentList com espaços, sem
# escapar nada, que é exatamente o que o sc.exe espera.
function Invoke-Sc([string[]]$Line) {
    if ($DryRun) {
        Write-Host "    [dry-run] sc.exe $($Line -join ' ')" -ForegroundColor DarkGray
        return 0
    }
    $proc = Start-Process -FilePath $ScExe -ArgumentList $Line -NoNewWindow -Wait -PassThru
    return $proc.ExitCode
}

# ------------------------------------------------------------------
# 1. Qual binário instalar
# ------------------------------------------------------------------
function Resolve-SourceBinary {
    if ($Binary) {
        if (-not (Test-Path $Binary)) { throw "O caminho informado em -Binary não existe: $Binary" }
        return (Resolve-Path $Binary).Path
    }

    $aoLado = Join-Path $ScriptDir $ExeName
    if (Test-Path $aoLado) { return $aoLado }

    # Dev sem pacote: compila, com o mesmo portão de teste que o
    # build-sidecar.sh usa.
    if (Get-Command go -ErrorAction SilentlyContinue) {
        Write-Step 'Nenhum .exe ao lado do script; compilando com Go (modo dev)'
        Push-Location (Join-Path $Root 'daemon')
        try {
            go vet ./...
            go test ./...
        } finally { Pop-Location }
        $saida = Join-Path $ScriptDir $ExeName
        Push-Location (Join-Path $Root 'daemon')
        try { go build -trimpath -ldflags '-s -w' -o $saida . } finally { Pop-Location }
        return $saida
    }

    throw @"
Não encontrei o daemon para instalar.

Procurei um arquivo chamado $ExeName na pasta deste script ($ScriptDir) e não achei, e também não há Go na máquina para compilar.

O esperado é rodar o install-windows.ps1 de dentro do zip gerado por printer/scripts/package-daemon-windows.sh — o .exe vem junto. Se você está aqui de propósito, baixe o pacote de novo.
"@
}

Write-Step 'Daemon de impressão do PDV'
$source = Resolve-SourceBinary
Write-Ok "binário: $source"

# ------------------------------------------------------------------
# 2. Integridade
# ------------------------------------------------------------------
# O pacote traz o .sha256 ao lado do .exe (sha256sum). Divergência
# aborta aqui: instalar um .exe corrompido produz um serviço que
# sobe e não imprime, que é o tipo de problema que só aparece no
# caixa, com a fila de pedidos já acumulada.
$shaPath = "$source.sha256"
if (Test-Path $shaPath) {
    $esperado = ((Get-Content $shaPath -Raw) -split '\s+')[0].Trim()
    $obtido = (Get-FileHash -Path $source -Algorithm SHA256).Hash
    if ($obtido -ne $esperado) {
        Write-Err "SHA256 diverge do .sha256 do pacote.`n  esperado $esperado`n  obtido   $obtido"
        throw 'Download corrompido. Baixe o pacote de novo e não instale esse arquivo.'
    }
    Write-Ok 'SHA256 conferido com o .sha256 do pacote'
} else {
    Write-Warn2 'sem .sha256 ao lado do .exe: conferência de integridade pulada'
}

if (-not $InstallDir) {
    if ($env:PDV_PRINTER_HOME) { $InstallDir = $env:PDV_PRINTER_HOME }
    else { $InstallDir = 'C:\Program Files\PDV\printer' }
}
# Mesmo caso do sc.exe: fora do Windows não existe a unidade C: e o
# Join-Path aborta. No dry-run interessa é o caminho impresso, não
# um path resolvido.
$target = try { Join-Path $InstallDir $ExeName } catch { "$InstallDir\$ExeName" }

# ------------------------------------------------------------------
# 3. Parar o serviço antes de copiar
# ------------------------------------------------------------------
Write-Step 'Parando o serviço anterior (se existir)'
# 1060 (não existe) e 1062 (já parado) não são erro aqui: significam
# que não havia serviço em pé, que é o caso da primeira instalação.
# O sc.exe avisa isso na stderr; por isso ele roda por Start-Process
# (que não joga stderr no error stream do PowerShell) e não por
# chamada direta — com $ErrorActionPreference = 'Stop', stderr de um
# comando nativo vira erro terminais no PowerShell 7.
$codigoStop = Invoke-Sc @('stop', $ServiceName)
if ($codigoStop -eq 0 -and -not $DryRun) { Start-Sleep -Milliseconds 1500 }
Invoke-Sc @('delete', $ServiceName) | Out-Null

# ------------------------------------------------------------------
# 4. Copiar e registrar
# ------------------------------------------------------------------
Write-Step "Instalando em $InstallDir"
if ($DryRun) {
    Write-Host "    [dry-run] copiar $source -> $target" -ForegroundColor DarkGray
} else {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Path $source -Destination $target -Force
    Write-Ok $target
}

Write-Step "Registrando o serviço $ServiceName"
# Logo após um stop/delete o SCM pode responder "marked for deletion"
# por algumas centenas de ms e recusar o create. Repetir resolve, e é
# o mesmo retry que o installer-hooks.nsh faz — os dois ambientes
# não podem divergir no que o cliente vê.
$codigo = 1
for ($tentativa = 1; $tentativa -le 10; $tentativa++) {
    $codigo = Invoke-Sc @(
        'create', $ServiceName,
        "binPath= `"$target`"",
        'start= auto',
        "DisplayName= `"$ServiceDisplayName`""
    )
    if ($codigo -eq 0) { break }
    if (-not $DryRun) { Start-Sleep -Seconds 1 }
}
if ($codigo -ne 0) {
    throw "sc.exe create devolveu $codigo. A pasta $InstallDir é gravável? O PowerShell está como Administrador?"
}
Write-Ok 'serviço registrado (início automático)'

Invoke-Sc @('failure', $ServiceName, 'reset=', '86400',
            'actions=', 'restart/5000/restart/5000/restart/10000') | Out-Null

# ------------------------------------------------------------------
# 5. Configuração
# ------------------------------------------------------------------
# Só escreve se não existir. A configuração de uma loja em produção
# tem o IP das impressoras que alguém preencheu; sobrescrever aqui
# apagaria a impressora de um salão que só está trocando de
# versão — e é o mesmo motivo de o instalador do app não tocar em
# %ProgramData%.
#
# data_dir e templates_dir ficam de fora de propósito: vazios, o
# daemon resolve os dois a partir da pasta do próprio config
# (main.go: resolveDir com baseDir), que é o que mantém a fila em
# %ProgramData% em vez de C:\Windows\System32\data — o CWD de um
# serviço. Pasta de templates inexistente é tolerada.
Write-Step "Configuração em $ConfigPath"
if (Test-Path $ConfigPath) {
    Write-Ok 'já existe; preservada (é a da loja)'
} elseif ($DryRun) {
    Write-Host "    [dry-run] escreveria o config com allowed_origins=$PwaOrigin" -ForegroundColor DarkGray
} else {
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

    $printers = [ordered]@{
        kitchen = [ordered]@{ address = ''; template = 'kitchen-default'; status = $true }
        courier = [ordered]@{ address = ''; template = 'courier-default'; status = $true }
        fiscal  = [ordered]@{ address = ''; template = 'fiscal-default';  status = $true }
    }
    foreach ($par in $PrinterAddress) {
        if ($par -notmatch '^\s*([^=]+)=(.+?)\s*$') {
            throw "Formato inválido em -PrinterAddress: '$par'. Use destino=host:porta (ex.: kitchen=192.168.1.50:9100)"
        }
        $destino = $Matches[1].Trim()
        $endereco = $Matches[2].Trim()
        if (-not $printers.Contains($destino)) { $printers[$destino] = [ordered]@{ address = ''; template = "$destino-default"; status = $true } }
        $printers[$destino].address = $endereco
        Write-Ok "$destino -> $endereco"
    }

    $cfg = [ordered]@{
        listen          = $Listen
        allowed_origins = @($PwaOrigin)
        retry           = [ordered]@{
            max_attempts          = 8
            base_delay_seconds    = 2
            max_delay_seconds     = 120
            poll_interval_seconds = 2
        }
        printers        = $printers
    }

    # Token da API local: fornecido por -ApiToken ou gerado aqui (256 bits).
    if (-not $NoApiToken) {
        if (-not $ApiToken) {
            $bytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $rng.GetBytes($bytes)
            $rng.Dispose()
            $ApiToken = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        }
        $cfg['api_token'] = $ApiToken
        $tokenGerado = $true
    }

    $json = ($cfg | ConvertTo-Json -Depth 6)
    # UTF-8 SEM BOM, deliberadamente: o Set-Content do PowerShell 5.1
    # grava BOM, e o json.Unmarshal do Go rejeita arquivo com BOM no
    # início — o daemon não subiria logo após a instalação, sem
    # mensagem útil.
    [System.IO.File]::WriteAllText($ConfigPath, "$json`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok $ConfigPath
    if ($tokenGerado) {
        Write-Warn2 'api_token gravado no config. O PDV precisa enviar:  Authorization: Bearer <api_token>'
        Write-Warn2 "(o valor está em $ConfigPath, campo api_token; copie para a configuração do PDV)"
    } else {
        Write-Warn2 'instalado SEM api_token: qualquer programa desta máquina pode imprimir.'
    }
}

# ------------------------------------------------------------------
# 6. Iniciar e conferir
# ------------------------------------------------------------------
Write-Step 'Iniciando o serviço'
$codigo = Invoke-Sc @('start', $ServiceName)
if ($codigo -ne 0) {
    Write-Warn2 "o serviço foi registrado mas não iniciou (sc.exe = $codigo). Veja o log em Event Viewer > Aplicativos."
}

if ($DryRun) {
    Write-Host ''
    Write-Host 'dry-run: nada foi instalado.' -ForegroundColor Cyan
    exit 0
}

Start-Sleep -Seconds 1

# /health responde 200 com status ok mesmo sem nenhuma impressora
# configurada: "no ar" e "pronto para imprimir" são estados
# diferentes, e ready é o que diz a diferença. Por isso o relatório
# final em vez de um "instalado com sucesso" solto.
$escuta = $Listen
if (Test-Path $ConfigPath) {
    try { $escuta = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).listen } catch { }
}
if ([string]::IsNullOrWhiteSpace($escuta)) { $escuta = $Listen }
# Escuta em "todos os interfaces" não serve para conferir por
# health check (o 0.0.0.0 não é um destino de request). Só a parte do
# host é trocada, para a porta ir junto.
$host_escuta = ($escuta -split ':')[0]
if ($host_escuta -in @('0.0.0.0', '[::]', '::', '*', '')) {
    $escuta = '127.0.0.1' + $escuta.Substring($host_escuta.Length)
}
$url = "http://$escuta/health"

Write-Host ''
Write-Step 'Conferindo o daemon'
try {
    $saude = Invoke-RestMethod -Uri $url -TimeoutSec 5
} catch {
    Write-Warn2 "não respondi em $url ($($_.Exception.Message))."
    Write-Warn2 'O serviço pode estar indo ainda. Teste de novo em alguns segundos:'
    Write-Host "       Invoke-RestMethod $url" -ForegroundColor DarkGray
    exit 0
}

Write-Ok "$url -> status=$($saude.status) templates=$($saude.templates) fila=$($saude.queue_depth)"

if ($saude.ready) {
    Write-Ok "pronto para imprimir: $($saude.printers -join ', ')"
    Write-Host ''
    Write-Host 'Instalado.' -ForegroundColor Green
    Write-Host "Confira a impressora:  Invoke-RestMethod `"http://$escuta/api/printers/status?destination=kitchen`""
    Write-Host "Config da loja:       $ConfigPath"
    exit 0
}

# ready=false: o daemon está no ar, mas nenhum destino tem endereço.
# Diz exatamente quais — é o único jeito de o técnico não ficar
# caçando o arquivo de configuração no disco.
Write-Warn2 "sem impressora configurada (ready=false). Preencha o endereço em ${ConfigPath}:"
try {
    $cfgLido = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    foreach ($p in $cfgLido.printers.PSObject.Properties) {
        if ([string]::IsNullOrWhiteSpace($p.Value.address)) { Write-Host "       printers.$($p.Name).address  =  `"<ip-da-impressora>:9100`"" }
    }
} catch { }
Write-Host ''
Write-Host "Depois:  Restart-Service $ServiceName" -ForegroundColor DarkGray
Write-Host "         Invoke-RestMethod `"$url`"" -ForegroundColor DarkGray
Write-Host "Ou rode de novo:  .\install-windows.ps1 -PrinterAddress kitchen=<ip>:9100" -ForegroundColor DarkGray
exit 0
