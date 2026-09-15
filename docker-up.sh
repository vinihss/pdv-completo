#!/bin/bash
# ============================================================
# docker-up.sh — sobe/down todo o projeto PDV em Docker, em modo LOCAL
# (sem domínio, sem HTTPS). Usa deploy/docker-compose.local.yml (produção)
# ou deploy/docker-compose.dev.yml + Dockerfile.dev (hot reload via bind mounts).
# Reaproveita os volumes nomeados pdv_* iguais ao deploy de produção.
#
# Uso:
#   ./docker-up.sh dev                       # modo desenvolvimento: hot reload
#   PDV_DEV=1 ./docker-up.sh stop           # parar containers de dev
#   ./docker-up.sh                       # modo produção (build + seed demo + PINs)
#   PDV_PORT=8080 ./docker-up.sh   # sobe em outra porta (padrão: 80)
#   ./docker-up.sh stop            # para os containers (mantém dados)
#   ./docker-up.sh down            # derruba os containers (mantém dados)
#   ./docker-up.sh reset           # derruba e APAGA os volumes (-v)
#   ./docker-up.sh logs            # logs em tempo real (-f)
#   ./docker-up.sh backup [dest]   # backup do SQLite (padrão: ./backups/)
#   ./docker-up.sh help            # esta ajuda
#
# Acesso após subir: http://localhost  (ou http://<IP-da-LAN>).
# ============================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ENV_FILE="deploy/.env"
PORT="${PDV_PORT:-80}"
URL="http://localhost:${PORT}"
DEV="${PDV_DEV:-0}"

if [ "$DEV" = "1" ]; then
  COMPOSE=(docker compose -f deploy/docker-compose.dev.yml)
else
  COMPOSE=(docker compose -f deploy/docker-compose.local.yml)
fi

help() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

require_tools() {
  command -v docker >/dev/null 2>&1 || { echo "ERRO: docker não instalado." >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "ERRO: docker compose não disponível." >&2; exit 1; }
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp deploy/.env.example "$ENV_FILE"
    echo "[env] deploy/.env criado a partir do exemplo."
  fi
  if grep -qE '^JWT_SECRET=([[:space:]]*|dev-secret-change-me)$' "$ENV_FILE"; then
    local secret
    secret="$(gen_secret)"
    sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${secret}/" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    echo "[env] JWT_SECRET gerado aleatoriamente em deploy/.env."
  fi
}

wait_health() {
  local i
  echo "[up] aguardando backend em ${URL}/health ..."
  for i in $(seq 1 60); do
    if curl -fsS "${URL}/health" >/dev/null 2>&1; then
      echo "[up] backend respondeu OK."
      return 0
    fi
    sleep 2
  done
  echo "ERRO: backend não respondeu em ${URL}/health após 120s. Veja: ./docker-up.sh logs" >&2
  exit 1
}

run_seed() {
  echo "[up] rodando seed de demonstração (idempotente):"
  if [ "$DEV" = "1" ]; then
    # Backend roda tsx watch sem dist/ compilado
    "${COMPOSE[@]}" exec -T backend npx tsx src/infra/db/seed.ts
  else
    "${COMPOSE[@]}" exec -T backend node dist/infra/db/seed.js
  fi
}

print_summary() {
  local ip
  local suffix=""
  ip="$(hostname -I 2>/dev/null || true)"
  ip="${ip%% *}"
  [ "$PORT" = "80" ] || suffix=":${PORT}"
  echo
  echo "============================================================"
  echo " PDV no ar!"
  echo "   Nesta máquina: http://localhost${suffix}"
  if [ -n "$ip" ]; then
    echo "   Na LAN        : http://${ip}${suffix}"
  fi
  echo
  echo " PINs de teste (seed demo):"
  echo "   Ana Ribeiro (Garçom)     1234"
  echo "   Carlos Lima (Garçom)     5678"
  echo "   Roberto Alves (Gerente)  9999"
  echo "   Estação Cozinha (Cozinha) 0000"
  echo
  echo " Comandos úteis: ./docker-up.sh logs | stop | down | backup"
  echo "============================================================"
}

start_services() {
  require_tools
  ensure_env
  if [ "$DEV" = "1" ]; then
    echo "[up] subida em modo desenvolvimento (hot reload via bind mounts)..."
    "${COMPOSE[@]}" up -d
  else
    echo "[up] build e subida dos containers (pode demorar na 1ª vez)..."
    "${COMPOSE[@]}" up -d --build
  fi
  wait_health
  run_seed
  print_summary
}

case "${1:-start}" in
  start)  start_services ;;
  dev)    DEV=1; COMPOSE=(docker compose -f deploy/docker-compose.dev.yml); start_services ;;
  stop)   require_tools; "${COMPOSE[@]}" stop ;;
  down)   require_tools; "${COMPOSE[@]}" down ;;
  reset)  require_tools; "${COMPOSE[@]}" down -v ;;
  logs)   require_tools; shift; if [ $# -eq 0 ]; then "${COMPOSE[@]}" logs -f; else "${COMPOSE[@]}" logs "$@"; fi ;;
  backup)
    require_tools
    if [ $# -gt 1 ]; then
      ./deploy/backup.sh "$2"
    else
      ./deploy/backup.sh ./backups
    fi
    ;;
  help|-h|--help) help ;;
  *)
    echo "Comando desconhecido: $1" >&2
    echo >&2
    help >&2
    exit 1
    ;;
esac
