#!/usr/bin/env bash
# ============================================================
# Backup remoto + download local — deploy/backup-fetch.sh
#
# Conecta via SSH, gera o backup do SQLite no servidor e baixa o
# arquivo .db localmente (sem fotos/uploads).
#
# Uso:
#   ./backup-fetch.sh user@host
#   PDV_SSH_PASS='senha' ./backup-fetch.sh user@host
#
# Variáveis opcionais:
#   PDV_SSH_PORT         (padrão: 22)
#   PDV_REMOTE_DIR       (padrão: /root/pdv-completo/deploy)
#   PDV_LOCAL_BACKUP_DIR (padrão: ~/Downloads/pdv-backups)
#   PDV_SSH_PASS         (se definido, usa sshpass -e)
# ============================================================
set -euo pipefail

HOST="${1:?Uso: ./backup-fetch.sh user@host}"
PORT="${PDV_SSH_PORT:-22}"
REMOTE_DIR="${PDV_REMOTE_DIR:-/root/pdv-completo/deploy}"
LOCAL_DIR="${PDV_LOCAL_BACKUP_DIR:-$HOME/Downloads/pdv-backups}"
TMP_REMOTE="/tmp/pdv-backup-fetch"

mkdir -p "$LOCAL_DIR"

SSH_OPTS=(-p "$PORT")
if [[ -n "${PDV_SSH_PASS:-}" ]]; then
  SSH_CMD=(sshpass -e ssh)
  SCP_CMD=(sshpass -e scp)
else
  SSH_CMD=(ssh)
  SCP_CMD=(scp)
fi

echo "Gerando backup remoto em $HOST..."
"${SSH_CMD[@]}" "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$TMP_REMOTE' && '$REMOTE_DIR/backup.sh' '$TMP_REMOTE'"

REMOTE_FILE=$("${SSH_CMD[@]}" "${SSH_OPTS[@]}" "$HOST" "ls -t '$TMP_REMOTE'/pdv-*.db | head -1")
FILENAME=$(basename "$REMOTE_FILE")

echo "Baixando $FILENAME para $LOCAL_DIR/..."
"${SCP_CMD[@]}" "${SSH_OPTS[@]}" "$HOST:$REMOTE_FILE" "$LOCAL_DIR/$FILENAME"

"${SSH_CMD[@]}" "${SSH_OPTS[@]}" "$HOST" "rm -rf '$TMP_REMOTE'"

echo "OK: backup local em $LOCAL_DIR/$FILENAME"
