#!/usr/bin/env bash
# printer/scripts/package-daemon-linux.sh
#
# Gera o pacote de entrega do daemon para Linux (amd64):
#
#   printer/artifacts/pdv-printer-daemon-<versão>-linux-amd64.tar.gz
#   printer/artifacts/pdv-printer-daemon-<versão>-linux-amd64.tar.gz.sha256
#
# O pacote leva o binário JÁ COMPILADO: a máquina de destino não precisa de Go.
# Quem instala é o `install-linux.sh`, que roda a partir do diretório descompactado.
#
# Uso:
#   bash printer/scripts/package-daemon-linux.sh [versão]
# Exemplo: bash printer/scripts/package-daemon-linux.sh 1.1.0
#
# Idempotente: o tar é reescrito a cada execução, o diretório intermediário é
# removido antes de ser recriado.
set -euo pipefail

VERSION="${1:-v0.0.0-dev}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRINTER_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
DAEMON_DIR="$PRINTER_DIR/daemon"
ARTIFACTS_DIR="$PRINTER_DIR/artifacts"

TARBALL="pdv-printer-daemon-$VERSION-linux-amd64.tar.gz"

if ! command -v go >/dev/null 2>&1; then
  echo "ERRO: Go é necessário para COMPILAR o pacote (não para instalá-lo)." >&2
  exit 1
fi

mkdir -p "$ARTIFACTS_DIR"

# -----------------------------------------------------------------
# 1. Compilar o binário
# -----------------------------------------------------------------
echo "==> Compilando o daemon (CGO_ENABLED=0 GOOS=linux GOARCH=amd64)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

BINARY="$STAGE/$VERSION/pdv-printer-daemon"
mkdir -p "$(dirname "$BINARY")"
(
  cd "$DAEMON_DIR"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w' -o "$BINARY" .
)
[[ -f "$BINARY" ]] || { echo "ERRO: go build não produziu o binário." >&2; exit 1; }
echo "    $(du -h "$BINARY" | cut -f1)  pdv-printer-daemon"

# -----------------------------------------------------------------
# 2. Montar a árvore do pacote
# -----------------------------------------------------------------
PKG="$STAGE/pkg"
mkdir -p "$PKG/daemon"

cp "$BINARY" "$PKG/daemon/pdv-printer-daemon"
cp -r "$DAEMON_DIR/templates" "$PKG/daemon/templates"
cp "$DAEMON_DIR/config.example.json" "$PKG/daemon/config.example.json"

# O instalador precisa estar junto do binário: o install-linux.sh compila a
# partir de "$ROOT/daemon" quando não acha o binário pronto, e usa
# "$ROOT/daemon/templates" como origem dos templates.
mkdir -p "$PKG/scripts"
cp "$SCRIPTS_DIR/install-linux.sh" "$PKG/scripts/install-linux.sh"
chmod +x "$PKG/scripts/install-linux.sh"

cp "$PRINTER_DIR/README.md" "$PKG/README.md"
cp "$PRINTER_DIR/MANIFEST.txt" "$PKG/MANIFEST.txt"

if [[ -d "$PRINTER_DIR/docs" ]]; then
  cp -r "$PRINTER_DIR/docs" "$PKG/docs"
fi

# -----------------------------------------------------------------
# 3. Empacotar +_checksum_
# -----------------------------------------------------------------
echo "==> Empacotando"
tar -czf "$ARTIFACTS_DIR/$TARBALL" -C "$PKG" .

(
  cd "$ARTIFACTS_DIR"
  sha256sum "$TARBALL" > "$TARBALL.sha256"
)

# -----------------------------------------------------------------
# 4. Verificar o pacote gerado
# -----------------------------------------------------------------
echo "==> Verificando"
tar -tzf "$ARTIFACTS_DIR/$TARBALL" >/dev/null   # gzip íntegro
(
  cd "$ARTIFACTS_DIR"
  sha256sum -c "$TARBALL.sha256" >/dev/null
) || { echo "ERRO: checksum do pacote não confere." >&2; exit 1; }

# O listing vai para uma variável, sem pipeline: `tar -tzf ... | grep -q` é o
# combo que quebrou o build-daemon no CI. O `grep -q` sai no primeiro match e
# fecha o pipe, o tar leva SIGPIPE (141) e o `pipefail` transforma isso em
# falha do script — que então accuse um pacote que está correto. Depende só de
# a ordem que o `tar` grava os diretórios (readdir), não do tamanho do pacote:
# com o binário listado primeiro, o grep fecha o pipe com o tar ainda
# escrevendo e falha sempre; listado por último, o tar já terminou e passa.
# Uma vez em variável, o teste não tem pipe nenhum: nem `tar | grep`, nem
# `printf | grep` (esse também morreria de SIGPIPE num listing grande, porque
# o `grep -q` fecharia o pipe com o printf ainda escrevendo). O `[[ =~ ]]` é do
# bash puro e casa linha a linha. O `tar -tzf` emite com prefixo `./`, então o
# padrão casa as duas formas.
LISTING="$(tar -tzf "$ARTIFACTS_DIR/$TARBALL")"
NL=$'\n'
RE_DAEMON="(^|$NL)(\./)?daemon/pdv-printer-daemon($NL|$)"

if [[ ! "$LISTING" =~ $RE_DAEMON ]]; then
  echo "ERRO: o pacote saiu sem o binário do daemon." >&2
  exit 1
fi

echo "    conteúdo:"
if [[ -n "$LISTING" ]]; then
  while IFS= read -r linha; do echo "      $linha"; done <<< "$LISTING"
fi

echo
echo "Pacote pronto:"
echo "  $ARTIFACTS_DIR/$TARBALL  ($(du -h "$ARTIFACTS_DIR/$TARBALL" | cut -f1))"
echo "  $ARTIFACTS_DIR/$TARBALL.sha256"
echo
echo "Instalar na máquina de destino (sem Go, sem sudo para extrair):"
echo "  sha256sum -c $TARBALL.sha256"
echo "  tar -xzf $TARBALL -C /opt/pdv-printer --strip-components=1"
echo "  sudo /opt/pdv-printer/scripts/install-linux.sh"
