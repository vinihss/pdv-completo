#!/bin/bash
# setup-dev.sh — sobe o PDV inteiro para desenvolvimento local.
#
#   backend/   API REST + WebSocket (Node + Fastify + Drizzle + Postgres)
#   frontend/  app React/Vite (PWA)
#   printer/   daemon de impressão ESC/POS (Go) + mock de impressora
#
# Uso:
#   bash scripts/setup-dev.sh              # tudo (recomendado)
#   bash scripts/setup-dev.sh --no-printer # só backend + frontend (não exige Go)
#   bash scripts/setup-dev.sh --no-seed    # pula o seed (não mexe nos dados)
#   bash scripts/setup-dev.sh -h
#
# POR QUE O DAEMON PRECISA DE UM CONFIG GERADO, E NÃO O config.example.json
# -------------------------------------------------------------------------
# Três fatos verificados no código (printer/daemon/server.go e os clientes):
#
# 1. O frontend (frontend/src/entities/printer/api/printer.js) e o backend
#    (backend/src/integrations/printer/printer.client.ts) NÃO mandam header
#    `Authorization` para o daemon. E `Daemon.authorize` (server.go:361) libera
#    tudo quando `api_token` está vazio. Então o config de dev precisa de
#    `"api_token": ""` — com token preenchido, toda impressão volta 401.
#
# 2. `withCORS` (server.go:312) responde **403** para qualquer `Origin` fora de
#    `allowed_origins`. O Vite serve em http://localhost:5173, e o
#    config.example.json NÃO lista essa origem (lista tauri://localhost, :1420
#    e :3000 — a :1420 é do Tauri, não do Vite). Sem ela o daemon sobe, o
#    /health responde e a impressão não sai, com erro genérico na tela. É o
#    modo de falha mais chato de diagnosticar, e é por isso que o script
#    confere a origem explicitamente em vez de só esperar o /health.
#
# 3. As impressoras do config.example.json apontam para 192.168.1.50:9100
#    (endereço fictício). Em dev, o destino `kitchen` aponta para o mock
#    local em 127.0.0.1:9100, então dá para ver os bytes ESC/POS saindo.
#
# `encoding: utf-8` é OBRIGATÓRIO aqui e errado em produção, e a diferença
# merece ser dita: sem `encoding`, o daemon converte para cp850 (codePage 2),
# que é o certo para uma térmica real. Mas o mock não é uma térmica — é um
# `cat` que despeja os bytes no terminal, e byte cp850 num terminal UTF-8 sai
# como "Cacha�a 51". Com utf-8 o encoder devolve nil (encoder.go:162, os
# bytes seguem sem conversão) e o cupom fica legível no terminal. Na
# impressora de verdade, volte para cp850.
#
# O config fica em printer/daemon/config.json, que o printer/.gitignore já
# ignora. Com data_dir e templates_dir vazios, o daemon os resolve relativos
# ao config (resolveDir, config.go:40): a fila vai para printer/daemon/data/
# (ignorado) e os templates para printer/daemon/templates, que é o do repo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
PRINTER_DIR="$ROOT_DIR/printer"
DAEMON_DIR="$PRINTER_DIR/daemon"
DAEMON_CONFIG="$DAEMON_DIR/config.json"
DAEMON_URL="http://127.0.0.1:8080"
MOCK_PORT=9100

WITH_PRINTER=1
DO_SEED=1

usage() {
    cat <<EOF
Uso: $(basename "$0") [opções]

  --no-printer   não sobe o daemon nem o mock (não exige Go instalado)
  --no-seed      não roda o seed (preserva os dados do banco)
  -h, --help     esta ajuda

Portas esperadas: backend 3000, frontend 5173, daemon 8080, mock de impressora $MOCK_PORT.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-printer) WITH_PRINTER=0; shift ;;
        --no-seed) DO_SEED=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Opção desconhecida: $1 (veja --help)" >&2; exit 2 ;;
    esac
done

PIDS=()
cleanup() {
    echo ""
    echo "==> Derrubando os processos"
    for pid in "${PIDS[@]:-}"; do
        [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

pass() { echo "OK: $*"; }
warn() { echo "AVISO: $*" >&2; }
die()  { echo "ERRO: $*" >&2; exit 1; }

echo "=== PDV Setup Dev ==="
echo ""

# -----------------------------------------------------------------
# 1. Pré-requisitos
# -----------------------------------------------------------------
command -v node >/dev/null || die "Node.js não encontrado. Instale o Node 20+ e tente novamente."
NODE_MAJOR="$(node -v | cut -d'v' -f2 | cut -d'.' -f1)"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js 20+ necessário. Versão atual: $(node -v)"
pass "Node.js $(node -v)"

command -v docker >/dev/null || die "Docker não encontrado. Instale o Docker e tente novamente."
pass "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

if [[ "$WITH_PRINTER" -eq 1 ]]; then
    command -v go >/dev/null || die \
"Go não encontrado, e o daemon de impressão precisa dele para rodar em dev.

Instale o Go 1.25+ (o printer/daemon/go.mod declara go 1.25.0), ou suba só o
restante com:  bash scripts/setup-dev.sh --no-printer"
    GO_MINOR="$(go env GOVERSION | sed 's/^go//' | cut -d. -f1 | cut -d. -f2)"
    [[ "$GO_MINOR" -ge 25 ]] || warn "Go $(go env GOVERSION): o go.mod pede 1.25.0. Se o build reclamar, atualize."
    pass "Go $(go env GOVERSION)"
fi

# -----------------------------------------------------------------
# 2. backend/.env
# -----------------------------------------------------------------
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    pass "backend/.env criado a partir do .env.example"
else
    pass "backend/.env já existe (preservado)"
fi

# -----------------------------------------------------------------
# 3. Dependências
# -----------------------------------------------------------------
echo ""
echo "Instalando dependências do backend..."
(cd "$BACKEND_DIR" && npm install --silent)
pass "backend: dependências instaladas"

echo ""
echo "Instalando dependências do frontend..."
(cd "$FRONTEND_DIR" && npm install --silent)
pass "frontend: dependências instaladas"

# -----------------------------------------------------------------
# 4. Postgres
# -----------------------------------------------------------------
# O compose publica a porta do host a partir de POSTGRES_PORT (default 5432).
# Atenção: a suíte de testes do repo sobe o PRÓPRIO Postgres em 55432
# (container pdv-test-db) — são dois bancos diferentes e as portas não podem
# colidir. Se o `up` reclamar "address already in use" em 5432, provavelmente
# já existe um Postgres do host nessa porta, e o jeito é apontar o
# DATABASE_URL do backend/.env para ele em vez de subir outro.
echo ""
echo "Subindo o PostgreSQL via Docker..."
docker compose -f "$ROOT_DIR/deploy/docker-compose.dev.yml" up -d postgres

echo "Aguardando o PostgreSQL ficar pronto..."
DB_READY=0
for _ in $(seq 1 30); do
    if docker compose -f "$ROOT_DIR/deploy/docker-compose.dev.yml" exec -T postgres \
        pg_isready -U pdv -d pdv >/dev/null 2>&1; then
        DB_READY=1
        break
    fi
    sleep 1
done
[[ "$DB_READY" -eq 1 ]] || die "PostgreSQL não ficou pronto em 30s"
pass "PostgreSQL pronto"

# -----------------------------------------------------------------
# 5. Seed
# -----------------------------------------------------------------
if [[ "$DO_SEED" -eq 1 ]]; then
    echo ""
    echo "Rodando o seed (migrations + dados de demonstração)..."
    (cd "$BACKEND_DIR" && npm run seed)
    pass "seed aplicado"
fi

# -----------------------------------------------------------------
# 6. Daemon de impressão + mock de impressora
# -----------------------------------------------------------------
MOCK_PID=""
DAEMON_PID=""

if [[ "$WITH_PRINTER" -eq 1 ]]; then
    echo ""
    echo "=== Daemon de impressão ==="

    # Não sobrescreve um config que o usuário possa ter ajustado à mão.
    if [[ -f "$DAEMON_CONFIG" ]]; then
        warn "$DAEMON_CONFIG já existe; preservado. Se a impressão não sair no browser, confira api_token e allowed_origins nele."
    else
        cat > "$DAEMON_CONFIG" <<EOF
{
  "api_token": "",
  "listen": "127.0.0.1:8080",
  "allowed_origins": ["http://localhost:5173", "http://localhost:3000"],
  "printers": {
    "kitchen": {
      "transport": "tcp",
      "printer_id": "kitchen-dev",
      "address": "127.0.0.1:$MOCK_PORT",
      "template": "kitchen-default",
      "encoding": "utf-8",
      "status": true
    }
  }
}
EOF
        pass "config gerado em printer/daemon/config.json"
    fi

    # Mock de impressora térmica: escuta em :9100 e imprime os bytes ESC/POS
    # que receber. É ele que recebe o cupom quando não há impressora de verdade.
    echo "Subindo o mock de impressora em 127.0.0.1:$MOCK_PORT..."
    (cd "$PRINTER_DIR" && go run mock_server.go > /tmp/pdv-mock-printer.log 2>&1) &
    MOCK_PID=$!
    PIDS+=("$MOCK_PID")

    echo "Subindo o daemon em $DAEMON_URL..."
    (cd "$DAEMON_DIR" && PDV_PRINTER_CONFIG="$DAEMON_CONFIG" go run . > /tmp/pdv-daemon.log 2>&1) &
    DAEMON_PID=$!
    PIDS+=("$DAEMON_PID")

    # O /health responder é o mínimo, e não basta: o modo de falha que mais
    # custa tempo é o daemon no ar com allowed_origins errado, em que o
    # browser leva 403 na impressão e a tela mostra um erro genérico.
    echo "Aguardando o daemon..."
    DAEMON_UP=0
    for _ in $(seq 1 40); do
        if curl -sf "$DAEMON_URL/health" >/dev/null 2>&1; then DAEMON_UP=1; break; fi
        sleep 0.5
    done

    if [[ "$DAEMON_UP" -ne 1 ]]; then
        echo ""
        echo "Últimas linhas de /tmp/pdv-daemon.log:" >&2
        tail -n 10 /tmp/pdv-daemon.log >&2 || true
        die "o daemon não respondeu em $DAEMON/health"
    fi
    pass "daemon no ar: $(curl -sf "$DAEMON_URL/health")"

    # Confere a origem do Vite de verdade: se der 403, o browser vai recusar a
    # impressão mesmo com tudo o resto no ar.
    CORS_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
        -H 'Origin: http://localhost:5173' "$DAEMON_URL/api/printers/status")"
    if [[ "$CORS_CODE" == "200" ]]; then
        pass "CORS: origem http://localhost:5173 aceita ($CORS_CODE)"
    else
        die "CORS: http://localhost:5173 recebeu $CORS_CODE em /api/printers/status.
    O browser vai recusar a impressão com erro genérico. Confira allowed_origins
    em $DAEMON_CONFIG (tem que conter http://localhost:5173)."
    fi

    # O destino precisa estar alcançável, senão a fila trava em retry.
    STATUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
        -H 'Origin: http://localhost:5173' "$DAEMON_URL/api/printers/status?destination=kitchen")"
    if [[ "$STATUS_CODE" == "200" ]]; then
        pass "destino kitchen alcançável: $(curl -sf -H 'Origin: http://localhost:5173' "$DAEMON_URL/api/printers/status?destination=kitchen")"
    else
        warn "kitchen respondeu $STATUS_CODE — se o mock não subiu, o destino fica offline e o cupom vai para retry."
    fi
fi

# -----------------------------------------------------------------
# 7. Backend e frontend
# -----------------------------------------------------------------
echo ""
echo "=== Backend e frontend ==="
(cd "$BACKEND_DIR" && npm run dev > /tmp/pdv-backend.log 2>&1) &
BACKEND_PID=$!
PIDS+=("$BACKEND_PID")

(cd "$FRONTEND_DIR" && npm run dev > /tmp/pdv-frontend.log 2>&1) &
FRONTEND_PID=$!
PIDS+=("$FRONTEND_PID")

echo "Aguardando o backend responder..."
API_UP=0
for _ in $(seq 1 60); do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then API_UP=1; break; fi
    sleep 1
done
if [[ "$API_UP" -eq 1 ]]; then
    pass "backend no ar: http://localhost:3000"
else
    warn "o backend não respondeu em http://localhost:3000/health — veja /tmp/pdv-backend.log"
fi

# -----------------------------------------------------------------
# 8. Resumo
# -----------------------------------------------------------------
cat <<EOF

=== Tudo no ar ===

  Frontend (app)     http://localhost:5173
  Backend (API)      http://localhost:3000
EOF

if [[ "$WITH_PRINTER" -eq 1 ]]; then
cat <<EOF
  Daemon de impressão  $DAEMON_URL
  Mock de impressora   127.0.0.1:$MOCK_PORT   (log: /tmp/pdv-mock-printer.log)

  Logs: /tmp/pdv-backend.log, /tmp/pdv-frontend.log, /tmp/pdv-daemon.log
EOF
fi

cat <<EOF

  Entrar com PIN de demonstração (nunca use em produção):
    Garçom     Ana Ribeiro   1234
    Gerente    Roberto Alves 9999
    Caixa      Caixa Teste   2468

  Impressão: lance um pedido no perfil garçom e o cupom sai no terminal do
  mock (verifique com: curl -s http://localhost:8080/api/jobs).

  Ctrl+C derruba tudo.

EOF

wait
