# 17 — Runbook: unificação das migrations + baseline único

> **Data:** 2026-10-04 · **Branch:** `docs/pendencias-e-unificacao-migrations`
> **Objetivo:** sair da cadeia de 10 arquivos em `backend/migrations/` (com duplo `0003_`, gap
> `0008`–`0011` e `0012` desfazendo tudo) para um **único** `backend/migrations/0001_init.sql`,
> idempotente, que passa a ser o DDL que cada schema de tenant recebe.

## Garantias de segurança (leia antes de executar)

1. **Nenhum dado de produção é apagado neste PR.** O baseline novo só foi validado em
   Postgres descartável (container `pdv-scratch-pg`): o DDL gerado bate com a cadeia antiga
   (diff de `pg_dump --schema-only` = só a tabela `_migrations`) e o round-trip de dados
   (`pg_dump --data-only` → `pg_restore --data-only`) restaurou tudo com sucesso.
2. O cutover em produção só começa **depois** de backup verificado (passo 1–2) e só toca o
   banco via `DROP SCHEMA public CASCADE` seguido de restore dos dados — o dado original
   permanece no `.dump` até o passo 6 ser validado.
3. **Não executar em horário de pico.** Janela sugerida: fora do expediente; hoje é 1 loja,
   segundos de janela.

## Estado do repo depois deste PR

- `backend/migrations/0001_init.sql` — baseline único (gerado via `pg_dump --schema-only
  --no-owner --no-privileges` sobre um banco com a cadeia antiga aplicada, pós-`0012`),
  idempotente (`IF NOT EXISTS` em tabelas/índices/sequências; tipos e constraints em
  `DO $$ … WHEN OTHERS THEN NULL $$`), **sem** `CREATE INDEX CONCURRENTLY` (o runner usa
  transação por arquivo) e **sem** `set_config('search_path', …)` (o runner compartilha a
  sessão e precisa de `search_path` padrão para o `INSERT INTO _migrations`).
- `backend/migrations/archive/` — cadeia antiga (`0001_init_legacy.sql` … `0012_…`),
  fora do glob do runner (`readdirSync` não recursivo + filtro `.sql` no topo).
- `backend/data.db*` (resíduo SQLite versionado) — removido do git na mesma leva.

## Validação já feita (2026-10-04, sandbox)

| Teste | Resultado |
|---|---|
| Cadeia antiga aplicada em Postgres 16 limpo → dump `schema-only` | OK |
| Baseline aplicado via `psql -f` duas vezes no mesmo banco | OK (idempotente) |
| Diff `schema-only` (cadeia antiga vs baseline) | idêntico, exceto `_migrations` |
| `runMigrations()` (runner real) em banco novo | aplica `0001_init.sql`; 2ª execução no-op |
| Seed + `pg_dump --data-only` (excluindo `_migrations`) → `pg_restore --data-only --single-transaction` no banco criado pelo baseline | 0 erros; contagens batem (6 produtos, 7 usuários, 3 categorias) |

## Cutover em produção (a executar quando autorizado)

Pré-condição: janela agendada, `docker compose` de pé, role com `CREATE/DROP` no banco.

```bash
# 0. Healthcheck verde antes de começar
curl -fsS https://<host>/health

# 1. Backup completo (banco + uploads) e ANOTE o carimbo do arquivo
./deploy/backup.sh /opt/backups
ls -la /opt/backups/pdv-*.dump

# 2. Verificação do backup: restaure num banco NOVO do próprio servidor
docker exec deploy-postgres-1 psql -U pdv -d postgres -c "CREATE DATABASE pdv_verify;"
docker exec -i deploy-postgres-1 pg_restore -U pdv -d pdv_verify --no-owner --no-privileges \
  < /opt/backups/pdv-<stamp>.dump
docker exec deploy-postgres-1 psql -U pdv -d pdv_verify -c "\dt"   # lista tabelas
# Se algo falhar aqui: PARE — não prossiga para o passo 3.

# 3. Copie o backup para fora do servidor (obrigatório antes de mexer no banco)
rsync -av /opt/backups/pdv-<stamp>.dump <destino-externo>/

# 4. Pare o tráfego (maintenance mode / DNS para página estática / scale 0 no blue)
#    Confirme: nenhuma escrita nova.

# 5. Zerar o schema e reaplicar o baseline
docker exec deploy-postgres-1 psql -U pdv -d pdv -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker exec deploy-postgres-1 psql -U pdv -d pdv -v ON_ERROR_STOP=1 -f - < backend/migrations/0001_init.sql
# registrar na tabela de controle para o runner não reaplicar:
docker exec deploy-postgres-1 psql -U pdv -d pdv -c \
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')); INSERT INTO _migrations (name) VALUES ('0001_init.sql') ON CONFLICT DO NOTHING;"

# 6. Restaurar apenas os DADOS (excluindo _migrations — já registrada acima)
docker exec deploy-postgres-1 pg_dump -U pdv -d pdv_verify --data-only --no-owner --no-privileges -T 'public._migrations' -Fc > /tmp/pdv_data.dump
docker exec -i deploy-postgres-1 pg_restore -U pdv -d pdv --data-only --no-owner --no-privileges --single-transaction < /tmp/pdv_data.dump

# 7. Valide: contagens de linhas, health, smoke manual do perfil garçom
docker exec deploy-postgres-1 psql -U pdv -d pdv -c "SELECT count(*) FROM product; SELECT count(*) FROM \"order\";"
curl -fsS https://<host>/health

# 8. Uploads: extraia o tarball no volume pdv_backend_uploads
docker run --rm -v pdv_backend_uploads:/uploads -v /opt/backups:/backup busybox \
  tar xzf /backup/pdv-<stamp>-uploads.tar.gz -C /uploads

# 9. Libere o tráfego. Se qualquer passo falhar: restore total do .dump (passo 2 mostra o caminho).
```

## Rollback

O banco zerado no passo 5 **só** é seguro porque o dado original está no `.dump` verificado
(passo 2) e copiado para fora (passo 3). Rollback = `pg_restore` do `.dump` completo em cima
do schema zerado, ou recriar o banco a partir do dump integral. Não delete
`/opt/backups/pdv-<stamp>.dump` até 24h pós-cutover.

## Notas para multi-tenant (§15)

- `provisionTenantSchema()` deve rodar **este** baseline por schema (`SET search_path` no
  schema do tenant + executar o arquivo), não a cadeia antiga.
- O baseline não contém dados de loja nem DDL multi-tenant (schemas, `tenant` table) — isso
  entra nas fases 0–2 do `docs/15`, em migrations novas numeradas após `0001`.
