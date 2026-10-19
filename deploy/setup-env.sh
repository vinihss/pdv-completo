#!/bin/bash

# Define os ficheiros
ENV_FILE=".env"
EXAMPLE_FILE=".env.example"

echo "🚀 A iniciar a configuração do ambiente (.env)..."

# 1. Garante que o ficheiro .env.example existe. Se não existir, cria um base.
if [ ! -f "$EXAMPLE_FILE" ]; then
    echo "📝 Ficheiro $EXAMPLE_FILE não encontrado. A criar um modelo padrão..."
    cat << 'EOF' > "$EXAMPLE_FILE"
# --- Configurações Globais ---
DOMAIN=localhost
DEPLOYMENT_MODE=local
PORT=3000
LOG_LEVEL=debug

# --- Segredos Automação ---
JWT_SECRET=generateme

# --- Base de Dados & Cache ---
POSTGRES_USER=pdv
POSTGRES_PASSWORD=pdv_password
POSTGRES_DB=pdv
POSTGRES_PORT=5432
POSTGRES_BIND_ADDRESS=127.0.0.1

REDIS_PORT=6379
REDIS_URL=redis://redis:6379

# --- Mapas & Rotas ---
# Região metropolitana norte (POA + São Leopoldo + Novo Hamburgo...),
# recortada do Geofabrik Sul por GEO_BBOX (ver deploy/prepare-geo-data.sh).
GEO_NAME=metropole-poa
GEO_BBOX=-51.40,-30.20,-50.95,-29.55
EOF
fi

# 2. Se o .env já existir, pergunta se o utilizador quer substituir
if [ -f "$ENV_FILE" ]; then
    read -p "⚠️ O ficheiro $ENV_FILE já existe. Deseja substituí-lo? (s/N): " response
    if [[ ! "$response" =~ ^([sS][iI][mM]|[sS])$ ]]; then
        echo "❌ Operação cancelada. O seu $ENV_FILE atual foi mantido."
        exit 0
    fi
fi

# 3. Copia o exemplo para o ficheiro oficial
cp "$EXAMPLE_FILE" "$ENV_FILE"

# 4. Gera uma chave secreta segura de 32 caracteres para o JWT_SECRET
# Usa o openssl se disponível, caso contrário usa o urandom como fallback
if command -v openssl >/dev/null 2>&1; then
    GEN_SECRET=$(openssl rand -hex 32)
else
    GEN_SECRET=$(tr -dc 'a-zA-Z0-9' < /dev/dev/urandom | fold -w 64 | head -n 1)
fi

# Substitui a marca de posição pelo segredo real gerado
# Suporta tanto a sintaxe do sed do Linux (GNU) como a do macOS (BSD)
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/JWT_SECRET=generateme/JWT_SECRET=$GEN_SECRET/g" "$ENV_FILE"
else
    sed -i "s/JWT_SECRET=generateme/JWT_SECRET=$GEN_SECRET/g" "$ENV_FILE"
fi

echo "🟢 Ficheiro $ENV_FILE criado com sucesso com chaves criptográficas seguras!"
