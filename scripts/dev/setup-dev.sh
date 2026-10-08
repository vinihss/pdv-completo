#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
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

  --no-seed      não roda o seed (preserva os dados do banco)
  -h, --help     esta ajuda

Portas esperadas: backend 3000, frontend 5173, daemon 8080
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