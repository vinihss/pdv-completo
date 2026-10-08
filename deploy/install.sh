#!/usr/bin/env bash
# ============================================================
# INSTALAÇÃO DO ZERO — PDV completo (Hostinger VPS)
#
# Sobe containers, aguarda health check, cria somente o usuário
# gerente (seed-prod) e aplica o cardápio Unami (load-menu).
#
# Uso:
#   ./deploy/install.sh
#
# Variáveis necessárias em deploy/.env:
#   DOMAIN            — domínio real (ex.: app.seudominio.com.br)
#   JWT_SECRET        — chave forte (openssl rand -hex 32)
#   POSTGRES_PASSWORD — senha do banco (o compose sobe o Postgres junto)
#
# Variáveis opcionais (dados do estabelecimento):
#   MERCHANT_NAME  — nome do estabelecimento
#   MERCHANT_CITY  — cidade
#   MANAGER_NAME   — nome do gerente
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

# ---------- Cores ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
err()  { echo -e "${RED}[install]${NC} $*" >&2; exit 1; }

# ---------- 1. Pré-requisitos ----------
log "Verificando pré-requisitos..."

command -v docker >/dev/null 2>&1 || err "Docker não instalado. Instale com: curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || err "Docker Compose não instalado."

[ -f .env ] || err "Arquivo .env não encontrado. Copie: cp .env.example .env"

# Carrega .env
set -a
# shellcheck disable=SC1091
source .env
set +a

DOMAIN="${DOMAIN:-}"
JWT_SECRET="${JWT_SECRET:-}"

[ -n "$DOMAIN" ] || err "DOMAIN não definido no .env"
[ -n "${POSTGRES_PASSWORD:-}" ] || err "POSTGRES_PASSWORD não definido no .env (o backend autentica no Postgres com ele)"
[ -n "$JWT_SECRET" ] || err "JWT_SECRET não definido no .env (gere com: openssl rand -hex 32)"
[ "$JWT_SECRET" != "dev-secret-change-me" ] || err "JWT_SECRET não pode ser o valor de desenvolvimento"

MERCHANT_NAME="${MERCHANT_NAME:-Meu Estabelecimento}"
MERCHANT_CITY="${MERCHANT_CITY:-}"
MANAGER_NAME="${MANAGER_NAME:-Gerente}"

log "Domínio: $DOMAIN"
log "Estabelecimento: $MERCHANT_NAME"

# ---------- 2. Diretório de artefatos do instalador Windows ----------
# O proxy serve ./updates em /srv/pdv-updates (no host: o symlink que o
# caddy-host.sh cria; no stack local: bind mount do container). Se o
# diretório não existir, ele é criado com o dono errado e o job
# build-desktop não consegue publicar o instalador por SSH depois (o scp
# roda com o usuário do CI, não com root). Criar aqui, com o dono certo, é o
# que evita o "permission denied" no primeiro deploy.
log "Preparando deploy/updates (instalador do app Windows)..."
mkdir -p updates/files/windows-x86_64 || err "Não consegui criar deploy/updates"
# Família standalone: um diretório por app (ver Caddyfile e o job publish do
# build-desktop.yml). O app v1 (produção) continua no layout antigo.
for app in caixa kds; do
  mkdir -p "updates/$app" "updates/files/$app/windows-x86_64" || err "Não consegui criar deploy/updates"
done
[ -w updates ] || err "deploy/updates sem permissão de escrita. Se o Docker o criou como root: sudo chown \"\$(id -u):\$(id -g)\" updates"

# ---------- 2.5. Proxy no host (unit pdv-caddy) ----------
# ANTES do passo 3 de propósito: o `up --remove-orphans` derrubaria um
# container do caddy ainda no ar (reinstalação sobre sistema vivo), e
# ficaria um vazio de proxy até o unit assumir. A ordem certa é o unit
# assumir 80/443 primeiro e o `--remove-orphans` depois só limpar o órfão —
# que já não serve ninguém. Em instalação do zero não há container antigo: o
# unit sobe respondendo 502 até o passo 3 trazer o app (o `caddy-host.sh`
# tolera 502 nesse caso — é o probe "leniente sem app"). No stack local
# (compose que ainda declara o serviço `caddy`) não há o que preparar: o
# proxy continua sendo o container de sempre (a porta do `if` já trata disso).
if ! docker compose -f docker-compose.yml config --services 2>/dev/null | grep -qx caddy; then
  log "Preparando proxy no host (pdv-caddy)..."
  if [ "$(id -u)" -eq 0 ]; then
    bash ./caddy-host.sh --deploy-dir "$PWD"
  elif command -v sudo >/dev/null 2>&1; then
    sudo bash ./caddy-host.sh --deploy-dir "$PWD"
  else
    err "caddy-host.sh precisa de root (unit em /etc/systemd/system) e este shell não é root nem tem sudo"
  fi
fi

# ---------- 3. Subir containers ----------
# Os profiles `ws-gateway` e `pagarme-webhook` são subidos junto: o gateway
# serve o realtime (com o gate WS_DISPATCH desligado por padrão) e o webhook
# processa os eventos do Pagar.me (com o gate PAGARME_DRAIN desligado).
# O proxy de produção não é container (é o unit pdv-caddy, no passo 2.5) —
# ele não aparece nesta lista por desenho.
log "Subindo containers (backend + frontend + postgres + pedidopublic + ws-gateway + pagarme-webhook)..."
docker compose -f docker-compose.yml --profile ws-gateway --profile pagarme-webhook up -d --build --remove-orphans

# ---------- 4. Aguardar health check ----------
log "Aguardando backend ficar saudável..."
MAX_WAIT=180
WAITED=0
until docker compose -f docker-compose.yml exec -T backend node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  WAITED=$((WAITED + 3))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    err "Backend não respondeu em ${MAX_WAIT}s. Verifique os logs: docker compose -f docker-compose.yml logs backend"
  fi
  sleep 3
done
log "Backend saudável."

# ---------- 5. Seed: somente gerente ----------
log "Criando usuário gerente (seed-prod)..."
docker compose -f docker-compose.yml exec -T backend \
  node dist/infra/db/seed-prod.js

# ---------- 6. Cardápio Unami (explícito, não automático) ----------
log "Aplicando cardápio Unami (load-menu)..."
docker compose -f docker-compose.yml exec -T backend \
  node dist/infra/db/load-menu.js

# ---------- 7. Resumo ----------
echo ""
echo "============================================================"
echo " INSTALAÇÃO CONCLUÍDA"
echo "============================================================"
echo ""
echo "  URL:        https://${DOMAIN}"
echo "  Gerente:    ${MANAGER_NAME}"
echo "  PIN:        (fio no log acima — anote agora!)"
echo "  Cardápio:   Unami (63 produtos, 11 categorias)"
echo ""
echo "  O PIN do gerente foi exibido UMA ÚNICA VEZ no log acima."
echo "  Troque-o na tela de Equipe assim que entrar."
echo ""
echo "============================================================"
