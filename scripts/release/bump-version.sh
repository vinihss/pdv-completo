#!/usr/bin/env bash
# Bump de versão da família standalone.
#
#   bash scripts/release/bump-version.sh 0.2.0
#
# Atualiza 2 arquivos:
#   1. Cargo.toml (raiz)     — [workspace.package] version
#   2. frontend/package.json — version
#
# O `package.json` da RAIZ (casa da CLI do Tauri, @tauri-apps/cli) NÃO entra
# nesta lista: ele não tem `version` e não é buildado — só congela a CLI.
#
# Os 4 apps standalone NÃO precisam de edição: eles herdam via
# `version.workspace = true` e o tauri.conf.json não declara `version`
# (o Tauri lê do Cargo.toml do crate automaticamente).
#
# O app v1 (frontend/src-tauri) tem ciclo de versão SEPARADO — bump manual
# no frontend/src-tauri/Cargo.toml quando precisar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ $# -ne 1 ]; then
  echo "Uso: $0 <nova-versão>" >&2
  echo "Ex.: bash scripts/release/bump-version.sh 0.2.0" >&2
  exit 1
fi

NEW_VERSION="$1"

# Valida formato semver simples (x.y.z)
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERRO: versão inválida '$NEW_VERSION'. Use o formato x.y.z (ex.: 0.2.0)." >&2
  exit 1
fi

echo "==> Bump da família standalone para $NEW_VERSION"

# 1. Cargo.toml (raiz) — workspace.package.version
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$ROOT/Cargo.toml"
echo "    Cargo.toml (workspace.package.version)"

# 2. frontend/package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$ROOT/frontend/package.json"
echo "    frontend/package.json"

echo
echo "Versão da família standalone atualizada para $NEW_VERSION."
echo "O app v1 (frontend/src-tauri) NÃO foi alterado — bump manual se precisar."
echo
echo "Próximos passos:"
echo "  git commit -am 'chore(release): bump standalone para $NEW_VERSION'"
echo "  git push origin main"

# DEPRECATED: Versionamento agora é automático via Semantic Release (Conventional Commits).
# Este script é mantido como fallback de emergência apenas.
# Ver: CONTRIBUTING.md, AGENTS.md
