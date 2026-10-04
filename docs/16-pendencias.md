# 16 — Pendências e intenção de unificar migrations

> **Data:** 2026-10-04 · **Autor:** sessão de planejamento multi-tenant (handoff)
> **Contexto:** este documento registra o que ficou pendente ao final da sessão de planejamento do
> multi-tenant (ver `docs/15-multi-tenant-schema.md`) e a intenção já discutida de unificar as
> migrations do backend num único baseline. A implementação fica para a próxima sessão.

---

## 1. Status do planejamento multi-tenant

| Item | Status |
|---|---|
| Plano arquitetural (`docs/15`) | ✅ escrito, PR #59 aberto → `main` |
| Preparação §6.0 — consolidar migrations + redeploy limpo | ✅ **executada em produção (2026-10-04)**: baseline `0001_init.sql` único (PR #64), cutover executado conforme `docs/17` §6 — backup verificado (98 produtos, 12 comandas, 6 usuários), restore de dados validado, `_migrations` com uma única entrada. Rollback: `.dump` mantido em `/opt/backups` + cópia local |
| Fases 0–8 de implementação | ⏳ não iniciadas |
| PR #59 (docs) | ✅ mergeada |

A `feat/schema` foi atualizada com o `main` vigente (ws-gateway Go, guard de banco de teste,
CI Node 22, APK garçom). Nenhum código alterado — só docs.

---

## 2. Unificação das migrations — **executada (2026-10-04)**

> Histórico: este doc registrava a intenção. O baseline `backend/migrations/0001_init.sql`
> entrou na `main` via PR #64, a cadeia antiga foi arquivada em
> `backend/migrations/archive/` e o cutover em produção foi executado (§6.0 ✅).

### Estado original (pré-2026-10-04)

Hoje: cadeia de 10 arquivos em `backend/migrations/`, com duplo `0003_` (`printer` +
`profile_fields`), gap (`0008` = `customer_profile_fields`; `0009`–`0011` removidos mas como
registro), e `0012_remove_multi_tenant.sql` **desfazendo** o efeito das `0008`–`0011`. Para
schema-por-tenant, cada loja nova replayaria "aplica `0008`–`0011` e depois `0012` apaga
tudo" — aplica e desfaz, por tenant, para sempre.

**Intenção (já alinhada na conversa):**

1. Consolidar o DDL atual (estado pós-`0012`) num único `backend/migrations/0001_init.sql`,
   totalmente idempotente (`IF NOT EXISTS` em tables/índices, enums com `DO $$ … $$`), usando
   `pg_dump --schema-only --no-owner --no-privileges` como fonte autoritativa, e fixando
   `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;` (corrige o achado §5.1).
2. Zerar o banco com `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.
3. Remover/arquivar a cadeia velha (`0002`–`0012`) no mesmo commit — o runner só lê
   `migrations/*.sql`.
4. Restaurar **apenas os dados** com `pg_restore --data-only --no-owner --no-privileges`
   (As `setval()` das sequências vêm junto) e extrair o tarball de `pdv_backend_uploads`.
5. O baseline passa a ser o DDL que **cada schema de tenant recebe**
   (`provisionTenantSchema()` → `runMigrations({ schema })` sobre ele).
6. Cuidados já conhecidos: nenhum `.sql` pode ter `CREATE INDEX CONCURRENTLY` (runner usa
   transação por arquivo); `pg_restore --data-only` pode falhar por constraint se o DDL
   divergir — com DDL equivalente costuma passar; em divergência real,
   `--single-transaction` + revisar a primeira linha que erra.

Como **não há cliente ativo** hoje, é seguro: é um backup (`./deploy/backup.sh`) antes, e o
roll completo é restaurar esse dump. Janela de segundos para 1 loja.

---

## 3. Decisões/pendências de produto (do §10 do `docs/15`)

1. **Postgres de produção dá `CREATE` no banco?** ✅ Respondido (2026-10-04): manter a role
   `pdv` como está; separação `pdv_app`/`pdv_dba` fora das fases iniciais.
2. **Alvo de N tenants em 12 meses** ✅ Respondido (2026-10-04): **sem pool dedicado por
   tenant** — pool compartilhado com `SET LOCAL search_path`.
   A dúvida do alvo de N fica menos crítica, mas o pool compartilhado precisa de
   atenção a `search_path` e timeouts.
3. **Credenciais do iFood são por loja?** ✅ **Respondido (2026-10-04):** cada tenant tem a
   sua própria loja no iFood. Plano em `docs/18-ifood-por-loja.md` (sem implementação).
4. **Impressora:** o daemon (`PRINTER_DAEMON_URL`) é global — 1 por host ou compartilhado entre
   lojas? Se compartilhado, o daemon Go (`printer/`) precisa de fila por loja. ⏳ depois.
5. **Gerente pode operar 2 lojas?** ✅ **Respondido (2026-10-04): não.** JWT não precisa de
   troca de tenant; UI não precisa de troca de subdomínio.
6. **Downtime tolerável no cutover** (hoje é segundos; zero exigiria logical replication). ⏳ depois.
7. **Painel de administração** (provisionar/pausar loja) — script manual ou UI interna? ⏳ depois.

**Registradas em 2026-10-04:**
- §3.1: **Postgres mantém a role `pdv` como está** (SUPERUSER). Separação
  `pdv_app`/`pdv_dba` fica para a Fase 3 ou mais tarde.
- §3.2: **NÃO usar pool dedicado por tenant.** O pool do banco será **compartilhado**
  entre tenants, com `SET LOCAL search_path` por transação/query. Isso muda a Fase 3 do
  `docs/15` (arquitetura de conexão).

---

## 6. Análise: iFood por loja

> Levantamento 2026-10-04 (commit equivalente, `feat/schema` removida) — estado atual
> do `backend/src/integrations/ifood/`.

| Camada | Onde | Hoje |
|---|---|---|
| Credenciais | `config/env.ts:88-90` (`IFOOD_CLIENT_ID/SECRET`, `IFOOD_MERCHANT_ID`) | globais em env |
| Estado | `integrations/ifood/state.ts:1-45`, `schema.ts:545` (`ifood_state.key/value`) | global no DB, PK só `key` |
| Worker de polling | `worker.ts:72-104`, iniciado uma única vez em `server.ts:199` | 1 merchant no processo todo |
| Toggle por loja | `store_settings.ifood_enabled` (`schema.ts:152`) | por loja ✅ |
| Flag por produto | `product.ifood_enabled` + `ifoodSku` (`schema.ts:152-153`) | por produto ✅ |

**Delta para iFood por loja (multi-tenant):**

1. `ifood_state.key/value` passar a ser chaveado por loja (`(store_id, key)`) — hoje a PK
   é só `key`, então duas lojas pisariam no token uma da outra.
2. Credenciais saírem do `.env` e irem para o banco (ex.: `stores.ifood_client_id/secret/
   merchant_id`) — o worker roda no mesmo processo de todas as lojas, então env por tenant
   não resolve.
3. `worker.ts` / `client.ts` / `catalog-sync.ts` iterarem as lojas com `ifood_enabled = true`,
   com cache de token por loja.
4. `GET /ifood/status` e rotas exigirem resolver o `store_id` a partir do JWT
   (`t: <schema>`), para não vazar token/merchant entre lojas.

**Veredicto para a pendência §3.3:** hoje credenciais e estado são **globais**; só o toggle
é por loja. Se cada loja tiver o seu merchant, os itens 1–4 são pré-requisito antes das
fases 0–2 do multi-tenant.

> Decisão de produto (2026-10-04): **cada tenant tem a sua própria loja no iFood.**
> Plano detalhado e inventário do código em `docs/18-ifood-por-loja.md` (sem implementação).
4. **Impressora:** o daemon (`PRINTER_DAEMON_URL`) é global — 1 por host ou compartilhado entre
   lojas? Se compartilhado, o daemon Go (`printer/`) precisa de fila por loja.
5. **Gerente pode operar 2 lojas?** Impacta o JWT (`t: <schema>`) e exige troca de subdomínio
   na UI.
6. **Downtime tolerável no cutover** (hoje é segundos; zero exigiria logical replication).
7. **Painel de administração** (provisionar/pausar loja) — script manual ou UI interna?

---

## 4. Achados operacionais que não entraram no plano ainda

| Achado | Onde | Severidade percebida |
|---|---|---|
| Gateway WS Go (`ws-gateway/`) existe no `main` desde `3e5e8cd`, mas **não está plugado em `Caddyfile`/`deploy`** — o Node continua sendo o realtime vivo | `ws-gateway/`, `deploy/Caddyfile` | 🟡 decisão pendente |
| `docker-compose.yml/.local.yml/.dev.yml` dividem os volumes `pdv_postgres_data`, `pdv_backend_uploads`, `pdv_caddy_data` — subir o stack de dev aplicaria migrations no **banco de produção** | `deploy/docker-compose*.yml` | 🟠 se virar multi-tenant |
| `backend/data.db{,-shm,-wal}` (resíduo SQLite) versionados no git | `backend/` | 🟡 higiene |
| `backup.sh`: sem retenção/rotação, sem verificação, sem manifesto; dumps ficam no mesmo disco | `deploy/backup.sh` | 🟡 operação |
| `/internal/caddy-on-demand-tls` aceita qualquer `^[a-z0-9-]+\.labolabe\.tech$` — scanner pode estourar o rate limit do Let's Encrypt | `backend/src/http/server.ts:121-125` | 🟡 |
| `CORS_ORIGIN` enumerado não escala com N subdomínios + origens Tauri | `deploy/.env.example:18`, `server.ts:61-71` | 🟠 com N lojas |
| `audit_log`/`stock_movement` **nunca são podados** (maintenance só limpa 4 tabelas) — crescimento sem limite | `backend/src/infra/maintenance.ts` | 🟡 |

---

## 5. Próximos passos sugeridos (ordem livre, próxima sessão escolhe)

1. ~~Merge da PR #59 (docs do plano) para a `main`.~~ ✅
2. ~~Executar §6.0 (unificar migrations + redeploy limpo) — branch própria + PR.~~ ✅ PR #64 + cutover 2026-10-04 (ver `docs/17`).
3. Decidir sobre o gateway WS Go: quando vira o realtime vivo? O particionamento por tenant
   do §3.3 do `docs/15` vale para **ambos** os gateways enquanto coexistem.
4. Responder às 7 decisões do §3 deste doc (donos/negócio).
5. Começar Fase 0–1 do multi-tenant só depois de 1–2.
