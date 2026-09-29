#!/usr/bin/env bash
# ============================================================
# Backup consistente do PostgreSQL + uploads — deploy/backup.sh
#
# Usa o `pg_dump` (formato custom, comprimido) contra o container do
# Postgres: snapshot transacional consistente, sem parar o banco.
# O .dump restaura com `pg_restore`; o SQL puro com `psql -f`.
#
# Uso:
#   ./backup.sh                     # salva em ./backups/
#   ./backup.sh /caminho/destino    # salva em outro diretório
#
# Cron diário sugerido (edite o destino):
#   0 3 * * * /opt/pdv/deploy/backup.sh /opt/backups
# E envie as cópias pra fora do servidor (S3, Backblaze, etc.) — um
# backup que só fica no mesmo disco não protege contra o servidor sumir.
# ============================================================
set -euo pipefail

# O nome vem do projeto compose: switch.sh roda `docker compose -f
# docker-compose.yml` de dentro de deploy/ e sem `-p`, então o compose
# deriva o projeto do diretório ("deploy") e nomeia o container
# <projeto>-<serviço>-1. O default anterior era "pdv-compose-postgres-1",
# que só bateria numa instalação que não é a nossa — e aí o fallback abaixo
# roda e falha, porque o host tinha mais de um Postgres (o de produção e um
# de teste). O backup do CI parava em "2 containers Postgres no host".
PG_CONTAINER="${PDV_PG_CONTAINER:-deploy-postgres-1}"
PG_USER="${POSTGRES_USER:-pdv}"
PG_DB="${POSTGRES_DB:-pdv}"
UPLOADS_VOLUME="${PDV_UPLOADS_VOLUME:-pdv_backend_uploads}"
DEST="${1:-$(pwd)/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$DEST/pdv-$STAMP.dump"
UPLOADS_TARGET="$DEST/pdv-$STAMP-uploads.tar.gz"

mkdir -p "$DEST"

# Resolve o nome do container se o padrão não existir (compose nomeia
# <projeto>-<serviço>-1; o projeto pode ter outro nome). Com mais de um
# Postgres no host não dá pra adivinhar — exige PDV_PG_CONTAINER.
if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  mapfile -t CANDIDATES < <(docker ps --filter ancestor=postgres:16-alpine --format '{{.Names}}')
  if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
    echo "ERRO: container do Postgres não encontrado (ajuste PDV_PG_CONTAINER)." >&2
    exit 1
  fi
  if [[ ${#CANDIDATES[@]} -gt 1 ]]; then
    echo "ERRO: ${#CANDIDATES[@]} containers Postgres no host; defina PDV_PG_CONTAINER:" >&2
    printf '  %s\n' "${CANDIDATES[@]}" >&2
    exit 1
  fi
  PG_CONTAINER="${CANDIDATES[0]}"
  echo "Container do Postgres detectado: $PG_CONTAINER"
fi

echo "Backup do banco '$PG_DB' (container $PG_CONTAINER) -> $TARGET"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$TARGET"

echo "Backup das fotos de produto ('$UPLOADS_VOLUME') -> $UPLOADS_TARGET"
docker run --rm \
  -v "${UPLOADS_VOLUME}:/uploads:ro" \
  -v "${DEST}:/backup" \
  busybox \
  tar czf "/backup/pdv-${STAMP}-uploads.tar.gz" -C /uploads .

echo "OK: $(ls -lh "$TARGET" "$UPLOADS_TARGET" | awk '{print $5, $NF}')"
