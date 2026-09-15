#!/usr/bin/env bash
# ============================================================
# Backup consistente do SQLite (modo local) — deploy/backup.sh
#
# Usa o comando `.backup` do sqlite3, que gera um snapshot online
# consistente mesmo em WAL mode. Copiar só o data.db (como o cron
# antigo fazia) pode perder transações que ainda estão no
# data.db-wal — este script não tem esse risco.
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

VOLUME="${PDV_BACKUP_VOLUME:-pdv_backend_data}"
UPLOADS_VOLUME="${PDV_UPLOADS_VOLUME:-pdv_backend_uploads}"
DEST="${1:-$(pwd)/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$DEST/pdv-$STAMP.db"
UPLOADS_TARGET="$DEST/pdv-$STAMP-uploads.tar.gz"

mkdir -p "$DEST"

echo "Backup do volume '$VOLUME' -> $TARGET"
docker run --rm \
  -v "${VOLUME}:/data" \
  -v "${DEST}:/backup" \
  nouchka/sqlite3 \
  /data/data.db ".backup '/backup/pdv-${STAMP}.db'"

echo "Backup das fotos de produto ('$UPLOADS_VOLUME') -> $UPLOADS_TARGET"
docker run --rm \
  -v "${UPLOADS_VOLUME}:/uploads:ro" \
  -v "${DEST}:/backup" \
  busybox \
  tar czf "/backup/pdv-${STAMP}-uploads.tar.gz" -C /uploads .

echo "OK: $(ls -lh "$TARGET" "$UPLOADS_TARGET" | awk '{print $5, $NF}')"
