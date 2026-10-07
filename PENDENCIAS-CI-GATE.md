# Pendências pós-PR #125 (fix do gate CI)

Estado: 06/10/2026 — PR #125 mergeada (fix(ci): pull-requests: read + fail-open).
Gate verificado: `changes` passa e as 6 suítes rodam (não skipped). Deploy da v1.32.0
funcionou; deploys automáticos de v1.32.1/v1.33.0 NÃO saíram (PAT quebrado).

1. PAT do Semantic Release (`SEMANTIC_RELEASE_TOKEN`) — NÃO FUNCIONA. Criado na
   madrugada mas sem efeito observado (tags v1.30.0+ não disparam deploy). Requer
   criação de novo fine-grained PAT (`contents: write`) pelo dono do repo.
2. Re-push manual: `v1.32.1` (fix #124) e `v1.33.0` (#113 — tenant ALS) aguardam.
3. 2 testes vermelhos no backend (descobertos pelo gate restaurado):
   - `test/courier-location.test.ts`: colisão de fixture `u-courier` (`Entregador Teste` vs `Entregador Um` — `profiles`/`self-service` usam o mesmo id).
   - `test/uploads.test.ts`: vazamento ALS de tenant (`public` ao invés de `tenant_x` — regressão da PR #113, que mergeou com gate vazio).
4. `app-v0.1.0` (build-desktop) falhando desde ontem (não investigado).
5. `test/whatsapp.test.ts`: timeouts de hook (ambiente/CI, não código).
