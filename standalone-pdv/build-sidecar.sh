#!/usr/bin/env bash
# ============================================================
# Sidecar do daemon de impressão para o app da FRENTE DE CAIXA.
#
#   ./build-sidecar.sh
#
# Não é uma segunda implementação: `printer/scripts/build-sidecar.sh` é quem
# compila o daemon (Go puro, roda `go vet` e `go test` antes) e escreve o
# resultado em `frontend/src-tauri/binaries/`. Este wrapper só copia os três
# binários para `standalone-pdv/binaries/`, que é onde o `externalBin` deste
# crate aponta.
#
# Ele existe porque o `build.rs` (via `tauri_build`) ABORTA quando o sidecar do
# target atual não está em `binaries/` — ou seja, sem este passo nem `cargo
# check` roda. E porque o alvo do produto é o Windows: o `.exe` daqui é o que
# entra no instalador NSIS, e não o do app antigo, mesmo sendo o mesmo binário.
#
# Quando `printer/scripts/build-sidecar.sh` aceitar um diretório de saída
# (`--out-dir` ou equivalente), este arquivo pode ser apagado e o build de
# entrega passa a chamar o script direto com o destino de cada app.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/frontend/src-tauri/binaries"
DST_DIR="$ROOT/standalone-pdv/binaries"

command -v go >/dev/null || { echo "Go 1.22+ é necessário para gerar o sidecar." >&2; exit 1; }

echo "==> Gerando o sidecar do daemon (roda o script da repo)"
bash "$ROOT/printer/scripts/build-sidecar.sh"

mkdir -p "$DST_DIR"
copiado=0
for bin in "$SRC_DIR"/pdv-printer-daemon-*; do
  [ -e "$bin" ] || continue
  cp "$bin" "$DST_DIR/"
  copiado=$((copiado + 1))
done

if [ "$copiado" -eq 0 ]; then
  echo "ERRO: $SRC_DIR não tem nenhum pdv-printer-daemon-*." >&2
  echo "      O build-sidecar.sh da repo mudou? Sem sidecar, o cargo check deste crate não roda." >&2
  exit 1
fi

echo "==> $copiado binário(s) em $DST_DIR"
ls -1 "$DST_DIR"
