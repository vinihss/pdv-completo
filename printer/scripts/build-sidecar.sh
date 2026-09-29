#!/usr/bin/env bash
# Gera o sidecar do daemon de impressão na convenção de nome que o Tauri exige
# (externalBin): <nome>-<target-triple>.
#
# O Windows é o alvo do produto (é o que o instalador da loja recebe), mas o
# build.rs do Tauri exige que o sidecar da plataforma atual exista — sem o
# binário Linux o `cargo check` nem roda na máquina de desenvolvimento. Por
# isso os dois: o .exe é o que vai no instalador, o ELF é só para o dev local
# conseguir compilar e rodar o app fora do Windows.
#
# Funciona em qualquer máquina com Go: o daemon é Go puro
# (modernc.org/sqlite não usa cgo), então dá para cross-compilar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_DIR="$ROOT/printer/daemon"
OUT_DIR="$ROOT/frontend/src-tauri/binaries"

if ! command -v go >/dev/null 2>&1; then
  echo "Go 1.22+ é necessário para gerar o sidecar." >&2
  exit 1
fi

echo "==> go vet"
(cd "$DAEMON_DIR" && go vet ./...)

echo "==> go test"
(cd "$DAEMON_DIR" && go test ./...)

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/pdv-printer-daemon-*

# target-triple: nome-do-binário
build() {
  local goos="$1" goarch="$2" triple="$3" ext="$4"
  local out="$OUT_DIR/pdv-printer-daemon-$triple"
  [ -n "$ext" ] && out="$out.$ext"
  echo "==> compilando $triple"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
    -C "$DAEMON_DIR" -trimpath -ldflags "-s -w" -o "$out" .
  echo "    $out ($(du -h "$out" | cut -f1))"
}

# O Windows é o que vai no instalador da loja; os outros existem para o
# `cargo check`/`tauri dev` não quebrar em outras máquinas de desenvolvimento.
build windows amd64 x86_64-pc-windows-msvc exe
build linux   amd64 x86_64-unknown-linux-gnu ""
build darwin  arm64 aarch64-apple-darwin ""

echo "==> sidecars prontos em $OUT_DIR"
