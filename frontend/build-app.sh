#!/usr/bin/env bash
# ============================================================
# Build do app desktop (Tauri) em um comando.
#
#   bash build-app.sh                  # build local (dev/teste)
#   bash build-app.sh --release        # build de entrega: exige chave
#   bash build-app.sh --bundles nsis   # só um tipo de instalador
#   bash build-app.sh --appimage-docker  # AppImage via container Debian
#
# O passo que ninguém pode esquecer é o sidecar: o `tauri.conf.json`
# declara `externalBin: ["binaries/pdv-printer-daemon"]` e o `build.rs`
# ABORTA se o binário da plataforma atual não existir. Sem o sidecar gerado,
# nem `cargo check` roda. Por isso ele é o primeiro passo aqui, e não uma
# instrução solta no README.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"

RELEASE=0
BUNDLES=""
APPIMAGE_DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=1; shift ;;
    --bundles) BUNDLES="--bundles ${2:?--bundles precisa do tipo}"; shift 2 ;;
    --appimage-docker) APPIMAGE_DOCKER=1; shift ;;
    -h|--help) sed -n '3,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

cd "$FRONTEND"

# ---------- 0. Tools ----------
command -v node >/dev/null || { echo "Node 20+ é necessário." >&2; exit 1; }
command -v go   >/dev/null || { echo "Go 1.22+ é necessário (daemon de impressão)." >&2; exit 1; }

if [ ! -d node_modules ]; then
  echo "==> node_modules ausente, instalando dependências"
  npm ci
fi

# ---------- 1. Sidecar do daemon ----------
# Cross-compila (Windows/Linux/macOS) e roda `go test` antes.
echo "==> Gerando o sidecar do daemon de impressão"
bash "$ROOT/printer/scripts/build-sidecar.sh"

# ---------- 2. Versões precisam bater ----------
# A versão do instalador vem do tauri.conf.json; o package.json é a outra
# fonte. Divergentes, o instalador sai com uma versão e o manifesto outra,
# e o update "não existe" sem erro nenhum. Melhor falhar aqui.
CONF_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
PKG_VERSION="$(node -p "require('./package.json').version")"
if [ "$CONF_VERSION" != "$PKG_VERSION" ]; then
  echo "ERRO: tauri.conf.json=$CONF_VERSION e package.json=$PKG_VERSION divergem." >&2
  echo "      Actualize os dois antes de buildar (a tag do CI tambem exige isso)." >&2
  exit 1
fi
echo "==> Versão: $CONF_VERSION"

# ---------- 3. Assinatura (só em entrega) ----------
# O updater REJEITA artefato sem assinatura válida, então um build de
# entrega sem chave é inútil: sai um instalador que nenhum app atualiza.
# Em build local seguimos sem chave (e avisamos), porque serve para
# conferir se o app abre.
if [ "$RELEASE" -eq 1 ]; then
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
    cat >&2 <<'MSG'
ERRO: build de entrega sem chave de assinatura.

    export TAURI_SIGNING_PRIVATE_KEY="$(cat /caminho/seguro/pdv-updater.key)"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat /caminho/seguro/senha)"

A senha nao e opcional: sem ela o CLI tenta perguntar por prompt e morre,
porque o runner (e este script) nao tem terminal.
MSG
    exit 1
  fi
  echo "==> Assinatura: chave e senha presentes"
else
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "==> AVISO: sem TAURI_SIGNING_PRIVATE_KEY. Build local sem assinatura."
    echo "    O instalador sai, mas nenhum app consegue atualizar por ele."
  fi
fi

# ---------- 4. Build ----------
# O `tauri build` roda `npm run build` antes (beforeBuildCommand), então o
# frontend não precisa ser compilado separado.
#
# O AppImage é o único alvo que NÃO dá para gerar em toda distro. O
# `linuxdeploy` embute um `strip` antigo que não reconhece a seção `.relr.dyn`
# das libs do sistema — no Arch o build morre com "failed to run linuxdeploy".
# Não é problema do projeto, e o `.deb` sai normal na mesma máquina. Quando
# isso acontece, `--appimage-docker` empacota num debian:bookworm-slim
# (glibc 2.36), que é o mesmo AppImage que o CI gera.
if [ "$APPIMAGE_DOCKER" -eq 1 ]; then
  command -v docker >/dev/null || { echo "--appimage-docker precisa de docker" >&2; exit 1; }
  IMAGE="pdv-desktop-build"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> Preparando a imagem de build ($IMAGE); só na primeira vez"
    docker build -t "$IMAGE" -f docker/Dockerfile.desktop .
  fi
  echo "==> AppImage em debian:bookworm-slim (compila o Rust de novo, demora)"
  docker run --rm -v "$FRONTEND":/app -w /app \
    -e VITE_DEFAULT_SERVER="${VITE_DEFAULT_SERVER:-}" "$IMAGE" \
    npx tauri build --bundles appimage
  # O container roda como root e deixa o target/ com dono root.
  docker run --rm -v "$FRONTEND/src-tauri/target":/t alpine chown -R "$(id -u):$(id -g)" /t
  BUNDLES=""
else
  echo "==> tauri build ${BUNDLES:-todos os alvos}"
  # shellcheck disable=SC2086
  npx tauri build $BUNDLES
fi

echo
echo "==> Artefatos em src-tauri/target/release/bundle/"
find src-tauri/target/release/bundle -maxdepth 2 -name '*.exe*' -o -maxdepth 2 -name '*.deb' -o -maxdepth 2 -name '*.AppImage' -o -maxdepth 2 -name '*.sig' 2>/dev/null \
  | sed 's|^|    |'
echo
if [ "$RELEASE" -eq 1 ]; then
  echo "Para publicar: suba a tag v$CONF_VERSION (o CI assina e publica), ou dispare"
  echo "o workflow 'Instalador Windows (Tauri)' na aba Actions para gerar so o instalador."
else
  echo "Isto NÃO é build de entrega. Para publicar, use --release e a tag."
fi
