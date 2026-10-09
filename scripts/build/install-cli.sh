#!/usr/bin/env bash
# install-cli.sh — compila o CLI Go `pdv` (cmd/pdv) e instala o binário no sistema.
#
# Uso:
#   bash scripts/build/install-cli.sh                # instala em /usr/local/bin/pdv
#   bash scripts/build/install-cli.sh ~/.local       # instala em ~/.local/bin/pdv
#   bash scripts/build/install-cli.sh --uninstall    # remove o binário instalado
#   bash scripts/build/install-cli.sh -h | --help    # mostra esta ajuda
#
# Variáveis de ambiente:
#   PREFIX            base da instalação (default: /usr/local) — o binário vai para $PREFIX/bin
#   PDV_CLI_GOFLAGS   flags extras repassadas ao `go build` (opcional)
#
# Para instalar em /usr/local/bin talvez precise de root:
#   sudo bash scripts/build/install-cli.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI_DIR="$ROOT/cmd/pdv"
BIN_NAME="pdv"

PREFIX="${PREFIX:-/usr/local}"
INSTALL_DIR="$PREFIX/bin"
BIN_PATH="$INSTALL_DIR/$BIN_NAME"

die() {
  printf 'erro: %s\n' "$*" >&2
  exit 1
}

print_usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

# ver_ge <a> <b>: retorna 0 quando a >= b (a/b em major[.minor[.patch]])
ver_ge() {
  local a=() b=() i na nb
  IFS='.' read -r -a a <<<"$1"
  IFS='.' read -r -a b <<<"$2"
  for i in 0 1 2; do
    na="${a[$i]:-0}"
    nb="${b[$i]:-0}"
    (( na > nb )) && return 0
    (( na < nb )) && return 1
  done
  return 0
}

uninstall() {
  if [ -f "$BIN_PATH" ]; then
    rm -f "$BIN_PATH"
    printf 'removido: %s\n' "$BIN_PATH"
  else
    printf 'nada a remover: %s não existe\n' "$BIN_PATH"
  fi
}

[ $# -le 1 ] || die "uso: $0 [--uninstall] [prefixo] (veja $0 --help)"

case "${1:-}" in
  -h | --help) print_usage; exit 0 ;;
  --uninstall) uninstall; exit 0 ;;
esac

# Primeiro argumento posicional (se houver) é o PREFIX.
if [ $# -eq 1 ] && [ -n "$1" ]; then
  PREFIX="$1"
  INSTALL_DIR="$PREFIX/bin"
  BIN_PATH="$INSTALL_DIR/$BIN_NAME"
fi

command -v go >/dev/null 2>&1 || die "Go não encontrado (instale Go: https://go.dev/dl/)"

MIN_GO="$(sed -n 's/^go \([0-9][0-9.]*\).*/\1/p' "$CLI_DIR/go.mod" | head -1)"
MIN_GO="${MIN_GO:-1.25}"
GO_VER="$(go version 2>/dev/null | sed -n 's/.*go\([0-9][0-9.]*\).*/\1/p' || true)"

if [ -n "$GO_VER" ] && ! ver_ge "$GO_VER" "$MIN_GO"; then
  die "Go muito antigo: go.mod pede >= $MIN_GO, você tem $GO_VER (go version)"
fi

printf 'compilando %s (go %s)…\n' "$CLI_DIR" "${GO_VER:-?}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

(
  cd "$CLI_DIR"
  go build ${PDV_CLI_GOFLAGS:-} -trimpath -ldflags "-s -w" -o "$TMP_DIR/$BIN_NAME" .
)

[ -x "$TMP_DIR/$BIN_NAME" ] || die "o build não produziu o binário"

install -d "$INSTALL_DIR"
install -m 0755 "$TMP_DIR/$BIN_NAME" "$BIN_PATH"

# Smoke test: o root do CLI imprime o uso e sai com 0.
if ! "$BIN_PATH" --help >/dev/null 2>&1; then
  rm -f "$BIN_PATH"
  die "o binário instalado falhou no smoke test — instalação desfeita"
fi

HEAD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
TAG="$(git -C "$ROOT" describe --tags --always 2>/dev/null || true)"

printf 'instalado: %s\n' "$BIN_PATH"
printf 'fonte: %s (commit %s, tag %s)\n' "$ROOT" "${HEAD:-?}" "${TAG:-sem tag}"

printf '\nNota: o CLI acha a raiz do repositório pelo diretório atual (ou pela env PDV_ROOT).\n'
printf 'Rode `pdv` de dentro de um checkout do projeto ou exporte PDV_ROOT=<caminho-do-repo>.\n'