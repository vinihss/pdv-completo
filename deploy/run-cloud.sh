#!/bin/bash
# ============================================================
# Script de exemplo para rodar em modo cloud (Postgres)
# Uso: ./deploy/run-cloud.sh
# ============================================================

# Configurações do Postgres
export DEPLOYMENT_MODE=cloud
export DATABASE_URL="postgres://${POSTGRES_USER:-pdv}:${POSTGRES_PASSWORD:-pdv_password}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-pdv}"
export DOCKERFILE=Dockerfile.cloud

# JWT Secret obrigatório em modo cloud
if [ -z "$JWT_SECRET" ]; then
  echo "ERRO: JWT_SECRET é obrigatório em modo cloud"
  echo "Gere um com: openssl rand -hex 32"
  exit 1
fi

# Sobe o Postgres e o backend
docker compose --profile cloud up -d

echo ""
echo "Modo cloud ativo!"
echo "DATABASE_URL: $DATABASE_URL"
echo ""
echo "Para ver os logs: docker compose logs -f backend"
echo "Para parar: docker compose --profile cloud down"
