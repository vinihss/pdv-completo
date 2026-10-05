#!/usr/bin/env bash
# printer/scripts/package-daemon-linux.sh
# Gera pacote .tar.gz para Linux (amd64) contendo:
#   - binário compilado (pdv-printer-daemon)
#   - scripts/install-linux.sh
#   - templates/
#   - docs/ (CUPLINUX.md, WEB_AUTOMATIC_PRINT.md, Revisão do daemon de impressão.md)
#   - README.md (versão atualizada)
#   - config.example.json
#   - README.md (atualizado com instruções de instalação)
#   - README.md (atualizado com seção de instalação rápida)
#
# Uso:
#   bash printer/scripts/package-daemon-linux.sh [versão]
# Exemplo: bash printer/scripts/package-daemon-linux.sh 1.1.0
#
# O script compila o binário (se não existir), cria os arquivos necessários,
# e empacota em printer/artifacts/pdv-printer-daemon-<versão>-linux-amd64.tar.gz.
#
# O binário é compilado com:
#   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o pdv-printer-daemon
#
# O script é idempotente e limpa a pasta de build antes de compilar.
set -euo pipefail

# Parse version argument (optional)
VERSION="${1:-v1.0.0}"
ARTIFACTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/artifacts"
mkdir -p "$ARTIFACTS_DIR"

# Diretórios principais
DAEMON_DIR="$(cd "$(dirname "$0")/../daemon" && pwd)"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCS_DIR="$(cd "$(dirname "$0")/../docs" && pwd)"
ROOT_DIR="$(pwd)"

# -----------------------------------------------------------------
# 1. Compilar o binário (se não existir)
# -----------------------------------------------------------------
BINARY_NAME="pdv-printer-daemon"
BINARY_PATH="$ARTIFACTS_DIR/$BINARY_NAME"

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "=== Compilando binário (sem Go no destino) ==="
  cd "$DAEMON_DIR"
  go build -trimpath -ldflags='-s -w' -o "$BINARY_PATH" .
  if [[ ! -f "$BINARY_PATH" ]]; then
    echo "ERRO: falha ao compilar $BINARY_NAME"
    exit 1
  }
  echo "Binário compilado: $BINARY_PATH"
else
  echo "Binário já existe: $BINARY_PATH"
fi

# -----------------------------------------------------------------
# 2. Preparar diretório de pacote
# -----------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
PACKAGE_DIR="$ARTIFACTS_DIR/pdv-printer-daemon-$VERSION-linux-amd64"
rm -rf "$PACKAGE_DIR"

# Copiar binário
cp -f "$BINARY_PATH" "$PACKAGE_DIR/"

# Copiar scripts e docs
cp -r "$SCRIPTS_DIR" "$PACKAGE_DIR/"
cp -r "$DOCS_DIR" "$PACKAGE_DIR/"
cp -f "$ROOT/daemon/README.md" "$PACKAGE_DIR/"

# Copiar config.example.json (não versionado)
cp -f "$ROOT/daemon/config.example.json" "$PACKAGE_DIR/"

# Copiar templates (não versionados)
cp -r "$ROOT/daemon/templates" "$PACKAGE_DIR/"

# -----------------------------------------------------------------
# 5. Empacotar
# -----------------------------------------------------------------
cd "$ARTIFACTS_DIR"
tar -czf "pdv-printer-daemon-$VERSION-linux-amd64.tar.gz" -C "$PACKAGE_DIR" .

# -----------------------------------------------------------------
# 6. Verificação rápida
# -----------------------------------------------------------------
echo "=== Verificando pacote ==="
tar -tzf "pdv-printer-daemon-$VERSION-linux-amd64.tar.gz" | sort | head -20 | head -5
echo "=== Verificando assinatura (se .sha256 existir) ==="
if [[ -f "$ARTIFACTS_DIR/pdv-printer-daemon-$VERSION-linux-amd64.tar.gz.sha256" ]]; then
  sha256sum -c "pdv-printer-daemon-$VERSION-linux-amd64.tar.gz.sha256" 2>/dev/null || {
    echo "⚠️  Assinatura inválida (falta ou invalida)."
    exit 1
  }
  echo "✅ Assinatura válida"
fi

echo "=== Pacote criado: pdv-printer-daemon-$VERSION-linux-amd64.tar.gz ==="
echo "Descompacte para testar:"
echo "  tar -xzf pdv-printer-daemon-$VERSION-linux-amd64.tar.gz -C /tmp/pdv-test"
echo "cd /tmp/pdv-test && ./scripts/install-linux.sh"
echo "E depois: sudo ./scripts/install-linux.sh"
exit 0