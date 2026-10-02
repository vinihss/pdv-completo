# Guia de Contribuição

## Fluxo de Desenvolvimento (Trunk-Based)

Este projeto adota **Trunk-Based Development** com integrações frequentes na `main`:

1. **Crie um worktree por branch**: `./scripts/dev-worktree.sh new tipo/descricao-curta`
2. **Use branches de vida curta** (ideal < 1–2 dias). Se passar de 3 dias, divida em PRs menores.
3. **Abra PR pequeno e focado**. Sempre via worktree, **nunca** commit direto em `main`.
4. **Integre com frequência** (squash merge) assim que aprovado e verde.
5. **`main` deve permanecer sempre verde** (testes/build passando).

## Conventional Commits (obrigatório)

Todo commit deve seguir [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/). O versionamento, changelog, tag e GitHub Release são **gerados automaticamente** no merge na `main`.

### Tipos válidos

| Tipo | Uso | Impacto SemVer |
|---|---|---|
| `feat:` | Nova funcionalidade | **minor** (x.Y.z) |
| `fix:` | Correção de bug | **patch** (x.y.Z) |
| `perf:` | Melhoria de performance | **patch** (x.y.Z) |
| `refactor:` | Refatoração sem alterar comportamento | **sem release** |
| `chore:` | Tarefas, deps, tooling, manutenção | **sem release** |
| `docs:` | Documentação apenas | **sem release** |
| `test:` | Adição/correção de testes | **sem release** |
| `build:` | Mudanças em build/artefatos | **sem release** |
| `ci:` | Mudanças em CI/workflows | **sem release** |
| `revert:` | Reverte um commit anterior | **patch** (x.y.Z) |

### Breaking Changes

Para mudanças **incompatíveis com versões anteriores** (breaking change), use uma das formas:

1. **Footer obrigatório**: `BREAKING CHANGE: descrição da quebra de compatibilidade`
2. **`!` após tipo/escopo**: `feat(api)!: altera contrato de autenticação`

Ambos geram **major** (X.y.z).

### Exemplos

```bash
git commit -m "feat(comandas): permite dividir conta em múltiplos pagamentos"
git commit -m "fix(estoque): corrige cálculo de custo médio em baixa parcial"
git commit -m "perf(pedidos): reduz N+1 ao listar comandas"
git commit -m "refactor(db): simplifica repositório de pedidos"
git commit -m "chore(deps): atualiza drizzle-orm para v0.36.x"
git commit -m "feat(api)!: remove endpoint legado v1 de pedidos

BREAKING CHANGE: /api/v1/orders foi removido. Usar /api/v2/orders."
```

## Validação

- **PR**: Commits são validados automaticamente no CI (commitlint). PRs com commits fora do padrão **são bloqueados**.
- **Release automático**: Após merge na `main`, o Semantic Release analisa os commits consolidados (squash merge) e decide se gera release + tag + changelog.
