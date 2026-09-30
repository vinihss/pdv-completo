#!/usr/bin/env bash
# ============================================================
# Gera o PACOTE DE INSTALAÇÃO AVULSO do daemon de impressão para
# Windows. Rodar à mão, sem CI:
#
#   bash printer/scripts/package-daemon-windows.sh
#
# Sai um zip em printer/dist/ com tudo o que o técnico precisa:
#
#   pdv-printer-daemon-<versao>-windows-x86_64/
#     pdv-printer-daemon.exe        o serviço (Go, sem dependência)
#     pdv-printer-daemon.exe.sha256  conferência de integridade
#     install-windows.ps1            instala e registra o serviço
#     config.example.json            referência de configuração
#     LEIA-ME.md                     o passo a passo do técnico
#
# Para que serve: a loja que NÃO instala o app desktop e abre o PDV
# no navegador (PWA) precisa de um jeito de instalar só o daemon. O
# caminho normal — o instalador do app, que embute o daemon como
# sidecar e o registra como serviço — está em
# frontend/src-tauri/installer-hooks.nsh e não é tocado por aqui.
#
# Limitação que define o uso: o daemon serve a máquina onde o
# navegador roda (o PDV procura a impressora em 127.0.0.1:8080 e o
# daemon escuta só no endereço local). Impressora em OUTRA máquina
# do salão não funciona sem mudar essa configuração.
#
# Diferenças em relação ao instalador do app, que são intencionais:
#
#   * aqui o técnico roda UM script; lá o instalador faz isso sozinho;
#   * o binPath do serviço e a pasta de config sao os mesmos
#     (o daemon acha o config em %ProgramData%\PDV Printer
#     sem precisar de argumento);
#   * o app é que reinstala o daemon a cada atualização dele. Um
#     pacote avulso nao tem essa mao: para atualizar, baixa o zip
#     novo e roda o install-windows.ps1 de novo (ele e idempotente,
#     para o servico antes de copiar).
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_DIR="$ROOT/printer/daemon"
SCRIPTS_DIR="$ROOT/printer/scripts"
CONF="$ROOT/frontend/src-tauri/tauri.conf.json"
PKG_JSON="$ROOT/frontend/package.json"
DIST="$ROOT/printer/dist"

EXE_NAME="pdv-printer-daemon.exe"

die() { echo "ERRO: $*" >&2; exit 1; }

command -v go   >/dev/null 2>&1 || die "Go 1.22+ e necessario para cross-compilar o daemon."
command -v zip  >/dev/null 2>&1 || die "zip e necessario para fechar o pacote."
command -v jq   >/dev/null 2>&1 || die "jq e necessario para ler a versao do tauri.conf.json."

# ---------- 1. Versao ----------
[ -f "$CONF" ] || die "nao achei $CONF"
VERSION="$(jq -r '.version // empty' "$CONF")"
[ -n "$VERSION" ] || die "tauri.conf.json sem campo 'version'"

# A versao do pacote e a do app de proposito: o daemon avulso e
# entregue na mesma batida da versão do instalador, entao o técnico
# nao precisa saber qual numero pertence a qual peca.
#
# O aviso abaixo nao falha o script: o daemon nao depende do build do
# app. Ele existe porque hoje os dois estao divergentes (conf 1.0.9,
# package.json 1.0.2) e o build-app.sh / o job do CI exigem
# igualdade — ou seja, o INSTALADOR do app esta com o build quebrado
# enquanto este pacote sai normal.
if [ -f "$PKG_JSON" ]; then
  PKG_VERSION="$(jq -r '.version // empty' "$PKG_JSON")"
  if [ -n "$PKG_VERSION" ] && [ "$PKG_VERSION" != "$VERSION" ]; then
    echo "AVISO: tauri.conf.json=$VERSION e frontend/package.json=$PKG_VERSION divergem."
    echo "       Isso quebra o build do APP (build-app.sh exige igualdade), nao este pacote."
  fi
fi

PKG_NAME="pdv-printer-daemon-${VERSION}-windows-x86_64"
PKG_DIR="$DIST/$PKG_NAME"

# ---------- 2. Testes antes de empacotar ----------
# Um pacote com o teste vermelho nao serve para nada: o cliente nao
# tem como saber que o daemon esta quebrado, e a impressora e a
# ultima coisa que se percebe depois de instalar em sete lojas.
echo "==> go vet"
(cd "$DAEMON_DIR" && go vet ./...)
echo "==> go test"
(cd "$DAEMON_DIR" && go test ./...)

# ---------- 3. Compilar o .exe ----------
# Cross-compila direto para o nome final em vez de chamar o
# build-sidecar.sh: aquele compila tambem linux e darwin e faz
# "rm -f" nos sidecars da arvore do Tauri (que sao gitignored e
# servem ao build do app). Roda-lo aqui derrubaria o build do app
# de quem so queria o pacote do daemon.
echo "==> compilando windows/amd64 (CGO off: o daemon e Go puro)"
rm -rf -- "$PKG_DIR"
mkdir -p "$PKG_DIR"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build \
  -C "$DAEMON_DIR" -trimpath -ldflags "-s -w" -o "$PKG_DIR/$EXE_NAME" .

# ---------- 4. Integridade ----------
# O install-windows.ps1 confere este arquivo antes de instalar e
# aborta se o download veio corrompido. Formato do sha256sum: o
# hash, depois o nome do arquivo — o PowerShell le o primeiro token.
echo "==> sha256"
(cd "$PKG_DIR" && sha256sum "$EXE_NAME" > "$EXE_NAME.sha256")

# ---------- 5. Acompanhantes ----------
cp "$SCRIPTS_DIR/install-windows.ps1" "$PKG_DIR/install-windows.ps1"
cp "$DAEMON_DIR/config.example.json"  "$PKG_DIR/config.example.json"

# O .cmd entra com CRLF. Arquivo de lote com LF-only quebra em label/goto
# e em bloco parenthesado de forma que só aparece na máquina do cliente —
# aqui, na revisão, o arquivo parece normal. Por isso a conversão é
# explícita e o arquivo do repo fica em LF.
sed 's/\r$//; s/$/\r/' "$SCRIPTS_DIR/install-daemon.cmd" > "$PKG_DIR/INSTALAR.cmd"

cat > "$PKG_DIR/LEIA-ME.md" <<EOF
# Daemon de impressão do PDV — $VERSION

Impressora térmica (Elgin MP-4200) para o PDV, **sem o aplicativo
desktop**. Serve para a loja que abre o PDV no navegador (PWA) e
quer imprimir na bobina da cozinha.

O daemon é um serviço do Windows: ele sobe com a máquina, sem
depender de o navegador estar aberto, e guarda a fila de impressão
em disco.

**O daemon roda na mesma máquina que o navegador.** O PDV procura a
impressora em 127.0.0.1:8080 e o daemon escuta só no endereço
local, então uma impressora (ou um navegador) em outra máquina do
salão não é atendida por esta instalação.

## Antes de começar

- Windows 10 ou 11;
- a MP-4200 ligada na rede. O padrão é cabo de rede com IP
  reservado no roteador; a porta da impressora é a 9100.

## Instalação

1. Descompacte este zip em uma pasta (por exemplo
   \`C:\PDV\`).
2. Clique com o **botão direito** no arquivo \`INSTALAR.cmd\` e
   escolha **Executar como administrador**. O Windows pergunta se é
   para permitir — responda sim.
3. Digite o IP da impressora quando o programa pedir (pode deixar
   em branco para usar \`192.168.1.50:9100\`, ou digitar \`pular\` e
   configurar depois).

Pronto. A janela fica aberta com o resultado da instalação.

**Não é possível executar o \`.exe\` direto**, e vale saber por quê:
ele funciona, mas roda em primeiro plano — morre quando o técnico
fecha o terminal e não volta quando a máquina reinicia. O serviço é
o que faz a cozinha imprimir com o app fechado, que é o motivo de
ele existir.

Se preferir o terminal, ou se for instalar em outra loja sem
double-click, o comando é o mesmo:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -PrinterAddress kitchen=192.168.1.50:9100

## O que foi instalado

- o executável em \`C:\Program Files\PDV\printer\`;
- o serviço \`PDVPrinterDaemon\` (início automático, reinicia se
  cair, parado antes de cada troca de arquivo);
- a configuração em \`%ProgramData%\PDV Printer\config.json\`.

## Conferir se funcionou

    Invoke-RestMethod http://127.0.0.1:8080/health

    status       ok
    ready        True
    printers     kitchen

\`ready\` é a resposta que importa: o daemon estar no ar não
significa impressora configurada. Enquanto \`ready\` for False, o
destino não tem endereço e nenhuma bobina sai.

Para ver o estado da impressora (papel, tampa, erro):

    Invoke-RestMethod "http://127.0.0.1:8080/api/printers/status?destination=kitchen"

Para abrir o PDV e imprimir um cupom de teste, ligue
Configurações → Impressão local (daemon).

## Se a impressora não imprimir

1. \`Invoke-RestMethod http://127.0.0.1:8080/health\` — se
   \`ready\` for False, falta endereço.
2. Falta endereço? Abra \`%ProgramData%\PDV Printer\config.json\`,
   preencha \`printers.kitchen.address\` (as três entradas —
   \`kitchen\`, \`courier\` e \`fiscal\` — vêm sem endereço de
   propósito) e rode:

       Restart-Service PDVPrinterDaemon

3. \`ready\` True e mesmo assim não sai? Confira se o
   \`/api/printers/status\` diz \`reachable\`. Impressora em outra
   rede, ou o IP trocou no DHCP, são as causas comuns.
4. O navegador recusa a conexão e a tela diz "Não foi possível
   falar com a impressora": o \`allowed_origins\` do config precisa
   conter o site de onde o PDV foi aberto. O script de instalação
   já escreve o endereço padrão; se a loja acessa o PDV por outro
   endereço, acrescente a origem lá e rode \`Restart-Service\`.

## Impressão automática

A opção "imprimir automaticamente ao abrir a comanda" **não
funciona** quando o sistema está na nuvem: quem dispara esse
impressionismo é o servidor, e ele não alcança a impressora da
loja. Deixe desligada e use o botão de imprimir.

## Atualizar

Baixe o zip novo e rode o \`INSTALAR.cmd\` de novo (ou o
\`install-windows.ps1\`). O serviço é parado antes de o arquivo ser
trocado, então dá para repetir sem risco. A configuração e a fila de
impressão ficam intactas.

## O que fica no computador

    C:\Program Files\PDV\printer\       o executável do serviço
    %ProgramData%\PDV Printer\config.json   endereços das impressoras
    %ProgramData%\PDV Printer\data\         fila de impressão
    %ProgramData%\PDV Printer\templates\    layouts customizados (opcional)

Nada disso é apagado ao reinstalar o script.
EOF

# ---------- 6. Fechar ----------
ZIP_PATH="$DIST/$PKG_NAME.zip"
rm -f -- "$ZIP_PATH"
# zip a partir do DIST: é o que faz a pasta do pacote aparecer
# dentro do zip, em vez de os arquivos caírem soltos na pasta em
# que o técnico descompactou.
(cd "$DIST" && zip -qr "$ZIP_PATH" "$PKG_NAME")

echo
echo "==> Pacote em $DIST"
find "$PKG_DIR" -type f | sort | while read -r f; do
  printf '    %-34s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
echo
echo "    $(basename "$ZIP_PATH")  ($(du -h "$ZIP_PATH" | cut -f1))"
echo "    sha256: $(sha256sum "$ZIP_PATH" | cut -d' ' -f1)"
echo
echo "No Windows: descompactar, botao direito em INSTALAR.cmd >"
echo "Executar como administrador, e digitar o IP da impressora."
