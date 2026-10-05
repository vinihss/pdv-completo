#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo "=== PDV Setup Dev ==="
echo ""

# 1. Verificar Node.js
if ! command -v node &>/dev/null; then
    echo "ERRO: Node.js não encontrado. Instale Node.js 20+ e tente novamente."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "ERRO: Node.js 20+ necessário. Versão atual: $(node -v)"
    exit 1
fi

echo "OK: Node.js $(node -v)"

# 2. Verificar Docker
if ! command -v docker &>/dev/null; then
    echo "ERRO: Docker não encontrado. Instale Docker e tente novamente."
    exit 1
fi

echo "OK: Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# 3. Criar .env do backend se não existir
if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo ""
    echo "Criando backend/.env a partir de .env.example..."
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    echo "OK: backend/.env criado (ajuste DATABASE_URL e JWT_SECRET se necessário)"
else
    echo "OK: backend/.env já existe"
fi

# 4. Instalar dependências do backend
echo ""
echo "Instalando dependências do backend..."
cd "$BACKEND_DIR"
npm install --silent

# 5. Instalar dependências do frontend
echo ""
echo "Instalando dependências do frontend..."
cd "$FRONTEND_DIR"
npm install --silent

# 6. Subir Postgres via Docker
echo ""
echo "Subindo PostgreSQL via Docker..."
cd "$ROOT_DIR"
docker compose -f deploy/docker-compose.dev.yml up -d postgres

# 7. Aguardar Postgres ficar saudável
echo ""
echo "Aguardando PostgreSQL ficar pronto..."
for i in {1..30}; do
    if docker compose -f deploy/docker-compose.dev.yml exec -T postgres pg_isready -U pdv -d pdv &>/dev/null; then
        echo "OK: PostgreSQL pronto"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERRO: PostgreSQL não ficou pronto em 30 segundos"
        exit 1
    fi
    sleep 1
done

# 8. Rodar seed
echo ""
echo "Rodando seed (migrações + dados de demonstração)..."
cd "$BACKEND_DIR"
npm run seed

# 9. Iniciar backend e frontend
echo ""
echo "=== Setup concluído ==="
echo ""
echo "Iniciando backend e frontend..."
echo "  Backend:  http://localhost:3000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Pressione Ctrl+C para parar"
echo ""

cd "$BACKEND_DIR"
npm run dev &
BACKEND_PID=$!

cd "$FRONTEND_DIR"
npm run dev &
FRONTEND_PID=$!

cleanup() { kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null; exit; }
trap cleanup INT TERM

wait
