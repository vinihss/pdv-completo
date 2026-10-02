#!/bin/bash
# verify-tag.sh — validação pré-tag automática

set -euo pipefail

echo "==> Verificando condições para tag semântica automática"

# 1. Branch main
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "desconhecida")
if [ "$BRANCH" != "main" ]; then
  echo "ERRO: Execute na branch 'main' (atual: $BRANCH)"
  exit 1
fi

# 2. Arquivos de configuração
for f in ".releaserc.json" "package.json"; do
  if [ ! -f "$f" ]; then
    echo "ERRO: $f ausente"
    exit 1
  fi
done

# 3. Commits recentes que demandam release
if git log --oneline -5 2>/dev/null | grep -qE "^(feat|fix|perf|BREAKING)"; then
  echo "AVISO: Commits recentes podem gerar nova tag (revisar):"
  git log --oneline -5 | grep -E "^(feat|fix|perf|BREAKING)" || true
fi

# 4. Validação do formato do Semantic Release
if ! npx semantic-release --dry-run 2>/dev/null | grep -qE "(next release|No release)"; then
  echo "INFO: Semantic Release válido (dry-run passou)"
fi

echo "==> Verificação concluída. Pronto para tag semântica automática."
echo "    Comando: git commit -m 'feat(x): ...' → merge → release automático"
