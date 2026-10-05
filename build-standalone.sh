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
source "$ROOT/scripts/lib/common.sh"

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
  die "--app é obrigatório (pdv|kds|garcon|entregador)."
fi

CRATE_DIR="$ROOT/standalone-$APP"
TAURI_CONF="$CRATE_DIR/tauri.conf.json"
CARGO_TOML="$CRATE_DIR/Cargo.toml"
LOCAL_KEY="$CRATE_DIR/.local-signing.key"
BUNDLE_DIR="$CRATE_DIR/target/release/bundle"

for f in "$TAURI_CONF" "$CARGO_TOML"; do
  [ -f "$f" ] || die "$f não existe. --app válidos: pdv|kds|garcon|entregador."
done

# A CLI do Tauri mora em node_modules/ na RAIZ do repo (o package.json da raiz
# congela a versão e o $schema dos confs aponta para lá). Os crates não têm
# node_modules próprio, então o caminho é explícito — `npx tauri` de dentro do
# crate não acha o binário.
TAURI_CLI="$ROOT/node_modules/.bin/tauri"

# ---------- 0. Tools ----------
require_cmd node

# 0a. CLI do Tauri na raiz: package.json + package-lock.json do repo.
if [ ! -x "$TAURI_CLI" ]; then
  log "==> CLI do Tauri ausente na raiz, instalando dependências"
  (cd "$ROOT" && npm ci)
fi
[ -x "$TAURI_CLI" ] || die "$TAURI_CLI não existe mesmo após npm ci."

# 0b. Dependências do frontend: o beforeBuildCommand dos confs roda
# `npm run build:<perfil>` em frontend/ (Vite), então este node_modules continua
# obrigatório mesmo com a CLI na raiz.
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  log "==> node_modules do frontend ausente, instalando dependências"
  (cd "$ROOT/frontend" && npm ci)
fi

# ---------- 1. Versão ----------
# Os tauri.conf.json da família standalone NÃO declaram `version` — o Tauri lê
# do Cargo.toml do crate automaticamente. A versão do crate, porém, aparece de
# duas formas possíveis e o script precisa resolver as duas:
#
#   a) `version = "x.y.z"` literal em [package] — usada direto;
#   b) `version.workspace = true` (o caso dos 4 crates standalone) — a versão
#      NÃO está no manifesto do crate: ela mora em [workspace.package] do
#      Cargo.toml da RAIZ do repo e só pode ser lida de lá.
#
# O casamento é por seção TOML, nunca por "primeira linha que casar": um
# `version` de [dependencies] (ou de outra seção) não vale, e no root só
# [workspace.package] conta. Caso nenhuma das duas formas resolva, o script
# aborta com erro: versão vazia viraria "suba a tag v" na mensagem final do
# --release e um instalador publicado com a versão errada.

toml_value() {
  # Imprime o valor bruto da chave $3 dentro da seção $2 do arquivo $1.
  # Comentários são ignorados e a chave é comparada por igualdade EXATA, então
  # `version` não casa `version.workspace` (nem o contrário) e a seção vizinha
  # nunca contamina o resultado.
  awk -v want_sec="$2" -v want_key="$3" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ {
      sec = $0
      sub(/^[[:space:]]*\[/, "", sec)
      sub(/\].*$/, "", sec)
      cur = sec
      next
    }
    {
      eq = index($0, "=")
      if (!eq) next
      key = substr($0, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (cur != want_sec || key != want_key) next
      val = substr($0, eq + 1)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+$/, "", val)
      print val
      exit
    }
  ' "$1"
}

resolve_pkg_version() {
  # resolve_pkg_version <Cargo.toml do crate> <Cargo.toml da raiz do repo>
  # → imprime a versão; falha (return != 0, mensagem em stderr) se não resolver.
  local crate_toml="$1" root_toml="$2" v

  # (a) literal em [package]
  v="$(toml_value "$crate_toml" package version)"
  if [ -n "$v" ]; then
    case "$v" in
      \"[0-9]*\")
        v="${v#\"}"
        v="${v%\"}"
        printf '%s\n' "$v"
        return 0
        ;;
      *)
        echo "ERRO: \`version\` de [package] em $crate_toml não é literal \"x.y.z\": $v" >&2
        return 1
        ;;
    esac
  fi

  # (b) herança do workspace → a versão mora no Cargo.toml da raiz
  v="$(toml_value "$crate_toml" package version.workspace)"
  if [ "$v" = "true" ]; then
    if [ ! -f "$root_toml" ]; then
      echo "ERRO: $crate_toml usa version.workspace = true, mas $root_toml não existe." >&2
      return 1
    fi
    v="$(toml_value "$root_toml" workspace.package version)"
    case "$v" in
      \"[0-9]*\")
        v="${v#\"}"
        v="${v%\"}"
        printf '%s\n' "$v"
        return 0
        ;;
      *)
        echo "ERRO: $crate_toml herda a versão do workspace, mas [workspace.package] de $root_toml não tem um version = \"x.y.z\" válido (achado: ${v:-<nada>})." >&2
        return 1
        ;;
    esac
  fi

  echo "ERRO: [package] de $crate_toml não declara version = \"x.y.z\" nem version.workspace = true; não há como resolver a versão." >&2
  return 1
}

PKG_VERSION="$(resolve_pkg_version "$CARGO_TOML" "$ROOT/Cargo.toml")" || {
  die "não foi possível resolver a versão a partir de $CARGO_TOML (motivo acima)."
}
log "==> Versão: $PKG_VERSION (do Cargo.toml)"

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
  log "==> Assinatura: chave e senha presentes"
else
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    if [ ! -f "$LOCAL_KEY" ]; then
      log "==> Gerando chave de assinatura local (descartavel)"
      "$TAURI_CLI" signer generate -w "$LOCAL_KEY" -p "pdv-local-$APP" --force >/dev/null
    fi
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$LOCAL_KEY")"
    export TAURI_SIGNING_PRIVATE_KEY
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="pdv-local-$APP"
    log "==> Chave local em uso. O instalador deste build NAO atualiza"
    echo "    nenhum app real (a pubkey do conf é outra). Isso é esperado"
    echo "    em build de desenvolvimento."
  fi
fi

# ---------- 3. Build ----------
# O `tauri build` roda o `beforeBuildCommand` do conf antes (que compila o
# frontend), então o frontend não precisa ser compilado separado.
#
# O CWD do beforeBuildCommand NÃO vem do frontendDist — vem da resolução de
# `frontend_dir` da CLI, nesta ordem: (1) TAURI_FRONTEND_PATH, se definida;
# (2) o cwd de onde a CLI foi chamada, se tiver package.json ali ou embaixo
# (depth 3); (3) senão, o PAI do crate. O crate não tem package.json e o
# package.json está ACIMA dele, então sem o export o hook rodaria na RAIZ do
# repo e `cd ../frontend` dos confs apontaria para fora do repo, morrendo com
# "The system cannot find the path specified" (foi exatamente o que quebrou o
# build-desktop do CI nas tags v1.0.15/v1.0.16). Fixado aqui, o cwd vira
# <repo>/frontend e `cd ../frontend` vira no-op — que é o que os confs e este
# script sempre assumiram. O CI faz o mesmo em build-desktop.yml.
export TAURI_FRONTEND_PATH="$ROOT/frontend"

log "==> tauri build ${BUNDLES:-todos os alvos} (em $CRATE_DIR)"
cd "$CRATE_DIR"
TAURI_ARGS=()
[ -n "$BUNDLES" ] && read -ra TAURI_ARGS <<< "$BUNDLES"
if [ ${#TAURI_ARGS[@]} -eq 0 ]; then
  "$TAURI_CLI" build
else
  "$TAURI_CLI" build "${TAURI_ARGS[@]}"
fi

echo
log "==> Artefatos em $BUNDLE_DIR/"
find "$BUNDLE_DIR" -maxdepth 2 \( -name '*.exe*' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.sig' -o -name '*.json' \) 2>/dev/null \
  | sed 's|^|    |'
echo
if [ "$RELEASE" -eq 1 ]; then
  echo "Para publicar: suba a tag v$PKG_VERSION (o CI assina e publica), ou dispare"
  echo "o workflow 'Instalador Windows (Tauri)' na aba Actions para gerar so o instalador."
else
  echo "Isto NÃO é build de entrega. Para publicar, use --release e a tag."
fi
