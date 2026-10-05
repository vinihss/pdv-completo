#!/usr/bin/env bash
# ============================================================
# lib/common.sh — helpers compartilhados pelos scripts de apoio.
#
# Uso:
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"
#
# Requer bash (não POSIX sh): usa `local` e `$'...'`.
# Não usa `set -e` aqui de propósito — quem sourceia decide o
# modo do shell (normalmente `set -euo pipefail`).
# ============================================================

# Cores só quando a saída é um terminal; em pipe/CI, texto puro.
if [ -t 1 ]; then
  _COMMON_GREEN=$'\033[32m'
  _COMMON_YELLOW=$'\033[33m'
  _COMMON_RED=$'\033[31m'
  _COMMON_RESET=$'\033[0m'
else
  _COMMON_GREEN=''
  _COMMON_YELLOW=''
  _COMMON_RED=''
  _COMMON_RESET=''
fi

log() { printf '%s%s%s\n' "$_COMMON_GREEN" "$*" "$_COMMON_RESET"; }

warn() { printf '%s%s%s\n' "$_COMMON_YELLOW" "$*" "$_COMMON_RESET" >&2; }

die() { printf '%s%s%s\n' "$_COMMON_RED" "$*" "$_COMMON_RESET" >&2; exit 1; }

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "comando não encontrado: $cmd"
  done
}

load_env() {
  local file="${1:-.env}"
  [ -f "$file" ] || die "arquivo de ambiente não encontrado: $file"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}
