# 28 — Multi-tenant por linha (`tenant_id` + RLS)

> **Status: FASE 0 concluída** (identidade do tenant + papel do app). A
> decisão do modelo está tomada; a barreira no Postgres (RLS) **ainda não**
> existe — mas o que ela exige (o app sem superuser) já está no ar.
>
> **Data:** 2026-10-21 · **Decisor:** dono do produto · **Estado do código:**
> `cmd/pdv/`, `backend/src/`, `backend/migrations/registry/0003_tenant_id.sql`,
> `deploy/docker-compose*.yml`, `scripts/dev/setup-dev.sh`.

---

## 1. A decisão, em uma frase

> **Um schema PostgreSQL só, toda tabela de negócio com `tenant_id`, e a
> segregação garantida pelo próprio Postgres (Row Level Security) — não por
> convenção de código.**

O modelo vigente é o oposto: **um schema por loja** (`tenant_<slug>`), com
pool dedicado e `search_path` fixado no startup packet. O isolamento de lá é
estrutural (o pool só conversa com um schema), mas custa caro em operação e
escala mal (ver §5).

## 2. Por que (e o que já foi tentado)

Este repositório já passou pelos dois modelos. A ordem importa, porque cada um
pagou uma conta diferente:

| Iteração | Modelo | Desfecho |
|---|---|---|
| 1 | **Row-level** (`store_id` em ~22 tabelas) | **Vazou dado real entre lojas** — o filtro era convenção, não barreira. Removido em `7c259cd` (PR #54) + `0012_remove_multi_tenant.sql`. |
| 2 | **Schema por loja** (`tenant_<slug>`) | Vigente. Barreira estrutural; custo: pool por loja (LRU de 16), migrations em N schemas, provisionamento em múltiplas etapas, relatório consolidado por UNION entre schemas. |
| 3 | **Row-level + RLS** (este doc) | Decidido em 2026-10-21. Mesma forma de dado da iteração 1, mas com a barreira **no banco**. |

O ponto que a iteração 1 provou: **filtro opcional é convenção, e convenção
falha**. A iteração 3 mantém o filtro opcional *e* adiciona a barreira que
falta — a policy do Postgres, que nem um bug de aplicação consegue atravessar.

O que mudou desde a decisão de 2026-10-04 (que rejeitava RLS): a identidade
centralizada (`docs/26`) já exige o registry de tenants e já grava
`app.tenant_id` por transação, e o `app.tenant_id` também está no gateway Go
(`ws-gateway/internal/tenancy`). O degrau que faltava era **a role**: com o app
conectando como superuser, RLS seria inerte (superuser sempre burla row
security, mesmo com `FORCE ROW LEVEL SECURITY`) — o que, na prática, seria a
mesma fachada de isolamento que a iteração 1 pagou.

## 3. O que muda no código

### 3.1 Identidade do tenant (FASE 0 — em andamento)

`public.tenant` passa a ter **duas** identidades:

- `slug` — o rótulo: claim do JWT, 1ª label do Host, domínio próprio. Pode
  ser renomeado.
- `id` (uuid) — a identidade **estável**: é o que vai para a coluna
  `tenant_id` e para as policies. Não muda.

O `slug` deixa de ser a PK e vira UNIQUE; o `id` vira a PK. `schema_name` deixa
de ser NOT NULL (no modelo por linha a loja não tem schema) e o CHECK passa a
aceitar `public` (o schema do tenant default).

O tenant default — que hoje **não é** uma linha do registry (ele é o ambiente,
`DEFAULT_TENANT_SCHEMA`) — passa a ser uma linha, com id **fixo**
(`00000000-0000-0000-0000-000000000001`). Fixo porque o caminho "sem escopo
ALS" (trabalhos internos) precisa gravar o mesmo `app.tenant_id` que o caminho
com ALS, e porque o backfill do dado existente precisa de um destino estável.

Daqui em diante, **todo escopo de tenant carrega o id**: o ALS
(`TenantScope.tenantId`), o port `TenantContext`, o `TenantRegistryRecord` e o
`Tenant` do gateway Go. O `app.tenant_id` gravado na transação passa a ser o
**uuid** (antes era o slug) — é o mesmo contrato dos dois lados da aplicação.

### 3.1b O papel do app (FASE 0 — entregue)

O app passa a conectar com um papel **próprio, sem superuser e sem
BYPASSRLS** (`pdv_app`), criado e ajustado no boot (`ensure-app-role.ts`).
Enquanto o app conecta como superuser, RLS é decoração — superuser sempre
burla row security, inclusive com `FORCE ROW LEVEL SECURITY`.

As duas DSNs são separadas:

| env | papel | quem usa |
|---|---|---|
| `DATABASE_URL` | o **papel do app** (restrito) | o runtime (queries, UoW, workers) |
| `MIGRATION_DATABASE_URL` | o **dono** (quem tem DDL) | o runner de migrations e o bootstrap do papel |

O `deploy/backup.sh` continua usando o dono (o `pg_dump` precisa de privilégio
de leitura de tudo). O gateway Go também passa a poder usar o papel restrito —
e ele já tinha a **auditoria** que avisa (e, com `DB_REQUIRE_RESTRICTED=1`,
recusa subir) quando a conexão é superuser: `ws-gateway/internal/db/role.go`.

**É opt-in e reversível**: sem `APP_DB_PASSWORD` no ambiente, o papel não é
criado/ajustado e o app segue com o papel que a `DATABASE_URL` apontar — ou
seja, desfazer a troca é trocar a env de volta.

### 3.2 Coluna `tenant_id` (FASE 1)

`tenant_id uuid` em **todas** as tabelas de negócio (38 no schema de tenant),
com índice, `UNIQUE (id, tenant_id)` nas tabelas mãe e **FKs compostas** (49) —
sem `tenant_id` na FK, uma linha da loja A poderia apontar para a linha da loja
B.

O dado existente é **backfilled** (a decisão do dono), com o id do tenant
default. A coluna nasce nullable (expand) e vira NOT NULL quando a Fase 3
cortar o schema-por-tenant (contract).

### 3.3 RLS (FASE 2 — a barreira)

Policy em todas as tabelas:

```sql
USING (tenant_id = current_setting('app.tenant_id')::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)
```

com `FORCE ROW LEVEL SECURITY` e o app conectando com **role própria, sem
superuser e sem BYPASSRLS**. `current_setting` **sem** `missing_ok` → sem
contexto de tenant a query **erra** (fail-closed), em vez de devolver vazio em
silêncio.

O `app.tenant_id` tem de estar em **toda** transação. Hoje ele é gravado pelo
Unit-of-Worker — mas 43 arquivos usam o `db` direto, e o `db` proxy é o
caminho que precisa passar a setar a GUC (e a errar alto quando não há tenant
no ALS).

### 3.4 Fim do schema-por-tenant (FASE 3)

`TenantContext` perde o `schemaName`; o pool vira único (some o LRU de 16
pools); as migrations passam a ser aplicadas uma vez (o `_migrations` global);
`provision-tenant.ts` vira um `INSERT` no registry; o storage
(`<uploadsDir>/<schema>/`) passa a ser por tenant.

### 3.5 Dados e consumidores (FASE 4)

Migração do dado de produção; o gateway Go deixa de setar `search_path` e passa
a usar o **id** (uuid) no `app.tenant_id`; a CLI e a TUI passam a filtrar por
`tenant_id`; `docs/15`/`docs/17` são atualizados **na mesma leva** (a regra de
conflito do `AGENTS.md`).

## 4. Regras que não se negociam

1. **O `tenant_id` da transação vem do tenant RESOLVIDO e AUTENTICADO** (Host
   ou JWT) — nunca de input do cliente.
2. **O id é uuid, não slug**: slug é rótulo e pode ser renomeado; a coluna e a
   policy comparam com o id.
3. **Sem `tenant_id` no ALS, a query falha** — não devolve vazio. Um vazio
   silencioso é indistinguível de "a loja não tem esse dado".
4. **A barreira é do banco**: enquanto o app conectar como superuser, não há
   isolamento — a Fase 2 não pode ser considerada entregue antes da troca de
   role.
5. **O registry é global**: `public.tenant`, `public.account`,
   `public.account_identity`, `public.auth_session` e `public.password_reset`
   ficam **fora** das policies (são controle de plano, não dado de loja).

## 5. O que se ganha e o que se perde

**Ganha**: um pool (o teto de pools de 16 e o LRU saem de cena); onboarding de
loja = `INSERT` + seed (sem provisionar schema); relatório consolidado
nativo (`GROUP BY tenant_id`, sem UNION entre schemas); `VACUUM` e índice
sabendo onde o dado está; a identidade centralizada (`docs/26`) passa a ter um
diretório único; uma loja = uma linha (o modelo que o SaaS e o standalone
precisam).

**Perde**: rollback de loja deixa de ser físico (vira lógico — o dump filtrado
não é um `pg_restore` de schema); eliminação LGPD deixa de ser um
`DROP SCHEMA CASCADE` atômico (vira N `DELETE`, com checkpoint); **ruído de
vizinho** (query pesada de uma loja pesa no vacuum/índice do banco inteiro);
`pg_dump` não respeita RLS → o dump por loja morre (o backup do banco
inteiro, que é o que o `deploy/backup.sh` faz, continua valendo); e a
**troca de role do app é a operação mais delicada do projeto** — se o papel
novo faltar um grant, o app quebra em runtime.

## 6. Ordem de ataque

Cada fase é uma PR pequena (trunk-based), e a ordem é a que minimiza o
rollback:

| Fase | Entrega | Quebra algo? |
|---|---|---|
| **F0** | role `pdv_app` + `public.tenant.id` + linha do default | sim (a DSN) — e é a parte de maior risco de infra, então vem primeiro, com o schema-por-tenant ainda no ar (rollback em minutos) — **entregue** |
| **F1** | `tenant_id` nas 38 tabelas + backfill | não |
| **F2** | policies + `FORCE RLS` + `db` fail-closed + suíte de isolamento | sim — **a barreira passa a existir aqui** |
| **F3** | fim do schema-por-tenant (pool único, migrations 1x, provisionamento, storage) | sim |
| **F4** | dado de produção, gateway Go, CLI/TUI, docs | — |

## 7. Decisões em aberto (dono do produto)

1. **Existe cliente real rodando em produção?** O custo do backfill depende
   disso. (O `docs/23` §2 registra a contradição: o mesmo documento afirmava
   "sem clientes reais" e citava `umamisushitarte.com.br` como cliente.)
2. **A troca da `DATABASE_URL` de produção (superuser → role restrita) é
   aceitável operacionalmente?** — a mecânica está pronta e validada no dev;
   falta a decisão de operação (e o `MIGRATION_DATABASE_URL` + o
   `APP_DB_PASSWORD` no `deploy/.env`).
3. **O dump por loja sai ou vira export lógico por `COPY`?** Com RLS, o
   `pg_dump --schema=` da CLI não isola.

## 8. Referências

- `docs/26-identidade-centralizada.md` §9 — a relação com este workstream
  (identidade global em `public`, `user` com `tenant_id` no modelo por linha).
- `docs/15-multi-tenant-schema.md` — o modelo vigente (schema por loja),
  removido do repo; recuperar com `git show 308c9977^:docs/15-multi-tenant-schema.md`.
- `docs/23-reavaliacao-multi-tenant.md` — a reavaliação que reabriu esta
  decisão (opções A/B/C e a medição do superuser); recuperar com
  `git show 308c9977^:docs/23-reavaliacao-multi-tenant.md`.
- `backend/src/application/ports/tenant-context.ts` — o port congelado que
  define o contrato do escopo.
- `backend/src/infra/db/postgres-tenant-unit-of-work.ts` — onde o
  `app.tenant_id` é gravado.
- `ws-gateway/internal/tenancy/` — o mesmo contrato do lado Go.
