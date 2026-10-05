#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Buildando pedido-public..."
npm run build:pedido

echo "==> Sincronizando dist para servidor..."
DIST="apps/pedido-public/dist/"
RSYNC_FLAGS=(-avz --delete)
DIST_DIR="apps/pedido-public/dist/"
REMOTE_USER="${PEDIDO_DEPLOY_USER:-pdv}"
REMOTE_HOST="${PEDIDO_DEPLOY_HOST:-seu-servidor}"
REMOTE_PATH="${PEDIDO_DEPLOY_PATH:-/var/www/pedido-public/}"

rsync "${RSYNC_FLAGS[@]}" "$DIST_DIR" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"

echo "==> Recarregando Caddy..."
ssh "${REMOTE_USER}@${REMOTE_HOST}" "systemctl reload caddy"

echo "==> Deploy do pedido-public concluído com sucesso!"
