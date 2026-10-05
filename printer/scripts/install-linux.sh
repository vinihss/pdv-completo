#!/usr/bin/env bash
# printer/scripts/install-linux.sh
#
# Instala o daemon de impressão (systemd) a partir do pacote extraído em
# /opt/pdv-printer:
#
#   sudo /opt/pdv-printer/scripts/install-linux.sh
#
# O pacote traz o binário JÁ COMPILADO em daemon/pdv-printer-daemon, que é o
# caminho normal: a máquina da loja não tem Go e não deve precisar dele. Go só
# é exigido no fallback, quando não há binário pronto (árvore de dev), que é a
# mesma ordem de decisão do install-windows.ps1 (Resolve-SourceBinary).
#
# Opções:
#   -n, --dry-run   mostra o que faria sem instalar nada (não precisa de root
#                   para conferir binário e caminhos)
#   --binary PATH   instala este binário em vez do que veio no pacote
#   -h, --help      esta ajuda
#
# Overridable por ambiente (o mesmo que já existia): PREFIX, CONFIG_DIR,
# SERVICE_USER e SYSTEMD_UNIT_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/opt/pdv-printer}"
CONFIG_DIR="${CONFIG_DIR:-/etc/pdv-printer}"
SERVICE_USER="${SERVICE_USER:-pdv-printer}"
# Onde entra a unit. Não precisa ser mudado numa loja — existe para o harness
# de teste não escrever em /etc.
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
UNIT_NAME="pdv-printer.service"
BIN_NAME="pdv-printer-daemon"

DRY_RUN=0
BINARIO=""

step() { echo "==> $*"; }
ok() { echo "    $*"; }
aviso() { echo "    AVISO: $*" >&2; }
erro() { echo "ERRO: $*" >&2; }

usage() {
  cat <<'USO'
uso: install-linux.sh [-n|--dry-run] [--binary PATH] [-h|--help]

  -n, --dry-run   imprime o que faria, sem criar usuário, copiar arquivo,
                  escrever a unit nem tocar no systemd
  --binary PATH   usa este binário em vez de daemon/pdv-printer-daemon
  -h, --help      esta ajuda

Variáveis de ambiente: PREFIX, CONFIG_DIR, SERVICE_USER, SYSTEMD_UNIT_DIR.
USO
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --binary)
      [[ $# -ge 2 ]] || { erro "--binary exige um caminho."; exit 2; }
      BINARIO="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) erro "opção desconhecida: $1 (veja --help)"; exit 2 ;;
  esac
done

# Em dry-run nada é escrito, então exigir root aqui só impediria o técnico de
# conferir o pacote na máquina antes de chamar o sudo.
if [[ "$DRY_RUN" -eq 0 && "${EUID}" -ne 0 ]]; then
  echo "Execute como root: sudo $0" >&2
  exit 1
fi

# Executa um comando, ou só o anuncia no dry-run.
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [dry-run] $*"
    return 0
  fi
  "$@"
}

# -----------------------------------------------------------------
# 1. Qual binário instalar
#
# Espelha o Resolve-SourceBinary do install-windows.ps1: caminho explícito >
# binário ao lado do pacote > compilar com Go (modo dev).
# -----------------------------------------------------------------
verificar_binario() {
  local bin="$1" log desc=""

  # Um binário truncado ou de outra arquitetura instala um serviço que nunca
  # sobe, e isso só apareceria no caixa. Por isso os dois testes: `file` diz que
  # é um ELF desta máquina, e ele sobe de fato.
  if command -v file >/dev/null 2>&1; then
    desc="$(file -b "$bin" 2>/dev/null || true)"
    case "$(uname -m)" in
      x86_64)  [[ "$desc" == *x86-64* ]] || { erro "arquitetura errada: $desc"; return 1; } ;;
      aarch64) [[ "$desc" == *aarch64* ]] || { erro "arquitetura errada: $desc"; return 1; } ;;
    esac
    [[ "$desc" == *ELF* ]] || { erro "não é um ELF: $desc"; return 1; }
    ok "ELF: $desc"
  else
    aviso "sem 'file' na máquina: conferência de formato/arquitetura pulada"
  fi

  # Sobe o daemon de verdade, com um config descartável numa porta efêmera:
  # se ele aguentar o timeout ainda no ar, o binário funciona nesta máquina.
  # `timeout` devolve 124 quando o processo foi morto por tempo — que é o caso
  # bom aqui (um servidor não deve sair sozinho).
  if command -v timeout >/dev/null 2>&1; then
    local scratch rc=0
    scratch="$(mktemp -d)"
    # printers como objeto (não array) e listen em porta 0: o daemon escolhe
    # uma porta livre, então a conferência não briga com o serviço já no ar.
    printf '{"listen":"127.0.0.1:0","printers":{}}\n' >"$scratch/config.json"
    log="$scratch/saida.log"
    timeout 5 env PDV_PRINTER_CONFIG="$scratch/config.json" "$bin" >"$log" 2>&1 || rc=$?
    if [[ "$rc" -eq 124 ]]; then
      ok "sobe: ficou no ar até o timeout (config de teste em $(basename "$scratch"))"
      rm -rf "$scratch"
      return 0
    fi
    erro "o binário não ficou no ar (código $rc). Últimas linhas:"
    tail -n 5 "$log" >&2 || true
    erro "esperado era ele rodando até o timeout; isso normalmente é binário truncado ou de outra arquitetura."
    rm -rf "$scratch"
    return 1
  fi
  aviso "sem 'timeout' na máquina: só conferi o formato, não a execução"
  return 0
}

# Imprime as mensagens e deixa o caminho escolhido em RESOLVED. Teria sido
# `echo` no stdout, mas aí as mensagens iria junto no mesmo capture.
RESOLVED=""
resolver_binario() {
  RESOLVED=""
  if [[ -n "$BINARIO" ]]; then
    [[ -f "$BINARIO" ]] || { erro "o caminho informado em --binary não existe: $BINARIO"; return 1; }
    step "Binário informado em --binary"
    ok "$BINARIO"
    verificar_binario "$BINARIO" || return 1
    RESOLVED="$BINARIO"
    return 0
  fi

  local pronto="$ROOT/daemon/$BIN_NAME"
  if [[ -f "$pronto" && -x "$pronto" ]]; then
    step "Usando o binário que veio no pacote (sem Go)"
    if verificar_binario "$pronto"; then
      ok "$pronto"
      RESOLVED="$pronto"
      return 0
    fi
    aviso "o binário do pacote não serve nesta máquina; vou compilar com Go."
  elif [[ -f "$pronto" ]]; then
    aviso "$pronto existe mas não é executável; vou compilar com Go."
  fi

  if ! command -v go >/dev/null; then
    erro "Go 1.22+ é necessário para compilar o daemon, e o pacote não trouxe um binário utilizável."
    cat >&2 <<FIM
Procurei $pronto e não achei (ou ele não serve nesta máquina), e também não há Go aqui.

O esperado é rodar este script de dentro do pacote gerado por
printer/scripts/package-daemon-linux.sh — o binário vem junto. Se você está
aqui de propósito, baixe o pacote de novo.
FIM
    return 1
  fi

  step "Nenhum binário utilizável no pacote; compilando com Go (modo dev)"
  # Mesmo portão de teste do install-windows.ps1 e do build-sidecar.sh: um
  # daemon que compila e não passa em vet/test não deve virar serviço.
  local saida="$PREFIX/$BIN_NAME"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    # Nada em $PREFIX no dry-run; o build sai num tmpdir descartado.
    BUILD_TMP="$(mktemp -d)"
    trap 'rm -rf "${BUILD_TMP:-}"' EXIT
    saida="$BUILD_TMP/$BIN_NAME"
    ok "vet + test + build em $ROOT/daemon (saída em $saida)"
  else
    ok "vet + test + build em $ROOT/daemon"
  fi
  # A chamada é `resolver_binario || exit 1`, e isso desliga o errexit dentro
  # da função: cada passo tem o código conferido à mão, senão um `go test`
  # vermelho seguiria para o build e o script instalaria assim mesmo.
  local rc=0
  (
    cd "$ROOT/daemon" || exit 1
    go vet ./... || exit 1
    go test ./... || exit 1
    go build -trimpath -ldflags='-s -w' -o "$saida" . || exit 1
  ) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    erro "go vet/test/build falhou (código $rc) em $ROOT/daemon — nada foi instalado."
    return 1
  fi
  ok "compilado: $saida"
  verificar_binario "$saida" || return 1
  RESOLVED="$saida"
  return 0
}

step "Daemon de impressão do PDV"
resolver_binario || exit 1
SOURCE="$RESOLVED"

# -----------------------------------------------------------------
# 2. Usuário e diretórios
# -----------------------------------------------------------------
step "Preparando $PREFIX e $CONFIG_DIR"
run install -d -m 0755 "$PREFIX" "$CONFIG_DIR"

step "Usuário de serviço $SERVICE_USER"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "já existe"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [dry-run] useradd --system --home $PREFIX --shell /usr/sbin/nologin $SERVICE_USER"
  else
    useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "criado"
  fi
fi

# -----------------------------------------------------------------
# 3. Binário e templates
# -----------------------------------------------------------------
step "Instalando em $PREFIX"
if [[ "$SOURCE" == "$PREFIX/$BIN_NAME" ]]; then
  # Caminho de dev: o build da etapa 1 já escreveu direto no PREFIX.
  ok "$PREFIX/$BIN_NAME"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "    [dry-run] copiar $SOURCE -> $PREFIX/$BIN_NAME"
else
  install -m 0755 "$SOURCE" "$PREFIX/$BIN_NAME"
  ok "$PREFIX/$BIN_NAME"
fi

# Os templates vão sempre de $ROOT/daemon (é a origem nos dois caminhos: o
# pacote traz a pasta, e na árvore de dev ela está junto do código).
run cp -R "$ROOT/daemon/templates" "$PREFIX/"

# Não copia o config.example.json: ele traz IPs fictícios e uma impressora
# windows_spooler. Sem config, o próprio daemon cria um padrão na primeira
# execução, com impressoras sem endereço (ready=false até configurar) e um
# api_token aleatório.
if [[ -f "$CONFIG_DIR/config.json" ]]; then
  ok "config da loja em $CONFIG_DIR/config.json: preservado (o instalador nunca escreve esse arquivo)"
fi

run chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX" "$CONFIG_DIR"
run chmod 0755 "$PREFIX/$BIN_NAME"
run chmod 0750 "$CONFIG_DIR"

# -----------------------------------------------------------------
# 4. Unit do systemd
# -----------------------------------------------------------------
UNIT="$SYSTEMD_UNIT_DIR/$UNIT_NAME"
step "Escrevendo $UNIT"
if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<PREVIEW
    [dry-run] escreveria $UNIT:
      [Unit]
      Description=PDV Printer ESC/POS Daemon
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=$SERVICE_USER
      WorkingDirectory=$PREFIX
      Environment=PDV_PRINTER_CONFIG=$CONFIG_DIR/config.json
      ExecStart=$PREFIX/$BIN_NAME
      Restart=always
      RestartSec=3
      NoNewPrivileges=true
      PrivateTmp=true

      [Install]
      WantedBy=multi-user.target
PREVIEW
else
  install -d -m 0755 "$SYSTEMD_UNIT_DIR"
  cat >"$UNIT" <<EOF
[Unit]
Description=PDV Printer ESC/POS Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PREFIX
Environment=PDV_PRINTER_CONFIG=$CONFIG_DIR/config.json
ExecStart=$PREFIX/$BIN_NAME
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  ok "$UNIT"
fi

# -----------------------------------------------------------------
# 5. Subir
# -----------------------------------------------------------------
run systemctl daemon-reload
run systemctl enable --now "$UNIT_NAME"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "    [dry-run] systemctl --no-pager --full status $UNIT_NAME"
else
  systemctl --no-pager --full status "$UNIT_NAME" || true
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "dry-run: nada foi instalado."
  exit 0
fi

echo "Instalado. O daemon cria $CONFIG_DIR/config.json na primeira execução (com api_token)."
echo "Edite as impressoras e reinicie: sudo nano $CONFIG_DIR/config.json && systemctl restart pdv-printer"
echo "O PDV precisa enviar  Authorization: Bearer <api_token>  (campo api_token do config)."
