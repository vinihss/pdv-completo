#!/usr/bin/env bash
set -Eeuo pipefail

# Aplica a fundação de ports previamente definida por create-application-ports.sh.
# Não reescreve use cases: a árvore atual ainda não tem adapters Postgres compatíveis
# nem TenantContext com mapeamento imutável para tenant/schema.

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
cd "$ROOT"

GENERATOR="$ROOT/scripts/refactor/create-application-ports.sh"
PORTS_DIR="$ROOT/backend/src/application/ports"
ADAPTER="$ROOT/backend/src/infra/db/tenant-unit-of-work.postgres.ts"
BACKUP_ROOT="$ROOT/.refactor-backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/application-ports-$STAMP"

usage() {
  cat <<'EOF'
Uso: bash scripts/refactor/apply-application-boundaries.sh [--dry-run]

Instala a fundação dos ports com preflight e backup. Não migra imports ou
implementações dos use cases. Consulte o resumo ao final e faça a migração por
feature com adapters reais e testes de comportamento.
EOF
}

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  -h|--help) usage; exit 0 ;;
  *) echo "Argumento não reconhecido: $1" >&2; usage >&2; exit 2 ;;
esac

if [[ ! -x "$GENERATOR" ]]; then
  echo "Erro: gerador ausente ou não executável: $GENERATOR" >&2
  exit 1
fi

# Os contratos ainda precisam de revisão semântica com o domínio antes de poderem
# ser ligados a código produtivo. O modo padrão só instala os arquivos conhecidos.
if [[ -d "$PORTS_DIR" ]]; then
  echo "Erro: $PORTS_DIR já existe. Este script não mescla nem sobrescreve ports." >&2
  echo "Revise/retire o diretório manualmente antes de nova aplicação." >&2
  exit 1
fi
if [[ -e "$ADAPTER" ]]; then
  echo "Erro: adapter de UoW já existe: $ADAPTER" >&2
  exit 1
fi

# Gerador preflight também valida todas as colisões individuais antes de escrever.
if ((DRY_RUN)); then
  echo "DRY-RUN: criaria 23 contratos sob backend/src/application/ports/."
  echo "DRY-RUN: não criaria adapter PostgreSQL nem alteraria use cases."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
# Preserva o estado dos scripts que definem os contratos instalados.
cp "$GENERATOR" "$BACKUP_DIR/"
cp "$ROOT/scripts/refactor/apply-application-boundaries.sh" "$BACKUP_DIR/"

rollback() {
  local status=$?
  if ((status != 0)); then
    rm -rf "$PORTS_DIR"
    echo "A instalação falhou; ports parcialmente criados foram removidos." >&2
    echo "Scripts de origem preservados em: $BACKUP_DIR" >&2
  fi
  exit "$status"
}
trap rollback EXIT

bash "$GENERATOR"

# Verificação estrutural dos contratos instalados. O teste completo de tipos
# depende das dependências locais do backend e é executado quando disponíveis.
expected=23
actual="$(find "$PORTS_DIR" -type f -name '*.ts' | wc -l | tr -d ' ')"
if [[ "$actual" != "$expected" ]]; then
  echo "Erro: esperados $expected arquivos de contrato; encontrados $actual." >&2
  exit 1
fi

if [[ -x "$ROOT/backend/node_modules/.bin/tsc" ]]; then
  (
    cd "$ROOT/backend"
    ./node_modules/.bin/tsc --noEmit -p tsconfig.json
  )
else
  echo "Aviso: TypeScript local não instalado; validação tsc não executada." >&2
fi

trap - EXIT
cat <<EOF

Fundação instalada: $PORTS_DIR
Backup do gerador/script: $BACKUP_DIR

Limite desta aplicação:
- cria os contracts/ports declarados no gerador;
- NÃO implementa adapters PostgreSQL;
- NÃO troca os use cases existentes para depender dos ports;
- NÃO ativa SET LOCAL / RLS e NÃO altera migrations.

Por que o adapter não é gerado aqui: o backend atual seleciona schema via ALS e
pool por tenant, enquanto o TenantContext proposto carrega tenantId. Ligar esses
modelos sem o mapping/registry e sem provar a transação poderia executar uma
operação no schema errado. Além disso, reescritas mecânicas não preservam por si
só invariantes como ledger de estoque, pagamentos confirmados, audit e outbox.
EOF
