#!/usr/bin/env bash
# ============================================================
# Build do app desktop (Tauri) em um comando.
# (Este script mora em `scripts/build/` — o build desktop ficou fora
# dos npm scripts do frontend.)
#
#   bash scripts/build/build-app.sh                  # build local (dev/teste)
#   bash scripts/build/build-app.sh --release        # build de entrega: exige chave
#   bash scripts/build/build-app.sh --bundles nsis   # só um tipo de instalador
#   bash scripts/build/build-app.sh --appimage-docker  # AppImage via container Debian
#
# O passo do sidecar do daemon de impressão SAIU deste build: o daemon saiu
# deste repositório (reescrita à parte) e o `externalBin` foi removido do
# tauri.conf.json, então o build não depende do daemon nem do Go. Retomar
# quando o novo daemon for embutido.
# ============================================================
set -euo pipefail

# Repo root: este arquivo está em `scripts/build/`, então sobe 2 níveis.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$ROOT/frontend"

source "$ROOT/scripts/lib/common.sh"
source "$ROOT/scripts/lib/build-tauri.sh"

RELEASE=0
BUNDLES=""
APPIMAGE_DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=1; shift ;;
    --bundles) BUNDLES="--bundles ${2:?--bundles precisa do tipo}"; shift 2 ;;
    --appimage-docker) APPIMAGE_DOCKER=1; shift ;;
    -h|--help) sed -n '3,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

cd "$FRONTEND"

# ---------- 0. Tools ----------
tauri_require_node

if [ ! -d node_modules ]; then
  echo "==> node_modules ausente, instalando dependências"
  npm ci
fi

# ---------- 1. Versões precisam bater ----------
# A versão do instalador vem do tauri.conf.json; o package.json é a outra
# fonte. Divergentes, o instalador sai com uma versão e o manifesto outra,
# e o update "não existe" sem erro nenhum. Melhor falhar aqui.
# O tauri.conf.json do app v1 NÃO declara `version` — o Tauri lê do Cargo.toml
# automaticamente. A versão é conferida contra o package.json (que o frontend
# usa para o PWA/manifest).
PKG_VERSION="$(node -p "require('./package.json').version")"
CONF_VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed 's/^version = "\(.*\)"$/\1/')"
if [ "$CONF_VERSION" != "$PKG_VERSION" ]; then
  echo "ERRO: Cargo.toml=$CONF_VERSION e package.json=$PKG_VERSION divergem." >&2
  echo "      Actualize os dois antes de buildar (a tag do CI tambem exige isso)." >&2
  exit 1
fi
echo "==> Versão: $CONF_VERSION"

# ---------- 2. Assinatura ----------
# Lógica canônica em scripts/lib/build-tauri.sh (tauri_resolve_signing).
LOCAL_KEY="$FRONTEND/src-tauri/.local-signing.key"
tauri_resolve_signing "$RELEASE" "$LOCAL_KEY" "pdv-local"

# ---------- 3. Build ----------
# O `tauri build` roda `npm run build` antes (beforeBuildCommand), então o
# frontend não precisa ser compilado separado.
#
# O AppImage é o único alvo que NÃO dá para gerar em toda distro. O
# `linuxdeploy` embute um `strip` antigo que não reconhece a seção `.relr.dyn`
# das libs do sistema — no Arch o build morre com "failed to run linuxdeploy".
# Não é problema do projeto, e o `.deb` sai normal na mesma máquina. Quando
# isso acontece, `--appimage-docker` empacota num debian:bookworm-slim
# (glibc 2.36), que é o mesmo AppImage que o CI gera.
tauri_parse_bundles "$BUNDLES" TAURI_ARGS

if [ "$APPIMAGE_DOCKER" -eq 1 ]; then
  command -v docker >/dev/null || { echo "--appimage-docker precisa de docker" >&2; exit 1; }
  IMAGE="pdv-desktop-build"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> Preparando a imagem de build ($IMAGE); so na primeira vez"
    docker build -t "$IMAGE" -f docker/Dockerfile.desktop .
  fi
  echo "==> AppImage em debian:bookworm-slim (compila o Rust de novo, demora)"
  # `-e VAR` sem valor repassa o valor do host: sem a chave o empacotador
  # dentro do container aborta no passo de update (ver secao 3).
  docker run --rm -v "$FRONTEND":/app -w /app \
    -e VITE_DEFAULT_SERVER="${VITE_DEFAULT_SERVER:-}" \
    -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    "$IMAGE" npx tauri build --bundles appimage
  # O container roda como root e deixa o target/ com dono root.
  docker run --rm -v "$FRONTEND/src-tauri/target":/t alpine chown -R "$(id -u):$(id -g)" /t
else
  echo "==> tauri build ${BUNDLES:-todos os alvos}"
  # `set -u` reclama de array vazio em bash < 4.4, e o caso "--release" sem
  # --bundles deixa a lista vazia de verdade.
  if [ ${#TAURI_ARGS[@]} -eq 0 ]; then
    npx tauri build
  else
    npx tauri build "${TAURI_ARGS[@]}"
  fi
fi

echo
# O caminho `src-tauri/target/release/bundle` está CORRETO aqui, e é o
# oposto do que vale para a família standalone — não "uniformize" os dois.
#
# Motivo: `frontend/src-tauri` é um crate AUTÔNOMO (não é member do workspace
# da raiz; a intenção está no `exclude` do `Cargo.toml` da raiz), então não
# existe workspace acima dele e o cargo compila no `target/` dele mesmo. Os
# crates `standalone-*` são MEMBERS daquele workspace e usam o `target/` da
# RAIZ — é o que o build-standalone.sh e o `env.BUNDLE_DIR` do
# build-desktop.yml fazem.
#
# ALERTA, bug ABERTO e FORA do escopo do conserto do caminho: o `exclude` do
# `Cargo.toml` da raiz está escrito DEPOIS da tabela `[workspace.package]`, e
# em TOML isso o torna chave de `[workspace.package]`, não de `[workspace]` —
# ou seja, o cargo nunca o viu. Consequência medida hoje: `cargo` dentro de
# frontend/src-tauri morre com "current package believes it's in a workspace
# when it's not". Confirmado com `tomllib` e reproduzido em workspace mínimo.
# Ou seja: este script hoje nem chega a compilar, por um motivo diferente do
# caminho do bundle. Não corrigido aqui (Cargo.toml da raiz está fora do
# escopo deste conserto) — quem corrigir for o `exclude` (mova para dentro de
# `[workspace]`) ou adicionar `[workspace]` vazio no src-tauri, o caminho
# acima passa a valer: `cargo metadata` de dentro de frontend/src-tauri então
# devolve "target_directory": "<repo>/frontend/src-tauri/target".
echo "==> Artefatos em src-tauri/target/release/bundle/"
tauri_list_artifacts "src-tauri/target/release/bundle"
echo
tauri_final_message "$RELEASE" "$CONF_VERSION"
