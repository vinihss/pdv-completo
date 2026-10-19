#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

DO_SEED=1

usage() {
    cat <<EOF
Uso: $(basename "$0") [opções]

  --no-seed      não roda o seed (preserva os dados do banco)
  -h, --help     esta ajuda

Portas esperadas: backend 3000, frontend 5173
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-seed) DO_SEED=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Opção desconhecida: $1 (veja --help)" >&2; exit 2 ;;
    esac
done
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
command -v docker compose >/dev/null || die "docker-compose plugin não encontrado. Instale a extensão 'docker-compose' ou use o compose v2."
pass "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# -----------------------------------------------------------------
# 2. backend/.env
# -----------------------------------------------------------------
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    pass "backend/.env criado a partir do .env.example"
    warn "Lembre-se de ajustar DATABASE_URL, JWT_SECRET e outras variáveis críticas em backend/.env antes de rodar o seed ou o backend."
else
    pass "backend/.env já existe (preservado)"
fi

# -----------------------------------------------------------------
# 3. Dependências
# -----------------------------------------------------------------
echo ""
echo "Instalando dependências do backend..."
(cd "$BACKEND_DIR" && npm install)
pass "backend: dependências instaladas"

echo ""
echo "Instalando dependências do frontend..."
(cd "$FRONTEND_DIR" && npm install)
pass "frontend: dependências instaladas"

# -----------------------------------------------------------------
# 4. Postgres
# -----------------------------------------------------------------
# O compose sobe o Postgres pela override (ports 5432:5432 visíveis no host).
# A suíte de testes do repo usa um container pdv-test-db em 55432 — porta
# diferente, portanto não há conflito na dev machine.
echo ""
echo "Subindo o PostgreSQL via Docker..."
docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" up -d postgres

echo "Aguardando o PostgreSQL ficar pronto..."
DB_READY=0
for _ in $(seq 1 30); do
    if docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" exec -T postgres \
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
    docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" exec -T backend npm run seed
    pass "seed aplicado"
fi

# -----------------------------------------------------------------
# 6. Subir todo o ambiente via Docker Compose (backend, frontend)
# -----------------------------------------------------------------
echo ""
echo "=== Subindo backend e frontend via Docker Compose ==="
echo ""

echo "Subindo serviços (backend, frontend, postgres, redis, caddy)..."
docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" up -d

echo "Aguardando o PostgreSQL ficar pronto..."
DB_READY=0
for _ in $(seq 1 30); do
    if docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" exec -T postgres \
        pg_isready -U pdv -d pdv >/dev/null 2>&1; then
        DB_READY=1
        break
    fi
    sleep 1
done
[[ "$DB_READY" -eq 1 ]] || die "PostgreSQL não ficou pronto em 30s"
pass "PostgreSQL pronto"

# Seed já foi feito acima (se solicitado)
if [[ "$DO_SEED" -eq 1 ]]; then
    echo ""
    echo "Seed já aplicado anteriormente."
fi

echo "Aguardando o backend ficar pronto..."
BACKEND_UP=0
for _ in $(seq 1 60); do
    if docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" ps -q backend | xargs -I {} docker inspect -f '{{.State.Health.Status}}' {} 2>/dev/null | grep -q healthy; then
        BACKEND_UP=1
        break
    fi
    # Alternativa: verificar se a porta está acessível via caddy (host:8081)
    if curl -sf http://localhost:8081/health >/dev/null 2>&1; then
        BACKEND_UP=1
        break
    fi
    sleep 1
done

if [[ "$BACKEND_UP" -eq 1 ]]; then
    pass "backend no ar (via Caddy em localhost:8081)"
else
    warn "o backend não ficou pronto — veja os logs: docker compose -f ... logs backend"
fi

# O frontend está disponível via Caddy na mesma porta
pass "frontend disponível em http://localhost:8081 (via Caddy)"


# -----------------------------------------------------------------
# 7. Resumo
# -----------------------------------------------------------------
cat <<EOF

=== Tudo no ar ===

  Frontend (app)     http://localhost:8081
  Backend (API)      http://localhost:8081
EOF


cat <<EOF

  Entrar com PIN de demonstração (nunca use em produção):
    Garçom     Ana Ribeiro   1234
    Gerente    Roberto Alves 9999
    Caixa      Caixa Teste   2468

  Ctrl+C para parar os containers docker compose.

EOF

# Cleanup: derrubar os containers docker compose na saída
trap 'docker compose -f "$ROOT_DIR/deploy/docker-compose.yml" -f "$ROOT_DIR/deploy/docker-compose.override.yml" down' EXIT INT TERM
