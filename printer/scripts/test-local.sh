#!/usr/bin/env bash
# test-local.sh — modo de teste local do daemon de impressão.
#
# Uso:
#   bash printer/scripts/test-local.sh
#
# O que faz (sem depender de Go no destino, se houver binário):
#   1. Cria diretório temporário com config.json mínimo (token "test-token").
#   2. Inicia um mock de impressora térmica em :9100 (go run printer/mock_server.go).
#   3. Inicia o daemon em 127.0.0.1:18080 (go run ./daemon ou binário preexistente).
#   4. Aguarda /health responder (até 10s).
#   5. Envia POST /api/print com printer/daemon/testdata/sample-print.json.
#   6. Confirma 202 Accepted e job na fila.
#   7. Para o daemon e o mock. Limpa o temp dir (mantém log em caso de falha).
#
# Sai 0 se tudo passar, 1 em qualquer erro. Não requer sudo e não toca em
# configuração de produção.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/daemon"
CONFIG_DIR=""
DAEMON_PID=""
MOCK_PID=""
EXIT_CODE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

die() { echo -e "${RED}ERRO: $*${NC}" >&2; EXIT_CODE=1; cleanup; exit 1; }
step() { echo -e "${CYAN}==> $*${NC}"; }
ok()   { echo -e "${GREEN}    OK${NC}: $*"; }

cleanup() {
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  # em caso de falha, preserva o temp dir para inspeção
  if [[ "$EXIT_CODE" -ne 0 && -n "$CONFIG_DIR" ]]; then
    echo "Log de debug preservado em: $CONFIG_DIR" >&2
  elif [[ -n "$CONFIG_DIR" && -d "$CONFIG_DIR" ]]; then
    rm -rf "$CONFIG_DIR"
  fi
}
trap cleanup EXIT

step "Verificando pré-requisitos"
command -v go >/dev/null || die "Go não encontrado. Instale Go 1.22+ para testar localmente."
command -v curl >/dev/null || die "curl não encontrado."

step "Criando config temporário"
CONFIG_DIR="$(mktemp -d)"
CONFIG_FILE="$CONFIG_DIR/config.json"
cat > "$CONFIG_FILE" <<'EOF'
{
  "listen": "127.0.0.1:18080",
  "api_token": "test-token",
  "allowed_origins": ["http://localhost"],
  "printers": {
    "kitchen": {
      "transport": "tcp",
      "address": "127.0.0.1:9100",
      "template": "kitchen-default",
      "status": true
    }
  }
}
EOF
export PDV_PRINTER_CONFIG="$CONFIG_FILE"
ok "config: $CONFIG_FILE"

step "Iniciando mock de impressora em :9100"
go run "$ROOT/mock_server.go" &>/tmp/pdv-mock.log &
MOCK_PID=$!
sleep 1
if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  die "mock_server falhou ao iniciar (veja /tmp/pdv-mock.log)"
fi
ok "mock PID=$MOCK_PID"

step "Iniciando daemon em 127.0.0.1:18080"
cd "$DAEMON_DIR"
PDV_PRINTER_CONFIG="$CONFIG_FILE" go run . &>/tmp/pdv-daemon.log &
DAEMON_PID=$!
sleep 2
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  die "daemon falhou ao iniciar (veja /tmp/pdv-daemon.log)"
fi
ok "daemon PID=$DAEMON_PID"

step "Aguardando /health"
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:18080/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -sf http://127.0.0.1:18080/health >/tmp/pdv-health.json || die "/health não respondeu"
ok "/health: $(cat /tmp/pdv-health.json)"

step "Enviando pedido de teste"
PAYLOAD="$DAEMON_DIR/testdata/sample-print.json"
RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST http://127.0.0.1:18080/api/print \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d "@$PAYLOAD") || die "POST /api/print falhou"
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [[ "$HTTP_CODE" != "202" ]]; then
  die "POST retornou HTTP $HTTP_CODE (esperado 202): $BODY"
fi
ok "POST 202 Accepted: $BODY"

step "Confirmando job na fila"
JOB_RESP=$(curl -sf http://127.0.0.1:18080/api/jobs?destination=kitchen \
  -H "Authorization: Bearer test-token") || die "GET /api/jobs falhou"
if echo "$JOB_RESP" | grep -q "test-local-001"; then
  ok "Job test-local-001 encontrado na fila"
else
  die "Job test-local-001 não encontrado em /api/jobs: $JOB_RESP"
fi

step "Parando daemon e mock"
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
sleep 1
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""

echo -e "${GREEN}TESTE OK${NC}: daemon apenas local, sem configuração de produção, sem sudo."
exit 0