#!/usr/bin/env bash
# ============================================================
# lib/build-tauri.sh — lógica de build Tauri compartilhada.
#
# Uso (de dentro de scripts/build/):
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/build-tauri.sh"
#
# Requer scripts/lib/common.sh JÁ sourceado (a lib usa log e die).
# Não usa `set -e` aqui de propósito — quem sourceia decide o
# modo do shell (normalmente `set -euo pipefail`).
#
# Funções:
#   tauri_require_node                       — node disponível?
#   tauri_resolve_signing <release> <key> <pass_prefix>
#   tauri_parse_bundles "<--bundles ...>" <array_name>
#   tauri_list_artifacts <bundle_dir>
#   tauri_final_message <release> <versão>
# ============================================================

tauri_require_node() {
  command -v node >/dev/null 2>&1 || die "Node 20+ é necessário."
}

# tauri_resolve_signing <release_flag> <local_key_path> <password_prefix>
#
# O empacotador do Tauri 2 assina o artefato de update SEMPRE que
# `plugins.updater.pubkey` está no tauri.conf.json — e não há flag de config
# que desligue isso. Sem TAURI_SIGNING_PRIVATE_KEY o build local TERMINA
# COM ERRO, mesmo tendo gerado o instalador.
#
# Então o build local gera uma chave descartável na máquina. Ela serve só para
# o script sair com status 0: um instalador assinado com essa chave NÃO é
# aceito pelo updater do app, porque a pubkey real está no conf. Entrega
# sempre com a chave de verdade (--release).
#
# O comando do CLI é $TAURI_CLI se o chamador definiu (build-standalone, que
# roda de dentro do crate e não acharia o binário via npx), senão `npx tauri`
# (build-app, que roda de dentro de frontend/).
tauri_resolve_signing() {
  local release_flag="$1" local_key_path="$2" password_prefix="$3"
  local -a cli

  if [ "$release_flag" -eq 1 ]; then
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
    return 0
  fi

  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    if [ -n "${TAURI_CLI:-}" ]; then
      cli=("$TAURI_CLI")
    else
      cli=(npx tauri)
    fi
    if [ ! -f "$local_key_path" ]; then
      log "==> Gerando chave de assinatura local (descartavel)"
      "${cli[@]}" signer generate -w "$local_key_path" -p "$password_prefix" --force >/dev/null
    fi
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$local_key_path")"
    export TAURI_SIGNING_PRIVATE_KEY
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$password_prefix"
    log "==> Chave local em uso. O instalador deste build NAO atualiza"
    echo "    nenhum app real (a pubkey do conf é outra). Isso é esperado"
    echo "    em build de desenvolvimento."
  fi
}

# tauri_parse_bundles <bundles_string> <array_name>
#
# Parseia o valor de --bundles ("--bundles nsis" ou "") para um array bash,
# usando `read -ra`. O array é criado no escopo do CHAMADOR, referenciado
# pelo nome em <array_name> (nameref — requer bash 4.3+).
tauri_parse_bundles() {
  local -n _tauri_args="$2"
  _tauri_args=()
  if [ -n "$1" ]; then
    read -ra _tauri_args <<< "$1"
  fi
}

# tauri_list_artifacts <bundle_dir>
#
# Lista os artefatos do bundle (.exe*, .deb, .AppImage, .sig, .json) com
# find + sed, um por linha, indentado 4 espaços.
tauri_list_artifacts() {
  find "$1" -maxdepth 2 \( \
    -name '*.exe*' -o \
    -name '*.deb' -o \
    -name '*.AppImage' -o \
    -name '*.sig' -o \
    -name '*.json' \
  \) 2>/dev/null | sed 's|^|    |'
}

# tauri_final_message <release_flag> <version>
#
# Mensagem final: como publicar (release) ou aviso de não-entrega (local).
tauri_final_message() {
  if [ "$1" -eq 1 ]; then
    echo "Para publicar: suba a tag v$2 (o CI assina e publica), ou dispare"
    echo "o workflow 'Instalador Windows (Tauri)' na aba Actions para gerar so o instalador."
  else
    echo "Isto NÃO é build de entrega. Para publicar, use --release e a tag."
  fi
}
