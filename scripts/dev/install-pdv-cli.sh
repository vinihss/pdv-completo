#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI_DIR="$ROOT/cmd/pdv"

PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
BIN="$BIN_DIR/pdv"

usage() {
  cat <<EOF
Uso: $(basename "$0") [--uninstall] [--global] [--prefix <dir>]

Opções:
  --uninstall   Remove o binário pdv instalado
  --global      Instala em /usr/local/bin (pode exigir sudo)
  --prefix DIR  Instala em DIR/bin (default: $HOME/.local)
EOF
}

UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --global) PREFIX=/usr/local; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; usage; exit 1 ;;
  esac
done

BIN_DIR="$PREFIX/bin"
BIN="$BIN_DIR/pdv"

if [[ $UNINSTALL -eq 1 ]]; then
  if [[ -f "$BIN" ]]; then
    rm -f "$BIN"
    echo "removido: $BIN"
  else
    echo "não encontrado: $BIN"
  fi
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo não encontrado. Instale Rust (rustup): curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
fi

source "$HOME/.cargo/env" 2>/dev/null || true

mkdir -p "$BIN_DIR"

echo "Construindo pdv-cli (release)..."
(cd "$CLI_DIR" && cargo build --release)

cp "$CLI_DIR/target/release/pdv" "$BIN"
chmod +x "$BIN"
echo "Instalado em: $BIN"
echo "Adicione ao PATH se necessário: export PATH=\"$BIN_DIR:\$PATH\""
