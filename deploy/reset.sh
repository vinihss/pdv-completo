#!/usr/bin/env bash
# ============================================================
# RESET TOTAL — remove containers, imagens e volumes do PDV.
# DESTRUTIVO: todos os dados (comandas, cadastros, cardápio)
# são perdidos. Use apenas para começar do zero.
#
# Uso:
#   ./deploy/reset.sh            # pede confirmação antes de apagar
#   ./deploy/reset.sh --force    # pula a confirmação
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

FORCE="${1:-}"

echo "============================================================"
echo " RESET TOTAL — PDV"
echo "============================================================"
echo ""
echo "Isto vai remover:"
echo "  - Todos os containers do docker-compose (backend, frontend, …)"
echo "  - Todos os volumes do projeto, EXCETO os de certificados do proxy"
echo "    (pdv_caddy_data / pdv_caddy_config ficam: apagá-los faria o"
echo "    Let's Encrypt reemitir do zero e estourar o rate limit semanal)"
echo "  - Todas as imagens do projeto"
echo ""
echo "O proxy do HOST (unit systemd pdv-caddy) não é gerenciado por aqui."
echo ""
echo "TODOS OS DADOS SERÃO PERDIDOS. Esta ação é irreversível."
echo ""

if [ "$FORCE" != "--force" ]; then
  read -r -p "Digite 'RESET' para confirmar: " CONFIRM
  if [ "$CONFIRM" != "RESET" ]; then
    echo "Cancelado."
    exit 0
  fi
fi

echo ""
echo "[1/4] Removendo containers e volumes..."
docker compose -f docker-compose.yml down -v --remove-orphans 2>/dev/null || true

echo "[2/4] Removendo imagens do projeto..."
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E 'pdv-completo|pdv_' | xargs -r docker rmi -f 2>/dev/null || true

echo "[3/4] Removendo volumes órfãos (certificados do proxy preservados)..."
docker volume ls --format '{{.Name}}' | grep -E '^pdv_' |
  grep -vE '^pdv_caddy_(data|config)$' |
  xargs -r docker volume rm -f 2>/dev/null || true

echo "[4/4] Limpando cache de build..."
docker builder prune -f 2>/dev/null || true

echo ""
echo "============================================================"
echo " RESET CONCLUÍDO."
echo ""
echo " Para instalar do zero, execute:"
echo "   ./deploy/install.sh"
echo ""
echo " O proxy do host continua instalado (unit pdv-caddy). Ele passa a"
echo " responder 502 sem backend; para removê-lo:"
echo "   systemctl disable --now pdv-caddy && rm /etc/systemd/system/pdv-caddy.service"
echo "============================================================"
