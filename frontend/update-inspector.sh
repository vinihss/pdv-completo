#!/usr/bin/env bash
# ============================================================
# update-inspector.sh — troca a versão do @inspector/react
# versionado como fonte (frontend/vendor/inspector-react) "on
# the fly", sem rebuild de imagem, sem npm ci e sem recompilar
# o pacote.
#
# Por que existe: na Etapa 1 o inspector é DEV-ONLY. Em dev o Vite
# resolve '@inspector/react' pro diretório frontend/vendor/
# (source vendored + HMR). Trocar essa fonte = nova versão no
# ar na hora, e a produção nem referencia o pacote (gate
# import.meta.env.DEV + tree-shaking).
#
# Uso:
#   ./update-inspector.sh <caminho-novo.tgz> [--dry-run]
#   ./update-inspector.sh --rollback
#
# O tgz pode ser:
#   - saída de `npm pack @inspector/react` (package/ prefix)
#   - tgz "solto" com package.json na raiz
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor/inspector-react"
BACKUP_DIR="$SCRIPT_DIR/vendor/inspector-react.bak"

log()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# ------------------------------------------------------------
# entrada
# ------------------------------------------------------------
MODE=swap
TGZ=""
case "${1:-}" in
  --dry-run)  MODE=dry;  TGZ="${2:-}" ;;
  --rollback) MODE=rollback ;;
  -h|--help)  usage ;;
  *)          TGZ="${1:-}" ;;
esac

# ------------------------------------------------------------
# utilitários
# ------------------------------------------------------------
is_tgz_inspector() {
  local t="$1"
  tar tzf "$t" >/dev/null 2>&1 || return 1
  # aceita package/package.json (npm pack) ou package.json solto na raiz
  { tar xOzf "$t" package/package.json 2>/dev/null || tar xOzf "$t" package.json 2>/dev/null; } | \
    grep -qE '"name"\s*:\s*"@inspector/react"'
}

case "$MODE" in
  rollback)
    [ -d "$BACKUP_DIR" ] || fail "sem backup em vendor/inspector-react.bak — nada a reverter."
    rm -rf "$VENDOR_DIR"
    mv "$BACKUP_DIR" "$VENDOR_DIR"
    log "✓ rollback completo (inspector-react restaurado do backup)."
    log "  Em dev o HMR recarrega sozinho — sempre foi a fonte de verdade."
    exit 0
    ;;
  dry)
    [ -n "$TGZ" ] || fail "uso: ./update-inspector.sh <novo.tgz> --dry-run"
    is_tgz_inspector "$TGZ" || fail "não é um tarball de @inspector/react: $TGZ"
    log "DRY-RUN — iria substituir vendor/inspector-react pela versão de:"
    tar tzf "$TGZ" | grep -E "package/src/index|package/package.json" | sed 's/^/  /' | head -8
    exit 0
    ;;
  swap) ;;
esac

[ -n "$TGZ" ] || usage
[ -f "$TGZ" ] || fail "arquivo não encontrado: $TGZ"
is_tgz_inspector "$TGZ" || fail "não é um tarball de @inspector/react: $TGZ"

log "swap: $TGZ  →  frontend/vendor/inspector-react"
[ -d "$VENDOR_DIR" ] || fail "vendor atual não existe (rode da raiz/do frontend): $VENDOR_DIR"

# ------------------------------------------------------------
# swap
# ------------------------------------------------------------
rm -rf "$BACKUP_DIR"
cp -a "$VENDOR_DIR" "$BACKUP_DIR"
log "  ✓ backup do estado atual em vendor/inspector-react.bak"
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
tar xzf "$TGZ" -C "$VENDOR_DIR" --strip-components=1 2>/dev/null \
  || tar xzf "$TGZ" -C "$VENDOR_DIR"                  # package/ ou raiz
chmod -R u+rwX "$VENDOR_DIR"

VER_NEW="$(grep -m1 '"version"' "$VENDOR_DIR/package.json" | sed -E 's/.*"([0-9][0-9.]*)".*/\1/')"
VER_OLD="$(grep -m1 '"version"' "$BACKUP_DIR/package.json" 2>/dev/null | sed -E 's/.*"([0-9][0-9.]*)".*/\1/')"
log "  ✓ versão: ${VER_OLD:-?} → ${VER_NEW:-?}"

# validação (dev espera fonte em src/)
if [ ! -f "$VENDOR_DIR/src/index.ts" ] && [ ! -f "$VENDOR_DIR/src/index.tsx" ]; then
  warn "  [!] atenção: a nova fonte não tem src/index.ts — o alias do Vite"
  warn "      resolve via main/exports do package.json, então confere ali:"
  warn "      grep 'main' vendor/inspector-react/package.json"
else
  log "  ✓ fonte src/ ok (alias do Vite aponta pra ela)"
fi

echo
log "CONCLUÍDO. Agora:"
log "  DEV  → salva em qualquer .tsx do vendor e o HMR recarrega na hora."
log "  PROD → o bundle nem referencia o inspector (gate import.meta.env.DEV)."
