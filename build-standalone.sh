#!/usr/bin/env bash
# ============================================================
# Build da família standalone (Tauri) em um comando.
#
#   bash build-standalone.sh --app pdv             # build local (dev/teste)
#   bash build-standalone.sh --app pdv --release   # build de entrega: exige chave
#   bash build-standalone.sh --app kds --bundles nsis
#
# Os 4 apps da família (pdv, kds, garcon, entregador) são crates
# independentes na raiz do repo, cada um com seu tauri.conf.json,
# seu Cargo.toml e seu target/release/bundle/. Este script deriva
# tudo a partir do --app e invoca a CLI de DENTRO do crate — da
# raiz, a busca por tauri.conf.json desce 3 níveis e acha
# frontend/src-tauri, buildando o app v1 em silêncio.
#
# O sidecar do daemon de impressão SAIU do build: `externalBin` saiu dos
# confs e o script de sidecar não existe mais (printer reestruturado).
#
# O app v1 (frontend/src-tauri, em produção) tem o seu próprio
# script: frontend/src-tauri/build-app.sh. Este arquivo não o substitui.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP=""
RELEASE=0
BUNDLES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:?--app precisa do nome: pdv|kds|garcon|entregador}"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    --bundles) BUNDLES="--bundles ${2:?--bundles precisa do tipo}"; shift 2 ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$APP" ]; then
  echo "ERRO: --app é obrigatório (pdv|kds|garcon|entregador)." >&2
  exit 1
fi

CRATE_DIR="$ROOT/standalone-$APP"
TAURI_CONF="$CRATE_DIR/tauri.conf.json"
CARGO_TOML="$CRATE_DIR/Cargo.toml"
LOCAL_KEY="$CRATE_DIR/.local-signing.key"
BUNDLE_DIR="$CRATE_DIR/target/release/bundle"

for f in "$TAURI_CONF" "$CARGO_TOML"; do
  [ -f "$f" ] || { echo "ERRO: $f não existe. --app válidos: pdv|kds|garcon|entregador." >&2; exit 1; }
done

# A CLI do Tauri mora em node_modules/ na RAIZ do repo (o package.json da raiz
# congela a versão e o $schema dos confs aponta para lá). Os crates não têm
# node_modules próprio, então o caminho é explícito — `npx tauri` de dentro do
# crate não acha o binário.
TAURI_CLI="$ROOT/node_modules/.bin/tauri"

# ---------- 0. Tools ----------
command -v node >/dev/null || { echo "Node 20+ é necessário." >&2; exit 1; }

# 0a. CLI do Tauri na raiz: package.json + package-lock.json do repo.
if [ ! -x "$TAURI_CLI" ]; then
  echo "==> CLI do Tauri ausente na raiz, instalando dependências"
  (cd "$ROOT" && npm ci)
fi
[ -x "$TAURI_CLI" ] || { echo "ERRO: $TAURI_CLI não existe mesmo após npm ci." >&2; exit 1; }

# 0b. Dependências do frontend: o beforeBuildCommand dos confs roda
# `npm run build:<perfil>` em frontend/ (Vite), então este node_modules continua
# obrigatório mesmo com a CLI na raiz.
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "==> node_modules do frontend ausente, instalando dependências"
  (cd "$ROOT/frontend" && npm ci)
fi

# ---------- 1. Versão ----------
# Os tauri.conf.json da família standalone NÃO declaram `version` — o Tauri lê
# do Cargo.toml do crate automaticamente. A versão é herdada do workspace
# (version.workspace = true), então basta conferir o Cargo.toml.
PKG_VERSION="$(grep -m1 '^version = ' "$CARGO_TOML" | sed 's/^version = "\(.*\)"$/\1/')"
echo "==> Versão: $PKG_VERSION (do Cargo.toml)"

# ---------- 2. Assinatura ----------
# O empacotador do Tauri 2 assina o artefato de update SEMPRE que
# `plugins.updater.pubkey` está no tauri.conf.json — e não há flag de config
# que desligue isso. Sem TAURI_SIGNING_PRIVATE_KEY o build local TERMINA
# COM ERRO, mesmo tendo gerado o instalador.
#
# Então o build local gera uma chave descartável na máquina. Ela serve só para
# o script sair com status 0: um instalador assinado com essa chave NÃO é
# aceito pelo updater do app, porque a pubkey real está no conf. Entrega
# sempre com a chave de verdade (--release).
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
    if [ ! -f "$LOCAL_KEY" ]; then
      echo "==> Gerando chave de assinatura local (descartavel)"
      "$TAURI_CLI" signer generate -w "$LOCAL_KEY" -p "pdv-local-$APP" --force >/dev/null
    fi
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$LOCAL_KEY")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="pdv-local-$APP"
    echo "==> Chave local em uso. O instalador deste build NAO atualiza"
    echo "    nenhum app real (a pubkey do conf é outra). Isso é esperado"
    echo "    em build de desenvolvimento."
  fi
fi

# ---------- 3. Build ----------
# O `tauri build` roda o `beforeBuildCommand` do conf antes (que compila o
# frontend), então o frontend não precisa ser compilado separado.
#
# O Tauri 2 executa o beforeBuildCommand com CWD = frontend_dir (derivado do
# frontendDist do conf). Para os confs da família standalone, frontendDist é
# ../frontend/dist/<profile>, então frontend_dir = caminho absoluto para
# frontend/. O `cd ../frontend` dos confs é, portanto, correto: de frontend/,
# `cd ../frontend` → frontend/ (no-op). Nenhum override é necessário.
echo "==> tauri build ${BUNDLES:-todos os alvos} (em $CRATE_DIR)"
cd "$CRATE_DIR"
TAURI_ARGS=()
[ -n "$BUNDLES" ] && TAURI_ARGS+=($BUNDLES)
if [ ${#TAURI_ARGS[@]} -eq 0 ]; then
  "$TAURI_CLI" build
else
  "$TAURI_CLI" build "${TAURI_ARGS[@]}"
fi

echo
echo "==> Artefatos em $BUNDLE_DIR/"
find "$BUNDLE_DIR" -maxdepth 2 \( -name '*.exe*' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.sig' -o -name '*.json' \) 2>/dev/null \
  | sed 's|^|    |'
echo
if [ "$RELEASE" -eq 1 ]; then
  echo "Para publicar: suba a tag v$PKG_VERSION (o CI assina e publica), ou dispare"
  echo "o workflow 'Instalador Windows (Tauri)' na aba Actions para gerar so o instalador."
else
  echo "Isto NÃO é build de entrega. Para publicar, use --release e a tag."
fi
