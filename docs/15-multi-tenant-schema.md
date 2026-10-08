# 15 — Multi-tenant: um schema PostgreSQL por loja (subdomínio → tenant)

> **Status:** **Fase 1 implementada** (registry + resolução + o endpoint que a
> vitrine de pedidos consome). As fases 2–8 continuam não iniciadas.
> Verificado em 2026-10-05 no branch `feat/tenant-resolve-public`:
> - **Fase 1: FEITA.** `backend/migrations/registry/0001_tenant_registry.sql` (o
>   `public.tenant` do §3.2 + `custom_domain`), o runner próprio
>   `infra/db/registry-migrate.ts` (`runRegistryMigrations()`, roda no boot
>   **antes** das migrations de tenant, §6.1), o acesso ao registry com cache em
>   `infra/tenant/registry.ts`, as regras puras de `Host` em `domain/tenant.ts`,
>   o use case `application/tenant/resolve-tenant.usecase.ts` (`resolveTenant`,
>   pronto para o `onRequest` da Fase 2), os `Errors.tenant*` e o endpoint
>   `GET /public/tenants/resolve` (`http/routes/tenant.routes.ts`).
>   Suíte: `backend/test/tenant-routing.test.ts` (29 casos, o `tenant-routing.test.ts`
>   do §6 F8 — os `tenant-isolation.test.ts` continuam sendo Fase 2+).
> - **Fase 1 em modo seguro:** `TENANT_ROUTING` **desligado por default**, ou seja,
>   **comportamento idêntico ao de hoje** (todo host → tenant default). Ligar é
>   uma env só depois de popular o registry e ter a Fase 2/3 — com o registry
>   vazio, ligado, qualquer endereço não cadastrado levaria 404, inclusive as
>   lojas que já estão no ar.
> - **O que a Fase 1 NÃO faz** (e é por isso que ela é segura): `resolveTenant`
>   existe, mas **nada consome o `schema_name` ainda**. `db` continua sendo um
>   pool único sem `search_path` por request, então um tenant registrado em
>   `tenant_x` **não tem** cardápio, carrinho nem pedido neste processo — e o
>   endpoint responde `503 tenant_schema_unavailable` em vez de servir a marca
>   dele sobre o catálogo de outra loja (que seria o §5.2 de novo). O cutover
>   continua sendo a Fase 7.
> - **Fases 2–4 e 6–8: não iniciadas.** Não existe ALS, pool por tenant,
>   `runMigrations({ schema })`, `provisionTenantSchema()`, JWT com `t`,
>   `tenant.middleware` nem gateway particionado.
> - **Fase 5: parcial** — rodou o bloco de storage (porta + layout por tenant em disco), `d30ec49`
>   (PR #73). O resto da fase (fan-out do WhatsApp, `/health/tenants`, TLS on-demand via registry,
>   `printer_daemon_url` por tenant, CORS por registry) segue não iniciado — e o
>   `/internal/caddy-on-demand-tls` continua no regex hardcoded (§5.8).
> - **O gateway Go ficou deployável** em `b01000b` (PR #76) — o que §3.3 exige para o particionamento
>   é o mesmo nos dois (§5.11).
> - **§6.0 (preparação): executada em produção.** Baseline único `0001_init.sql` em `bf75736`
>   (PR #64) e cutover rodado (`docs/16:19`, runbook em `docs/17`).
> **Data:** 2026-10-04 · **Branch:** `feat/new-tenant`
> **Substitui:** `feat/multitenant-plan/docs/15-multitenant.md` (shared schema + `tenant_id` + RLS),
> que **rejeitava** schema-por-tenant. Ver §2 — a objeção não se sustenta.
> **Histórico:** já existiu multi-tenant (row-level, `store_id` em ~22 tabelas) e foi removido em
> `7c259cd` (PR #54) + `0012_remove_multi_tenant.sql`. Recomeçamos do zero, com outro modelo de isolamento.
> **Uploads:** decisão de **layout por tenant em disco** registrada em §4.7 e **implementada** em
> `d30ec49` (PR #73) — porta `FileStorage` + `LocalDiskStorage`, `<uploadsDir>/<schema>/<kind>/` e a
> rota `GET /uploads/:kind/:filename` no lugar do `@fastify/static`. Os achados §5.2 e §5.3 estão
> **FECHADOS** nesse commit; resta a seam `src/infra/storage/tenant.ts:18-20` devolver `public`
> (é a Fase 2 que a liga no ALS). O remendo `logo-<schema>.<ext>` que a Fase 5 trazia foi superado
> antes de existir e **não vai entrar**.

---

## 1. A decisão, em uma frase

> **Um schema PostgreSQL por loja (`tenant_<slug>`), identificado pelo subdomínio no
> `Host`, com o `db` do Drizzle resolvido por um `AsyncLocalStorage` e um `pg.Pool` dedicado por
> schema, cujo `search_path` é fixado no *startup packet* — de modo que os 43 arquivos que já
> importam o `db` não mudam uma linha.**

A barreira de isolamento é **estrutural** (o pool só conversa com um schema), não convenção
("lembre-se de filtrar por loja"). Isso é uma resposta direta ao histórico do projeto: o modelo
row-level anterior vazou dados entre lojas precisamente porque o filtro era opcional —
ver `feat/multitenant-isolamento/docs/15-multi-tenant-gap.md`: *"qualquer usuário logado em
`ana-terra` lê produtos, comandas, clientes, usuários, caixa e entregas da Loja Padrão"*.

O que **não** muda: o frontend web (URLs já são relativas — e no upload só acrescenta um segmento na
URL, §4.7/§7), o Caddy (o wildcard `*.labolabe.tech` com TLS on-demand já existe; o
`handle /uploads/*` continua Reverse-proxyando o backend), o `backup.sh` (já faz `pg_dump` do banco
inteiro e já pega o volume de uploads), e a forma das migrations (SQL puro, numeradas,
idempotentes).

---

## 2. Por que isso, e não RLS (a decisão anterior, revertida)

O plano anterior (`15-multitenant.md` §2.2) rejeitava schema-por-tenant por **um** argumento:

> *"Schema por tenant: `search_path` dinâmico num pool sem pin de conexão = vazar schema entre
> requests no mesmo keep-alive"*

**O argumento é verdadeiro para `SET` de sessão e falso para as duas alternativas de aplicação:**

| Como o `search_path` é fixado | O vazamento descrito acontece? |
|---|---|
| `SET search_path` no nível da **sessão** (em `acquire`/`connect`) | **Sim.** Reproduzido: após `COMMIT`, `SHOW search_path` continuava `tenant_a`. A conexão volta ao pool suja e a próxima requisição herda. |
| `SET LOCAL search_path` dentro de cada transação | **Não.** Reproduzido: `set_config(..., is_local=true)` morre no `COMMIT`; `ROLLBACK TO savepoint` devolve o valor anterior. |
| **`options: '-c search_path=…'` no startup packet de um pool dedicado** (recomendado) | **Não, e é impossível**: o pool existe para um único schema. Uma conexão devolvida "suja" só pode estar suja para o **próprio** tenant. |

O outro motivo da rejeição anterior (*"database-por-tenant estoura `max_connections`"*) é
literalmente sobre **database-por-tenant**, não schema-por-tenant, e não se aplica aqui.

⚠️ **A recusa de RLS não é só preferência: hoje RLS seria *inerte*.** Medido em produção
(2026-10-04), `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles` devolve **`pdv | t | t`** — o
app conecta como **superuser**, e superuser **sempre** bypassa row security, inclusive com
`FORCE ROW LEVEL SECURITY` em cada tabela (ver §8, "Papéis"). Ou seja: adotar RLS hoje daria a
sensação de isolamento sem barreira nenhuma — exatamente o modo de falha que o histórico do projeto
já pagou uma vez. Schema-por-tenant não depende do papel: a barreira é o `search_path` do pool (§4.2),
e `rolsuper` não a atravessa.

O que **ganhamos** trocando RLS por schema:
- **Rollback de tenant é o restore de um schema** (`pg_restore -n tenant_x`), não um filtro de app.
- **Eliminação LGPD é `DROP SCHEMA … CASCADE`** — atômica no catálogo do Postgres. Com schema
  único, a mesma operação é uma sequência de ~30 `DELETE` (30 pontos de falha).
- **Nenhuma coluna `tenant_id` em 22 tabelas**, nenhuma FK composta, nenhuma policy, nenhum
  `current_setting()` no plano de cada query.
- **Um tenant quebrado não derruba os outros**: `_migrations`, DDL e dados são independentes.

O que **perdemos**:
- O teto de escala de conexões (§4.3) — nomeado, medido e com saída.
- Migração de schema = migração em N schemas (mas com lock por schema, e o backup pré-deploy
  do CI já é o mecanismo de rollback — ver §6).

---

## 3. Arquitetura

### 3.1 Fluxo de um request

```
                    ┌───────────────────────────────────────────────────────────────┐
  POST /api/orders  │ Caddy  (*.labolabe.tech, tls on_demand) → reverse_proxy        │
  Host: ana-terra.… └──────────────────────────────┬────────────────────────────────┘
                                                   │
                    ┌──────────────────────────────▼────────────────────────────────┐
                     │ onRequest #1 — resolveTenant        http/middlewares/tenant.*     │
                     │   ⚠️ A FUNÇÃO JÁ EXISTE (Fase 1):                                    │
                     │     application/tenant/resolve-tenant.usecase.ts#resolveTenant       │
                     │     ⚠️ O onRequest que a chama é a Fase 2 — hoje NENHUM request       │
                     │        usa o schema resolvido (§6, Fase 1).                         │
                     │                                                                        │
                     │  host = (x-forwarded-host ?? host).split(":")[0]   ← trustProxy     │
                     │  1ª label ∈ {www, app, api}   → DEFAULT_TENANT_SCHEMA (nem registry) │
                     │  custom_domain casa o host    → o tenant dele                        │
                     │  localhost | apex (== ROOT_DOMAIN) → DEFAULT_TENANT_SCHEMA           │
                     │  subdomínio → slug = 1ª label                                       │
                     │  slug fora de ^[a-z0-9][a-z0-9-]*$  → 404 (NUNCA default)            │
                     │  TENANT_ROUTING=false → default, sem olhar o Host (kill-switch)      │
                     │                                                                        │
                     │  tenant = await findTenantBySlug/findTenantByHost   ← cache 60s      │
                     │     SELECT slug, schema_name, status FROM public.tenant              │
                     │     status ≠ 'active' → tenant_inactive (403)                        │
                     │     não existe       → tenant_not_resolved (404)                      │
                     │                                                                        │
                     │  req.tenant = { slug, schema_name }                                │
                     │  tenantContext.enterWith(req.tenant)      ← ALS entra AQUI (Fase 2) │
                    └──────────────────────────────┬────────────────────────────────┘
                                                   │
                    ┌──────────────────────────────▼────────────────────────────────┐
                    │ preHandler — authMiddleware   JWT { sub, role, t: schema }        │
                    │   payload.t ≠ req.tenant.schema_name → tenant_mismatch (403)      │
                    └──────────────────────────────┬────────────────────────────────┘
                                                   │
                    ┌──────────────────────────────▼────────────────────────────────┐
                    │ handler — SEM MUDANÇA (loginUsecase, addItemsUsecase, …)          │
                    │                                                                        │
                    │   db.select()…              ← `db` é o Proxy de client.ts         │
                    │   db.transaction(async tx => { … })                                 │
                    │     └─► tenantDb(schema)   ← Map + LRU                            │
                    │           Pool({ options: '-c search_path=tenant_x,public,pg_temp'│
                    │                  max: TENANT_POOL_MAX (4) })                       │
                    │           drizzle(pool, { schema })                                  │
                    │           target.transaction(cb)  ← cb recebe Tx JÁ no schema        │
                    └──────────────────────────────┬────────────────────────────────┘
                                                   │
                    ┌──────────────────────────────▼────────────────────────────────┐
                    │ startOutboxDispatcher() — 1 timer de 200ms, itera tenants          │
                    │   runInTenant(t, () => pollOutboxOnce(t))                          │
                    │     tryWithAdvisoryLock('pdv:outbox:owner:tenant_x')  ← por tenant │
                    │       tx → 50 pendentes → wsGateway.broadcastToRoom(t, room, ev)   │
                    └────────────────────────────────────────────────────────────────┘
```

### 3.2 Schema de controle (`public`)

> **Implementado (Fase 1).** O que está no arquivo hoje tem uma coluna a mais que
> o DDL original e um ajuste na heurística do apex — ambos anotados abaixo.

```sql
-- backend/migrations/registry/0001_tenant_registry.sql
-- ⚠️ NÃO entra em backend/migrations/ — se entrasse, rodaria dentro de cada schema de tenant.
CREATE TABLE IF NOT EXISTS public.tenant (
  slug          TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  schema_name   TEXT NOT NULL UNIQUE CHECK (schema_name ~ '^tenant_[a-z0-9_]+$'),
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  custom_domain TEXT CHECK (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  created_at    TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_custom_domain
  ON public.tenant (lower(custom_domain)) WHERE custom_domain IS NOT NULL;

-- A extensão PRECISA morar em public. Ver §5.1 — sem isso o tenant 2 quebra.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
```

**`custom_domain` (acréscimo ao DDL original).** O primeiro cliente real
(`umamisushiarte.com.br`) é um **domínio próprio**, e a regra do §3.1 — "1ª label
de um host com 3+ partes é o slug" — resolve `umamisushiarte`, que não é a loja
(`umami`): sem esta coluna o endpoint daria 404 numa loja que existe. É coluna
nova, `NULL` por default (tenant por subdomínio não precisa), e não toca no
`CHECK`/`UNIQUE` do `slug` nem do `schema_name`. O índice único é sobre
`lower(custom_domain)` porque host é case-insensitive: com `UNIQUE` na coluna,
`Loja.com.br` e `loja.com.br` poderiam ser duas lojas disputando o mesmo
endereço, e o `Host` do request não diria qual vence.

**`display_name` não é a origem do nome exibido.** O `name` que o
`/public/tenants/resolve` devolve vem de `store_settings.merchant_name` do schema
do tenant (mesma fonte do `/store-info`), para vitrine e login nunca discordarem.
`display_name` é o rótulo do registry para o operador — provisionamento e, mais
tarde, `/health/tenants` (Fase 5).

**O que ainda não existe no registry:** `is_default` (citado no passo 8 do §6.2
mas ausente do DDL original) e `phone_number_id` (fan-out do WhatsApp, R13). A
Fase 1 resolve o tenant default pelo **ambiente** (`DEFAULT_TENANT_SCHEMA`), e não
por uma linha do registry — que é coerente com o `CHECK` do `schema_name`, que
não aceita `public` (o schema default **até** o cutover da Fase 7).

Por que `public`: é garantidamente o último elo de qualquer `search_path` do projeto, inclusive o
das conexões de tenant. `information_schema` é read-only por design. Um schema dedicado
exigiria qualificar à mão ou tirar `public` do caminho.

O `CHECK` no `schema_name` não é decoração: **o nome do schema vem do registry, nunca do request**.
Sem a barreira, um slug mal resolvido cai silenciosamente em `public` — que é exatamente o modo de
falha que `pg` não acusa. Por isso o código **repete** a validação
(`domain/tenant.ts#isValidTenantSchemaName`) antes de usar o valor: o `CHECK` é a
primeira barreira e a segunda existe para o dia em que o constraint cair — a
suíte remove o constraint e prova que a linha corrompida é recusada em código.

### 3.3 Realtime — particionar o gateway, não prefixar a room

O `WsGateway` (`infra/realtime/ws-gateway.ts`) é um **singleton de processo** e as rooms são strings
globais: `kitchen-display`, `cash-drawer`, `deliveries`, `inventory`, `alerts:<role>`. Com N lojas
no mesmo processo, **o gerente de A ouviria a gaveta de caixa de B** — vazamento de dado financeiro
entre lojas. É o risco mais grave do desenho (R1).

Decisão: `Connection` ganha `tenant`; o gateway passa a indexar por tenant
(`Map<tenant, Set<Connection>>`); `broadcastToRoom(tenant, room, event)` só alcança conexões do
mesmo tenant; `canJoinRoom` valida contra o tenant da conexão.

**O nome da room no wire continua `cash-drawer`.** O cliente não muda uma linha — `useRealtime`,
`usePublicRealtime`, `waiter:<id>`, `alerts:<role>`, `order:<uuid>` seguem idênticos. Não vamos
prefixar a string no wire: isso custaria 8 arquivos de frontend + risco de divergência entre o que
o cliente pede e o que `canJoinRoom` autoriza, sem ganhar nada.

`GET /realtime/public` (vitrine, sem token) resolve o tenant pelo `Host` e é particionado igual.

> ⚠️ **Duas implementações enquanto coexistem — e o R1 vale para as duas.** Desde `3e5e8cd` (PR #55)
> o repo tem um segundo gateway, Go (`ws-gateway/`), destinado a **substituir** a responsabilidade
> de realtime do Node (`backend/src/infra/realtime/`). Ele está **plugado no `deploy/`** (serviço
> `ws-gateway` nos três compose, upstream próprio `PDV_WS_UPSTREAM` no Caddy, flag `WS_BACKEND`) e
> ficou **deployável** em `b01000b` (PR #76), mas **o corte não foi marcado**: sem `WS_BACKEND=go`
> nem a linha de ponteiro, o `/realtime*` continua indo para o backend Node.
>
> **O particionamento por tenant acima é obrigatório nos DOIS enquanto eles coexistirem** — e o
> gateway Go está hoje **mais longe** que o Node nos três mecanismos, verificado no código:
>
> | | `search_path` por tenant | rooms particionadas | lock de outbox por tenant |
> |---|---|---|---|
> | Node (`backend/src/infra/realtime/`) | Fase 2 (ALS + pool dedicado, §4.2) | Fase 4 | Fase 4 (`lockName(base, schema)`) |
> | **Go** (`ws-gateway/`) | ❌ **não existe**: `internal/db/connect.go:31` é um `sql.DB` único com `SetMaxOpenConns(25)` e `search_path` default; nenhum `tenant` no módulo inteiro | ❌ **não existe**: `internal/roommanager/` indexa rooms por string, e `internal/connmanager/connmanager.go:261-293` (`BroadcastToRoom`) entrega a **todas** as conexões que assinam a room, sem filtro de loja | ❌ **não existe**: `internal/outbox/outbox.go:33` trava `pdv:outbox:owner`, um nome só, global |
>
> Ou seja: um gateway Go ligado **hoje**, com o Caddy apontando `/realtime*` para ele, vazaria dado
> financeiro entre lojas nos **três** eixos — e o `GO-GATEWAY-PLAN.md` **não tem fase de
> multi-tenant** (as fases dele são a migração Node→Go), então nada disso está previsto lá. Isso
> entra na auditoria em `docs/16-pendencias.md` §4.
>
> Quando o Go virar o caminho vivo de `/realtime*`, o código Node equivalente pode ser removido — e
> o JWT pode carregar `t: <schema>` (§4.5) porque o Go lê o mesmo segredo, então a validação espelha
> o Node sem contrato novo. Mas o particionamento é **pré-requisito do corte**, não consequência
> dele.

---

## 4. Decisões e o que foi descartado

### 4.1 Como o `db` escopado chega aos 43 arquivos

| Opção | Custo medido | Veredito |
|---|---|---|
| Passar `db`/`Tx` como parâmetro | 43 arquivos + **209 call-sites de use case** em `http/routes` + 62 `db.transaction` (medido no HEAD `0cb6c06`; o doc dizia 67, número da redação anterior). E a onda não para: `withIdempotency(endpoint, …)` recebe um `handler` que fecha sobre o `db` do módulo; `getStoreSettingsUsecase()` (sem argumento, chamada de `/store-info`, do menu público e do self-service) arrastaria 10 arquivos. **12-18 dias** mecânicos, ganho de segurança zero. | ❌ |
| Só ALS + proxy sobre o pool único | Resolve o contexto, **não** o isolamento: `pool.connect()` devolve qualquer conexão e um `SET search_path` no checkout vaza. | ❌ |
| Só `req.db` injetado | Só é alcançável se algo o passar ao use case → é a 1ª opção de novo, com uma camada extra. | ❌ |
| **ALS (transporte) + pool dedicado por tenant (barreira)** | **0 arquivos alterados** nos 43. O ALS é só o transporte; o pool dedicado é a barreira. | ✅ |

ℹ️ **Como foram contados os 43 e as 241 (2026-10-04, HEAD `0cb6c06`).** O número que importa é o de
arquivos que importam **o símbolo `db`**, não o de quem importa algo do módulo:

```
# arquivos que importam o símbolo `db` (43)
grep -rlE "import \{[^}]*\bdb\b[^}]*\} from ['\"][^'\"]*db/client" backend/src backend/test backend/scripts
  28 em src/application/ · 3 em src/http/ · 9 em src/integrations/ · 1 em src/infra/locks.ts
  + backend/test/helpers.ts + backend/scripts/migrate-uploads-layout.ts

# ocorrências de `db.` (241) — só em src/, que é o que o produto executa
grep -roE "\bdb\." backend/src | wc -l     # 241  (219 em application/ + http/ + integrations/)
```

Quem importa o módulo sem o símbolo (`server.ts`, `audit-log.ts`, `outbox-dispatcher.ts`,
`client.ts` e os testes) não entra na conta dos 43 — para eles o ALS também não muda nada, porque
não consomem `db`.

O ALS é honesto aqui porque, no schema-por-tenant, o tenant é **inerentemente ambiental**
(`search_path`) — o ALS representa o conceito, não um atalho. E o acesso sem contexto **lança**
(flag `TENANT_STRICT`), em vez de cair num default silencioso.

### 4.2 Como o `search_path` é aplicado — a reconciliação

Dois pareceres divergiram, ambos tecnicamente defensáveis. A decisão:

> **Pool dedicado por tenant com `options` no startup packet.**

| Opção | Veredito |
|---|---|
| `Pool` dedicado, `options: '-c search_path=tenant_x,public,pg_temp'` | ✅ **Recomendada.** Fixado no *startup packet*: impossível "esquecer de reaplicar", e o pool só fala com aquele schema. `pg_temp` por último elimina o sombreamento (§4.6). Transação herda o `search_path` de graça. |
| `SET search_path` de sessão em `acquire`/`connect` | ❌ `pg.Pool` não tem hook confiável de *release*. Uma conexão devolvida suja é **o** vazamento clássico, e basta um caminho de erro (timeout) para cruzar dados de loja. |
| `SET LOCAL search_path` em cada transação, **pool compartilhado** | ⚠️ **Correto e melhor em escala** (conexões não multiplicam por N), mas exige que **todo** acesso esteja dentro de `db.transaction` — e das 241 ocorrências de `db.`, a maioria está fora (`getStoreSettingsUsecase`, `loginUsecase`, `printer.usecases`, `whatsapp/state`). Envolver cada leitura numa transação muda a semântica de concorrência do produto (hoje cada query é sua transação implícita): é regressão escondida, não refatoração. **Guardado como plano B** (§4.3). |
| Schema-qualified em todas as queries | ❌ Inviável (31 KB de `schema.ts` multiplicado por tenant, gerado em runtime) e não resolve o SQL cru (`load-menu.ts`, `raw.exec` dos testes, os `.sql`). |

### 4.3 Teto de escala — nomeado, medido, com saída

```
max_connections                          = 100   (medido em produção)
- superuser_reserved_connections         =   3
- autovacuum/bgwriter                    ≈   5
─────────────────────────────────────────────────────
disponível                               ≈  92
- 2 instâncias backend durante o switch (~15 s), backup, provisionamento
─────────────────────────────────────────────────────
orçamento                                ≈  80
```

Com pool dedicado: `TENANT_POOL_MAX × N × 2 ≤ 80`. Mínimo útil de `TENANT_POOL_MAX` é 3
(1 transação + 2 avulsas, comentário em `client.ts:13-14`):

| N tenants | `TENANT_POOL_MAX` possível | Veredito |
|---|---|---|
| 10 | 4 | viável |
| **20** | **2** | **no limite** |
| 30 | 1 | impossível |

**Teto honesto: ~20 lojas.** Com `TENANT_POOL_MAX=4` e uma cerimônia de restaurante, 3 lojas
simultâneas = 12 conexões — folgado. `pg.Pool` **não reserva** conexões (`max` é teto), então o
custo por tenant ocioso é zero.

Escoras (barreiras que não dependem do código):
- `TENANT_POOL_MAX_TOTAL` (env, default 16) → 503 explícito, não `max_connections` estourado.
- `ALTER ROLE pdv_app CONNECTION LIMIT 30` → o app nunca derruba o banco.
- `ALTER ROLE pdv_app SET lock_timeout='5s'`, `idle_in_transaction_session_timeout='60s'`,
  `statement_timeout='30s'` (⚠️ revisar: relatório de gerente pode passar de 30s — P2).
- `application_name` por processo (`pdv-backend`, `pdv-backend-next`, `pdv-provision`,
  `pdv-backup`) — hoje a coluna vem vazia e `pg_stat_activity` não distingue nada.

⚠️ **A calibragem do `/health` do gateway Go não é uma dessas escoras.** O teto de 2 perguntas em
andamento e o `healthStaleAfter` de 3s foram medidos para **um** pool de 25 conexões; com N pools
eles viram gargalo **antes** de o healthcheck do compose desistir. Ver §5.11.

**Se N passar de ~20**, o passo não é PgBouncer (quebraria o `options` do startup packet): é
migrar para **pool compartilhado + `SET LOCAL`** com um wrapper `withTenant` que **impeça**
`db.` fora dele — e isso precisa vir acompanhado de um `grep` no CI barrando `import { db }`
novo. É o plano B já desenhado, e é por isso que a escolha do `Proxy` (ALS) é a mesma nas duas
rotas: só o `tenantDb()` muda de implementação.

### 4.4 Cache

`MemoryCache` é singleton de processo e hoje a chave `"store-settings"` é global — vazaria entre
lojas. Envelope: `` `${schema}:${key}` `` (**schema**, nunca `slug`: `slug` é mutável). E a
invalidação precisa ser **por prefixo** (`cache.invalidatePrefix(schema)`), senão salvar o logo da
loja A invalida as N. TTL 300s mantido.

### 4.5 Login / JWT

`AuthUser` ganha `t: string` (o `schema_name`). `authMiddleware` compara com `req.tenant` →
`tenant_mismatch` (403). O **Host é a autoridade**; o JWT precisa concordar — é a semântica que a
versão removida já tinha e funcionava.

`GET /auth/users` fica escopado **de graça**: ele passa a ler `user` e `store_settings` do schema
do subdomínio. Nenhum endpoint novo de controle é necessário para o app (§7).

### 4.6 `pg_temp` por último — não é detalhe

Sem `pg_temp` explícito no fim, qualquer `CREATE TEMP TABLE` na sessão sombreia a tabela do tenant.
Reproduzido: temp com 1 linha vs. tabela real com 2 → a query sem qualifier viu **1**.

### 4.7 Uploads: layout por tenant, não o banco nem S3

Hoje há **4 implementações duplicadas** de upload em disco, cada uma com seu próprio
`uploadsDir()` e seu próprio `removeFile()`: `product.usecases.ts:298-356`,
`store-settings.usecases.ts:163-217`, `user.usecases.ts:147-175`, `customer.usecases.ts:296-324`.
E 4 colunas que guardam **só o basename** (`products.image_path`, `store_settings.logo_path`,
`user.photo_path`, `customer.photo_path`).

Decisão: **porta de storage em disco local, com a chave por tenant**.

```
<uploadsDir>/<schema>/<kind>/<filename>      kind ∈ product | logo | customer | user
uploads/public/logo/logo.png
uploads/public/product/0f9c….webp
```

- **O banco não muda**: as 4 colunas continuam guardando só o basename, `logo_path` mantém o
  significado de hoje e **nenhuma migration SQL** é necessária.
- **A API passa a devolver `/uploads/<kind>/<filename>`** (um segmento a mais). O **frontend não
  muda**: ele só faz `assetUrl(imagePath)` e trata o valor como URL opaca (§7).
- **O `@fastify/static` sai**: vira rota explícita `GET /uploads/:kind/:filename` que resolve o
  schema do tenant pelo `Host` (o mesmo caminho do ALS, §3.1) e serve de dentro de
  `<uploadsDir>/<schema>/<kind>/`. O schema **não** vai na URL — é por isso que a URL da loja A dá
  **404** na loja B (§5.3). `deploy/Caddyfile:62-64` e o volume de `docker-compose.yml:106` seguem
  iguais: só o backend muda.
- **As 4 cópias viram uma**: `src/infra/storage/` — porta `FileStorage` (`put`/`get`/`remove`/
  `exists`) + adapter `LocalDiskStorage`, com **uma** função que resolve o schema do tenant
  (`resolveTenantSchema`, em `storage/tenant.ts`) — hoje só `DEFAULT_TENANT_SCHEMA ?? "public"`,
  trocada pela leitura do ALS na Fase 2. É o mesmo formato de **0 arquivos alterados nos 42** que o
  §4.1 defendeu para o `db`.
- **Migração do dado em disco**: `backend/scripts/migrate-uploads-layout.ts`
  (`npm run uploads:migrate-layout`, com `--dry-run` / `--copy` / `--revert`). Lê as 4 colunas para
  classificar cada arquivo do layout flat — um `<uuid>.png` solto não é classificável por nome — e
  é idempotente. Nenhuma migration, nenhum UPDATE: a coluna continua com o basename.

**Por que não `bytea` no banco.** O plano vende `pg_restore -n tenant_x` como mecanismo de rollback
(§2, §8, R12) e `DROP SCHEMA … CASCADE` como eliminação LGPD **atômica** (§2, §8). Binário dentro
do schema quebra as duas: o rollback de uma loja passa a arrastar MB de imagens, e a eliminação deixa
de ser uma instrução (o espaço volta no `VACUUM`, não no `DROP`).

**Por que não S3 agora.** (a) Não compra isolamento sozinho — bucket sem chave-por-tenant +
validação é o mesmo bug (§5.3) com atraso. (b) Se for presigned URL, o `Caddyfile:62-64` e o `logoUrl`
do frontend mudam: não é "só apontar para outro lugar". (c) O volume **já** sobrevive a deploy
(`docker-compose.yml:106` monta `pdv_backend_uploads` nas duas instâncias) e **já** entra no backup
(`backup.sh:61` pega o volume inteiro) — o problema é o **layout**, não a mídia. Adiar deixa a porta
pronta: quando S3/R2 entrar, é troca de adapter em `src/infra/storage/`, não reescrita.

> A Fase 5 já trazia o remendo `logo-<schema>.<ext>`. Ele foi **superado** por esta decisão
> **antes de ser implementado** — de propósito: consertava a §5.2, não fechava a §5.3, e seria
> jogado fora na mesma fase. Confirmado: o remendo **não** entrou no `d30ec49` (PR #73).

### 4.8 A chave é o `slug` no `Host` — e o Caddy não precisa mudar de rota

> **Decisão do dono (2026-10-04): a identificação do tenant é o `slug` do subdomínio no `Host`, não
> um token. O `schema_name` sempre vem do registry `public.tenant` (que tem `CHECK`, §3.2), nunca do
> request.**

**Por que `slug` e não token.** Um token de tenant no `Host`/`X-Tenant` é **capacidade**, não
identidade: ele precisa ser emitido, distribuído, revogado e guardado pelo cliente, e um bearer
trocável por engano manda o usuário para a loja errada sem nenhum sinal. O `slug` é **legível**,
já é o que o usuário digita, e o registry é a única autoridade que decide se ele existe:

| | `slug` no `Host` (escolhido) | token de tenant |
|---|---|---|
| **Configuração por loja** | **zero**: o `slug` é o próprio subdomínio que o cliente já digita. `*.labolabe.tech` já existe e casa qualquer loja nova | exige emitir e distribuir o token e ensinar o cliente a enviá-lo; o provisionamento vira duas operações, não uma |
| **Risco de falsificação** | **baixo e limitado**: o `slug` é público no próprio endereço; o dano é o mesmo de abrir outra aba do próprio site. O `schema_name` nunca vem do request (§3.2) — quem decide é o `Host`, não a URL | **alto**: quem vazar o token de A navega como A; revogação é trabalho extra |
| **Exposição da lista de clientes** | **não expõe**: subdomínio desconhecido → **404**, e não existe endpoint que enumere lojas (§7). O DNS público ainda denuncia o slug, mas o slug não é segredo | depende do transporte; token em header é invisível no endereço, o que só ajuda se ele for **não-rotacionável** |
| **Debug** | **ganho**: `curl -H 'Host: slug-b.labolabe.tech'` reproduz qualquer falha; logs e `pg_stat_activity` mostram um `Host` legível | **perda**: cada call-site de log precisa decodificar o token para virar slug |

**Regra de ouro.** `slug` fora de `^[a-z0-9][a-z0-9-]*$` → **404, e NUNCA o default**. O
`DEFAULT_TENANT_SCHEMA` atende **só** o apex e `localhost` (§3.1) — o caminho de menor segurança é
o de conveniência, então ele não pode ser o de erro. (E vale notar: `127.0.0.1:5173` **cai em slug
`127`** — `parts.length ≥ 3` é verdadeiro e `127` casa o regex — então o dev por IP passa a dar
404 de tenant; é o mesmo 404 que um subdomínio inexistente dá, ver §7.)

**O Caddy não precisa mudar de roteamento.** Isto é o que fecha o §1 ("o que não muda"):

- O wildcard `*.labolabe.tech` **já existe** (`deploy/Caddyfile:205-210`) — uma loja nova não
  pede DNS, certificado nem rota nova.
- **Zero `header_up`/`header_down` em todo o `deploy/`** (verificado por grep): o Caddy não reescreve
  nada, então o `Host` chega **intacto** no backend, que é exatamente o que o `resolveTenant` (§3.1)
  quer ler. Não há e não será proxy de tenant no edge.
- **O backend não é exposto no host**: o serviço `backend` (`deploy/docker-compose.yml`) não tem
  `ports:` nem `expose:`, e o compose de produção nem tem serviço de proxy — em produção o único
  que publica `80`/`443` é o Caddy no **host** (unit systemd `pdv-caddy`; local, o serviço `caddy`
  do compose). Ou seja, não existe caminho alternativo para o `Host` vir de outro
  lugar.
- **O único ponto do Caddy que muda é o `ask` do TLS on-demand** (`deploy/Caddyfile:15-18`): ele
  continua apontando para `GET /internal/caddy-on-demand-tls`, mas esse endpoint passa a consultar o
  registry em vez do regex (§5.8).

**Contrafluxo documentado.** Se algum dia o Caddy passar a **injetar** header de tenant
(`X-Tenant`), as duas condições abaixo são obrigatórias e o desenho quebra sem elas:

1. o header tem que ser **`header_up` incondicional** (valendo para todas as rotas, inclusive as que
   não têm tenant) — condicional, basta uma rota sem o header para o `resolveTenant` cair no
   default silenciosamente;
2. o backend tem que **descartar** qualquer header de tenant **vindo do cliente**. Sem isso, o header
   injetado é sobrescrevível pelo cliente e o `Host` deixa de ser a autoridade (§4.5) — vira o
   header-falsificável que a tabela acima rejeita. Enquanto não houver header, essa defesa é
   estrutural: não existe o que forjar.

---

## 5. Achados que bloqueiam a produção (bugs reais, não hipóteses)

Cada um foi verificado no código ou reproduzido num Postgres descartável.

### 5.1 ✅ FECHADO — `unaccent` quebrava a partir do 2º tenant

**Achado original (mantido como registro).** `0003_profile_fields.sql` fazia
`CREATE EXTENSION IF NOT EXISTS unaccent;` **sem `WITH SCHEMA`**. O Postgres instala no **primeiro
schema do `search_path`** — ou seja, dentro do schema do **tenant 1**. Resultado medido: um tenant
novo recebia `ERROR: function unaccent(unknown) does not exist`, e `unaccent()` é chamada sem
qualifier em `application/customer.usecases.ts:72,74`, `application/product.usecases.ts:29`,
`application/stock/stock.usecases.ts:182` — **toda busca por nome quebraria do tenant 2 em diante**.

**Resolvido em `bf75736` (PR #64), pelo §6.0.** O baseline único já traz o fix:
`backend/migrations/0001_init.sql:27` → `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;`
— exatamente a receita que a §6.0.0 pedia no passo 2.

Por que o achado apontava um arquivo que **não** roda: o SQL problemático está na cadeia
**arquivada**, `backend/migrations/archive/0003_profile_fields.sql:11`, que está **fora do glob do
runner** — `backend/src/infra/db/migrate.ts:37-41` lê só `migrations/*.sql` (`.endsWith(".sql")` +
sort) e `archive/` é um diretório. Os arquivos da §5.10 ("duplo `0003_` não é bug") não são
executados desde o cutover.

Correção que **continua valendo** para quando o registry existir: o runner do registry instala
`unaccent WITH SCHEMA public` **antes** de qualquer migration de tenant. Verificado: extensão já
instalada em `public` → `CREATE EXTENSION IF NOT EXISTS` no schema do tenant vira no-op
(`NOTICE: … skipping`), não tenta instalar cópia.

### 5.2 ✅ FECHADO — `logo.<ext>` colidia entre lojas

**Achado original (mantido).** `store-settings.usecases.ts` gravava `logo.${ext}` num **diretório
único** (`config.uploadsDir`). **Loja B fazia upload → sobrescrevia `logo.png` → loja A exibia o
logo da loja B** em todas as telas e na vitrine pública. Determinístico, não colisão teórica.

**Resolvido em `d30ec49` (PR #73).** A correção não foi o nome do arquivo, foi o **layout**
(`<uploadsDir>/<schema>/<kind>/<arquivo>`, §4.7):

- porta `FileStorage` + adapter `LocalDiskStorage` (`backend/src/infra/storage/storage.ts`,
  `local-disk-storage.ts`) — **as 4 implementações duplicadas colapsaram em uma** (o código anterior
  tinha um `uploadsDir()` e um `removeFile()` próprios em `product`, `store-settings`, `user` e
  `customer`);
- o `logo.${ext}` flat **não existe mais**: o destino passou a ser `<uploadsDir>/<schema>/logo/…`;
- **o `@fastify/static` saiu** de `backend/src/http/server.ts` e de `backend/package.json` — não há
  mais nenhuma ocorrência; `server.ts:87-96` é hoje só o `initStorage()` + o
  `register(uploadsRoutes)`.

### 5.3 ✅ FECHADO — `/uploads/*` era público e sem fronteira de tenant

**Achado original (mantido).** Era o mais grave **entre os de upload**: **o storage não tinha
isolamento nenhum** — exatamente a propriedade que o schema-por-tenant promete vender.
O `@fastify/static` era registrado **no escopo raiz**, com `root: uploadsDir` e
`prefix: "/uploads/"`, e por isso **não passava por `authMiddleware`** (que cada plugin de rotas
instala via `addHook("preHandler")`). O resultado literal era
`https://loja-b.labolabe.tech/uploads/<uuid>.png` — a foto de um **cliente da loja A** —
**respondendo 200**. E não era preciso adivinhar o UUID: a URL aparece no payload de API que o
frontend já consome (`photoPath`, `imagePath`, `photoUrl`), no `<img src>` da vitrine pública e em
log. Gravidade: `customer.photo_path` e `user.photo_path` são **dado pessoal** (LGPD).

**Resolvido no mesmo `d30ec49` (PR #73).** Quem serve agora é a rota explícita
`GET /uploads/:kind/:filename` (`backend/src/http/routes/uploads.routes.ts:51`), que resolve o
schema pela **seam** (`resolveTenantSchema()`, `backend/src/infra/storage/tenant.ts:18-20`) e lê de
`<uploads>/<schema>/<kind>/`. O schema **não** vai na URL — por isso a URL da loja A dá **404** na
loja B por construção. O `@fastify/static` deixou de existir, então a rota pública plana deixou de
existir junto. E o `rm -rf uploads/<schema>` do §8 (eliminação de tenant) passou a ser **exato**,
que era o outro lado do mesmo achado.

**Pendência que sobra (é a Fase 2, não esta).** A seam `backend/src/infra/storage/tenant.ts:18-20`
ainda devolve `process.env.DEFAULT_TENANT_SCHEMA ?? "public"` — correto enquanto há uma loja só, e
o comportamento está fixado em teste (`backend/test/uploads.test.ts:203-211`). Quando a Fase 2 ligar
o ALS, a troca é **só o corpo dessa função**; a rota e os use cases não mudam.

### 5.4 🔴 `WsGateway` singleton com rooms globais

Vazamento de dado financeiro entre lojas (§3.3).

### 5.5 🟠 `pdv:server` no web vaza imagem entre tenants (e **não** troca de API)

O modal "Servidor" do login (`frontend/src/pages/login/LoginPage.jsx:219-232`) é editável **no
navegador** e salva a URL em `localStorage["pdv:server"]`
(`frontend/src/shared/lib/server.js:12`).

**Correção de uma afirmação anterior deste doc:** colar `https://slug-b.labolabe.tech` **não** faz o
app "falar com a loja B". O `pdv:server` alimenta exatamente **dois** consumidores, ambos no
`server.js`: `assetUrl()` (`:98-102`) e `fetchTag()` (`:73-82`). Ele **não** alcança
`apiBase()` (`frontend/src/shared/lib/appConfig.js:76-78`) nem `wsEndpoint()` (`:94-106`), porque
`setAppConfig()` só roda com valor no **desktop** — `loadAppConfig()` retorna `null` no web
(`frontend/src/app/providers/app-config/api.js:8-11`) e o provider publica `null`
(`frontend/src/app/providers/app-config/AppConfigProvider.jsx:26-28`). No web, portanto, REST e
realtime seguem na mesma origem, e trocar o `pdv:server` **não** troca de loja.

O risco real é mais estreito, e continua valendo:
- **imagem cross-origin**: `assetUrl()` prefixes a base salva, então o `<img src>` de produto, logo,
  cliente ou usuário passa a buscar na **outra** loja. Vazamento de dado de cliente pela vitrine e
  pelos avatares — e a imagem nem é checada pelo CORS.
- **`fetchTag()` engole erro**: o `catch` (`:79-81`) devolve `null` sem sinalizar, então a tela de
  login mostra "sem tag" em vez de "endereço errado" — falha silenciosa na configuração.

Fechar por `isDesktop()` continua certo, **por outro motivo**: o `pdv:server` é uma configuração
**por dispositivo** do app desktop (para apontar o app a um servidor remoto). No web ele não tem
função nenhuma — a origem **é** o servidor. (E note: `apiUrl`/`wsUrl` do `server.js` não são
importados por ninguém no app hoje; `apiBase`/`wsEndpoint` é que são.)

### 5.6 🟠 `/health` não pode resolver schema de tenant

`/health` é o **portão do `switch.sh`** e é martelado a 5 req/s pelo `probe-availability.sh`. Se
resolver o schema do tenant e ele não estiver provisionado → 503 → deploy abortado.
`/health` fica **O(1) no registry**; a verificação por tenant vai para `/health/tenants`, que roda
**depois** do switch e só avisa.

> **Ainda aberto, e a Fase 1 não mexeu nele.** `/health` segue sendo `SELECT 1`
> (`server.ts` → `checkDatabaseHealth()`), sem tocar no registry — que é o comportamento
> seguro do §5.6 e o que mantém o switch funcionando. `/health/tenants` (a verificação por
> tenant, pós-switch) continua **não implementado**: é item da Fase 5.

### 5.7 🟠 Os 3 composes dividem os mesmos volumes

`docker-compose.yml`, `.local.yml` e `.dev.yml` declaram todos `pdv_postgres_data`,
`pdv_backend_uploads` (o `pdv_caddy_data` agora só nos composes `local`/`dev`: em produção o
proxy sai do Docker e os certs moram em `/var/lib/caddy` no host — ver `deploy/caddy-host.sh`).
Consequência **já presente**: subir o stack de dev aplica
`runMigrations()` **nos schemas de tenant da produção**. Com multi-tenant isso vira incidente de
dados. O `deploy/reset.sh` apaga os volumes `pdv_*`, incluindo o de produção — só os de certs do proxy (`pdv_caddy_*`) ficam de fora.
→ Antes de qualquer código: dar nome próprio ao stack de dev e exigir confirmação por nome no
`reset.sh`.

### 5.8 🟡 `/internal/caddy-on-demand-tls` emite certificado para qualquer subdomínio

`server.ts:120-124` valida só `^[a-z0-9-]+\.labolabe\.tech$` (o regex em `:122`). Um scanner de subdomínios pode
estourar o **limite de taxa do Let's Encrypt** (5 duplicados/semana) e travar o on-demand de um
tenant real. Trocar o regex por consulta ao registry (permitindo `suspended`, recusando
desconhecido).

> **Continua aberto.** A Fase 1 **não** tocou nesse endpoint (é Fase 5): o regex segue como
> está, e o registry agora é a fonte que ele vai consultar quando chegar. Regra que a
> consulta vai ter que respeitar: `suspended` **libera** (o dono precisa ver a página de
> suspensão, §8), desconhecido **recusa**.

### 5.9 🟡 `CORS_ORIGIN` enumerado não escala

`deploy/.env.example:18` lista subdomínios um a um. Cada loja nova = editar `.env` + reiniciar as
duas instâncias. Recomendação: função `origin` no `@fastify/cors` validando o host contra o
registry (cache 60s). ~30 linhas em `server.ts`.

### 5.10 ℹ️ Não-bugs (verificados, para não gastar tempo)

- **Duplo `0003_` não é bug**: `migrate.ts` chaveia por **filename completo** e o sort é
  lexicográfico. Já documentado em `docs/agent-backend.md:63`.
- **`0012_remove_multi_tenant.sql` não entra no baseline**: na consolidação (§6.0) ela desaparece —
  seu efeito líquido (drop de colunas/índices `store_id`, drop da tabela `stores`) já é o estado
  atual, refletido pelo `pg_dump --schema-only`. Dublicar seu SQL no baseline só poluiria o DDL.
- **`backup.sh` já cobre N schemas**: `deploy/backup.sh:57` faz `pg_dump -Fc` **sem `-n`** —
  dumpa o banco inteiro. Nenhuma mudança obrigatória (opcional: manifesto por dump, detecção de
  tenant omitido, e **retenção** — hoje o script nunca apaga nada).
- **Frontend não precisa mudar** (§7).
- **`backend/data.db{,-shm,-wal}`** estão versionados no git — resíduo do SQLite removido.
  Candidato a remoção.

### 5.11 🟠 A probe de banco do `/health` do gateway Go foi calibrada para **um** pool

Achado de 2026-10-04, na esteira de `b01000b` (PR #76). Não é bug hoje — é uma **calibração que a
Fase 2 (pool dedicado por tenant, §4.3) invalida**.

O `/health` do gateway Go não pergunta ao banco a cada chamada: há uma probe com cadência fixa,
`healthPollInterval = 1s`, `healthProbeTimeout = 1s` e um teto de concorrência,
**`healthMaxInFlight = 2`** (`ws-gateway/cmd/gateway/main.go:485,496,527`), Consumida por
`handleHealth` (`:414-462`), que responde 503 quando o último "ok" passa de
**`healthStaleAfter = 3s`** (`:507`). Esse teto foi dimensionado para **um pool de 25 conexões**
(`ws-gateway/internal/db/connect.go:31`, `SetMaxOpenConns(25)`): o pior caso é 2 conexões presas
para sempre e as 23 restantes seguem com o dispatcher do outbox — que é justamente o que o endpoint
existe para proteger.

Ao migrar para **N pools por tenant**, esse "2" deixa de ser folga e vira **gargalo**: `healthMaxInFlight`
é global do processo, então ele não escala com N, e o `3s` de `healthStaleAfter` — calibrado contra
o healthcheck do container (`interval: 3s` + `timeout: 5s` + `retries: 20`,
`deploy/docker-compose.yml:267-276`) para o gateway **degradar antes de o compose desistir** — passa
a competir com o número de schemas que o probe precisa cobrir. Nenhum dos dois números sobe sozinho
com o pool dedicado. Auditoria em `docs/16-pendencias.md` §4 (o `GO-GATEWAY-PLAN.md` não tem fase
de multi-tenant).

---

## 6. Preparação — consolidar migrations e redeploy limpo

> Executar **antes** das fases 0–8. Como **nenhum cliente está usando a aplicação hoje**,
> o caminho mais limpo é: backup → zerar o banco → baseline consolidado → restaurar os dados.

Hoje o histórico de migrations é uma cadeia de 10 arquivos com irregularidades: duplo `0003_`
(`printer` + `profile_fields`), gap (`0008` é `customer_profile_fields` enquanto `0009`–`0011` foram
removidos mas existem como registro), e a `0012_remove_multi_tenant.sql` que **desfaz** o efeito das
`0008`–`0011`. Para schema-por-tenant, cada loja nova replayaria "aplicar `0008`–`0011` e depois
`0012` apagar tudo" — aplica e desfaz, por tenant novo, para sempre.

### 6.0.0 Receita

1. **Backup completo no servidor** (`./deploy/backup.sh`): `pdv-<stamp>.dump` (custom format) +
   tarball de `pdv_backend_uploads`. Copiar para fora da máquina / S3. É o rollback integral: se a
   restauração falhar, volta o serviço como estava.
2. **Extrair o DDL real do banco atual**:
   ```
   pg_dump --schema-only --no-owner --no-privileges  →  backend/migrations/0001_init.sql
   ```
   É o estado verdadeiro pós-`0012` — fonte autoritativa. Consolidar nele:
   - `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / enums com `DO $$ … IF NOT EXISTS … $$`
     (o runner aplica cada arquivo numa transação, então o SQL precisa ser tolerante);
   - `CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;` (corrige o §5.1);
   - **não** incluir a tabela `_migrations` — o runner cria sozinho.
3. **Limpar o banco**: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (e dropar qualquer
   schema de tenant residual — hoje não há). O `_migrations` renasce zerado.
4. **Remover/arquivar a cadeia velha** (`0002`–`0012`) no mesmo commit que introduz o baseline —
   o runner (`migrate.ts`) só lê `migrations/*.sql`, então borrá-las evita reexecução. A `0012`
   some por completo: seu efeito já é o estado atual.
5. **Deploy do build** com o baseline consolidado. Boot aplica `0001_init.sql` uma única vez →
   registra em `_migrations` → sobe.
6. **Restaurar só os dados** do backup:
   ```
   pg_restore --data-only --no-owner --no-privileges pdv-<stamp>.dump
   ```
   Em `-Fc` isso funciona contra o banco limpo porque o DDL vem do mesmo dump e casa. As
   `setval()` das sequências vêm junto no `--data-only`.
7. **Uploads**: extrair o tarball sobre o volume `pdv_backend_uploads` (path flat, igual ao atual —
   ainda: a migração para o layout por tenant é da Fase 5, §4.7).
8. **Verificação**: `GET /health` ok; contagens de linhas nas tabelas críticas; smoke por perfil
   (login → abrir comanda → lançar itens → pagar → fechar), conforme `docs/03-acceptance-criteria.md`.

### 6.0.1 Cuidados de verificação (antes de rodar)

- Confirmar que nenhum `.sql` de migration usa `CREATE INDEX CONCURRENTLY` (não roda em transação)
  nem funções PL/pgSQL que dependam de extensão em outro schema.
- `pg_restore --data-only` pode falhar por constraint num DDL divergente — com DDL equivalente
  costuma passar; se falhar, rodar com `--single-transaction` e revisar a primeira linha que erra.
- Tamanhos modestos (1 loja): a janela é de segundos, não de manutenção.

### 6.0.2 O baseline serve ao multi-tenant

O `0001_init.sql` consolidado passa a ser o **DDL que cada schema de tenant recebe** —
`provisionTenantSchema()` chama `runMigrations({ schema })` sobre ele, e cada loja nova nasce com o
schema exato de hoje numa única passada, sem replay da cadeia velha. Roles `pdv_app`/`pdv_dba`
e ajuste do `backup.sh` (retenção + manifesto) ficam como P1, **não** neste passo — sobe com sido,
sem mexer em conexão do app.

---

## 6. Fases

Cada fase é um PR independente, branch curta, Conventional Commit, merge na `main` → tag
automática (semantic-release) → deploy azul/verde. **Fases 1-6 não tocam o dado de produção.**
A **preparação §6.0 deve ter acontecido antes** — as fases assumem o baseline consolidado.

| # | Fase | Entrega | Risco prod | Tamanho |
|---|---|---|---|---|
| **0** | **Spike** | Teste único: ALS no `onRequest` do Fastify 5 propagando até o handler com 2 tenants concorrentes; pool com `options`; `search_path` visível; `tx` herdando; advisory lock por tenant. **Só o teste entra na `main`** — valida a única aposta arriscada do desenho. | — | 0,5 d |
| **1** | **Registry** | ✅ **FEITA** (`feat/tenant-resolve-public`): `public.tenant` em `migrations/registry/0001_tenant_registry.sql` (+ `custom_domain`), `registry-migrate.ts` (runner próprio, roda no boot **antes** das migrations de tenant), `infra/tenant/registry.ts` (cache 60s, resultado negativo também cacheado), `domain/tenant.ts` (regras puras de `Host`), `resolve-tenant.usecase.ts` (`resolveTenant` + `getPublicTenantUsecase`), `Errors.tenant*` e o endpoint `GET /public/tenants/resolve`. Kill-switch `TENANT_ROUTING` **default desligado** + `PLATFORM_ROOT_DOMAIN` (o apex de um `.com.br` tem 3 rótulos, igual um subdomínio). `tenant-routing.test.ts` (29 casos). `DEFAULT_TENANT_SCHEMA=public` → **comportamento idêntico ao de hoje**. | nenhum | 1 d |
| **2** | **`db` escopado** | `tenant-context.ts` (ALS), `tenant-db.ts` (Map+LRU), `client.ts` passa a exportar o `Proxy`. `TENANT_STRICT` desligado, ligado após 1 semana em staging. É também o que **destrava o `503 tenant_schema_unavailable`** do endpoint da Fase 1 e a seam de storage (§4.7). | baixo | 2 d |
| **3** | **Migrations por schema** | `runMigrations({ schema })`, boot iterando tenants, `provisionTenantSchema()`, `unaccent` em `public`. | médio | 1,5 d |
| **4** | **Workers, locks, realtime, cache** | Loops por tenant com stagger, `lockName(base, schema)`, gateway particionado, `tenantKey()`. | médio | 2 d |
| **5** | **Rotas sem subdomínio** | Fan-out do webhook do WhatsApp por `phone_number_id`, `/health/tenants`, on-demand TLS via registry, `printer_daemon_url` por tenant, CORS por registry. **+ porta de storage** (§4.7): `src/infra/storage/` consolidando as 4 cópias duplicadas, layout `<uploadsDir>/<schema>/<kind>/` no disco, rota `GET /uploads/:kind/:filename` que resolve o tenant do `Host` (sai o `@fastify/static`), migração one-shot idempotente dos arquivos do layout flat, API devolvendo `/uploads/<kind>/<filename>`. | médio | 3 d |
| **6** | **JWT + desligamento do single-tenant** | `t` no payload, `tenant_mismatch`, `TENANT_ROUTING=false` como kill-switch. ⚠️ O kill-switch **já existe desde a Fase 1** (default desligado); o que falta aqui é o `t` no JWT e o `tenant_mismatch`. | médio | 1 d |
| **7** | **Cutover do dado de produção** | §6.2. **Único ponto de não-retorno.** | **alto** | 1 d + janela |
| **8** | **Suítes de isolamento** | ⚠️ **PARCIAL**: `tenant-routing.test.ts` ✅ (29 casos, Fase 1). `tenant-isolation.test.ts` segue pendente — não há o que provar enquanto o `db` não for escopado (2 sockets, upload cruzado, canário de `nextval`). | nenhum | 2 d |

**Rollback.** Fases 1-6: `git revert` do merge → nova tag → deploy. O dado não volta porque
nenhum schema de produção foi tocado. **Kill-switch** para emergência sem deploy:
`TENANT_ROUTING=false` faz o `resolveTenant` devolver sempre o default, ignorando o Host.

### 6.1 O que muda no boot

```
registry-migrate()                    → garante public.tenant + unaccent em public   ✅ Fase 1
runMigrations()                       → migra o schema default (o único que existe)   ✅ Fase 1
for tenant de registry.active:                                              ⬜ Fase 3
    runMigrations({ schema })         → _migrations DENTRO do schema
workers (1 timer cada, iterando tenants com stagger)                     ⬜ Fase 4
```

⚠️ **Ordem obrigatória**: registry antes de migration de tenant. Sem isso, o `unaccent` (§5.1)
mora no schema do primeiro tenant.

> **Já vale na Fase 1:** `server.ts#main` chama `runRegistryMigrations()` e **depois**
> `runMigrations()`, no mesmo `try` — se qualquer um dos dois falhar, o boot aborta com
> `exit 1` (o container reinicia e o motivo fica no log), em vez de subir com o schema pela
> metade. Os dois runners usam **advisory locks distintos** e o do registry fixa
> `SET LOCAL search_path = public` em cada transação, então uma conexão já apontada para um
> schema de tenant não consegue desviar o DDL.

⚠️ **O boot vai ficar mais lento** (N × migrations). O healthcheck do compose dá ~65 s de
tolerância (`retries 20 × 3s + start 5s`) e estoura **antes** do `PDV_HEALTH_TIMEOUT=120`.
→ Preferir **tirar as migrations do boot** para um passo explícito do CI antes do `switch.sh`
(o boot passa a só *verificar* e falhar rápido se algo estiver pendente). É a mudança de maior
retorno aqui. **A Fase 1 não aumenta esse custo**: o registry é 1 arquivo, idempotente, e
não roda quando já aplicado.

### 6.2 Cutover do dado de produção

Hoje: **uma** loja, tudo no schema `public`, `store_settings` com uma linha (`0012` já apagou as
extras). Script **fora** do backend, com o container antigo no ar:

```
1.  ./backup.sh                                  ← já pega tudo
2.  CREATE SCHEMA tenant_default;
3.  runMigrations({ schema: 'tenant_default' })   ← DDL limpo do zero
4.  janela de escrita única (quiesce)
5.  INSERT INTO tenant_default.<tabela> SELECT * FROM public.<tabela>   -- 31 tabelas
    └─ validar com EXCEPT nas duas direções; abortar se divergir
6.  setval das 4 sequências (stock_movement, purchase, …)
7.  ALTER TABLE public.<tabela> RENAME TO <tabela>_legacy   -- 31× RENAME, NUNCA DROP
8.  INSERT/UPDATE public.tenant (slug='default', is_default)
9.  DEFAULT_TENANT_SCHEMA=tenant_default ; TENANT_ROUTING=true
10. ./backup.sh                                  ← ponto de retorno
11. uma release depois: DROPAR as *_legacy
```

**Copiar, nunca mover.** O passo 7 é `RENAME`, não `DROP`: o dado antigo sobrevive uma release
inteira. Como o baseline consolidado (§6.0) é o mesmo DDL aplicado aos dois lados, a cópia
posicional (`SELECT *`) bate na ordem de colunas; ainda assim, o `EXCEPT` do passo 5 é obrigatório.

**Rollback do cutover**: `DEFAULT_TENANT_SCHEMA=public`, `TENANT_ROUTING=false`, e as
`*_legacy` voltam a ser as tabelas de verdade (o `RENAME` é reversível). Nenhum dado foi apagado
até o passo 11.

---

## 7. Frontend: 3 arquivos de runtime — mais os que o dev e o desktop exigem

O frontend já fala **só com a própria origem** — `frontend/src/shared/lib/appConfig.js`:
`apiBase()` (`:76-78`) → `/api`; `wsEndpoint()` (`:94-106`) → `window.location.host`. O histórico
prova: os 7 commits do multi-tenant anterior **não tocaram nenhuma linha de `frontend/`**.

⚠️ **São duas configurações, não uma** — e o doc anterior só citava a primeira:

| Config | Onde | Consumidores | No web |
|---|---|---|---|
| `appConfig` (`apiBase`, `wsEndpoint`, `daemonBase`) | `frontend/src/shared/lib/appConfig.js` | REST, realtime, daemon | **sempre vazia** — `setAppConfig` só recebe valor no **desktop** (`app-config/api.js:8-11`, `AppConfigProvider.jsx:26-28`), então `apiBase()` cai em `/api` |
| `pdv:server` (`localStorage`) | `frontend/src/shared/lib/server.js:12` | **só** `assetUrl()` (`:98-102`) e `fetchTag()` (`:73-82`) | editável pelo usuário (§5.5) — `apiUrl`/`wsUrl` do arquivo não são importados por ninguém |

| Arquivo | Mudança | Motivo |
|---|---|---|
| `frontend/vite.config.js` | `changeOrigin: false` em **`/api`** e **`/uploads`** + **`server.allowedHosts`** | hoje o proxy reescreve o `Host` para `127.0.0.1:3000` e **o dev nunca vê o subdomínio** |
| `frontend/src/pages/login/LoginPage.jsx` | branch no `catch` por `e.code` (nos **dois** `catch`) + gate do modal "Servidor" por `isDesktop()` | hoje um subdomínio inexistente mostra *"Não foi possível conectar ao servidor"* — o 404 `tenant_not_resolved` do §3.1 (§5.5) |
| `frontend/src/app/router.jsx` | `assetUrl(storeSettings.logoUrl)` | **bug pré-existente do desktop**: a origem do app é `tauri://localhost`, então `src` relativo não resolve. **Não** é "com tenancy o logo passa a não carregar" — é o mesmo bug que o `assetUrl()` do `LoginPage.jsx:175` já evita |

**`/realtime`: não mexer.** `frontend/vite.config.js:62` **não tem** `changeOrigin`, e o default do
`http-proxy` é `false` — o `Host` **já chega hoje** no backend. Propor `changeOrigin: false` ali é
**no-op**. A mudança fica só em `/api` (`:58`) e `/uploads` (`:59`), que hoje têm
`changeOrigin: true`.

**⚠️ O que o §7 anterior esquecia: `server.allowedHosts` é o que estraga o dev primeiro.** A opção
não existe no `frontend/vite.config.js:54-63` e o default do Vite é `[]`, que libera `localhost`,
subdomínios de `.localhost` e **endereços IP** — e nada mais. Então o dev server responde
*"Blocked request"* ao `Host` com subdomínio **antes** do proxy rodar: o sintoma aparece como "não
conecta" e não aponta para o Vite. E tem um efeito colateral que precisa entrar no plano: com o
`Host` chegando intacto, **`127.0.0.1:5173` cai no slug `127`** (1ª label de um host com
`parts.length ≥ 3`, e `127` casa `^[a-z0-9][a-z0-9-]*$`) → **404 de tenant** no dev por IP.
`localhost:5173` continua funcionando (apex/`localhost` → default, §4.8). Ou seja: o dev por
`127.0.0.1` deixa de funcionar **sem** dar "Blocked request" (o IP é liberado por padrão), e o
sintoma que aparece é "tenant não encontrado" — que não lembra do problema.

**Arquivos que este doc não listava e que também mudam** (todos verificados no HEAD `0cb6c06`):

| Arquivo | Mudança | Motivo |
|---|---|---|
| `frontend/src/shared/api/http.js:40-42` | logout automático também em 403 | hoje só **401** dispara `onUnauthorized`; um `tenant_mismatch` (403, §4.5) deixa a sessão **órfã**: o token continua na tela e todo request volta 403, sem nunca limpar |
| `frontend/src/app/providers/auth/AuthProvider.jsx:28-40` | **particionar por loja no desktop** | no **web** as 6 chaves de storage são por origem (subdomínio ⇒ isolado). No **desktop a origem é única** (`tauri://localhost`), então `pdv:session`, `pdv:public-cart`, `pdv:customer-profile`, `pdv:nav:<role>` e `pdv:server` **não** são particionadas por loja: apontar o app para outra loja reaproveita carrinho e perfil do cliente anterior |
| `frontend/src/app/boot/bootSequence.js:64-70` + `frontend/src/app/boot/BootGate.jsx:81-84` | distinguir 404 de rede | `pingApi` é booleano e o `OFFLINE_COPY` só tem `cloud`/`local`: um **404 de tenant** e um **timeout** viram o mesmo "Sem conexão com o sistema", com dica de "verifique a internet" |
| `frontend/src/pages/login/LoginPage.test.jsx:10,150,157` e `frontend/src/widgets/app-menu/AppMenu.test.jsx:184-185` | fixtures de `/uploads/u2.png` e `/uploads/u1.png` → `/uploads/<kind>/<arquivo>` | o layout por tenant já está no disco (§4.7, `d30ec49`); as fixtures são o **único** lugar do frontend que fixa o formato antigo |
| `frontend/src/pages/login/LoginPage.jsx:110-117` | **segundo** `catch`, o do login por PIN | o primeiro `catch` trata erro de rede; este **não**: qualquer `e.code` vira *"PIN incorreto. Tente novamente."* — um `tenant_inactive` (403) apareceria como PIN errado, e o gerente tentaria de novo em vez de procurar a loja certa |

**Não muda:** qualquer URL de API/WS, rooms do realtime (§3.3), contrato de `/auth/users` e
`/store-info`, FSD, rotas do React Router, PWA/service worker (CacheStorage é **por origem** —
vazamento entre lojas é impossível com subdomínio), `app.json` dos apps desktop/standalone (já têm
`api_base`; o subdomínio é só o valor), as 6 chaves de `localStorage`/`sessionStorage`
(`pdv:session`, `pdv:nav:<role>`, `pdv:public-cart`, `pdv:customer-profile`, `pdv:alert-sound`,
`pdv:server` — todas por origem **no web**; no desktop ver a linha do `AuthProvider` acima), e o
bundle (1 build, N subdomínios).

**Uploads: já mudou, e o frontend não sentiu** (`d30ec49`, §4.7). `imagePath`/`photoPath`/`photoUrl`
passaram a ter um segmento a mais (`/uploads/<kind>/<arquivo>`) e **mesmo assim** o frontend não
mudou: ele só faz `assetUrl(x)` e trata o valor como **URL opaca** — nenhum componente conhece o
formato, e nenhuma chave de cache depende dele. Isso é a prova empírica da tese do §4.7 (a porta é
o que isola, não o chamador).

**Nenhum endpoint de controle novo é necessário** para o app: `/store-info` já devolve o nome/logo/
cor da loja, e a tela de login já renderiza logo + `merchantName` (`LoginPage.jsx:174-182`).
Listar lojas seria superfície de enumeração ("quais clientes eu tenho no meu domínio?") — que é o
que um 404 bem aplicado evita. O painel de provisionamento da plataforma é tooling separada
(P2).

---

## 8. Operação

- **Backup:** `deploy/backup.sh` **já cobre** (§5.10) — e `backup.sh:61` já pega o volume de uploads
  inteiro. Melhorias de P1: manifesto por dump (lista exata de tenants incluídos + versão de
  migration de cada um), **detecção de tenant omitido** (exit 1), **retenção** (hoje nunca apaga —
  `/opt/backups` cresce sem limite), verificação com `pg_restore -l`, e **restore de uploads por
  tenant, que o layout por tenant (§4.7) torna trivial**: um `tar` do volume, e o restore de uma
  loja é extrair `uploads/<schema>/` (nada de varrer diretório compartilhado). **Não** criar N dumps:
  1 arquivo com `pg_restore -n tenant_x` já faz restore cirúrgico.
- **Restore de 1 tenant:** ⚠️ `pg_restore -n tenant_x` a partir do dump completo **não cria o
  schema** — `CREATE SCHEMA` antes, sempre. E `pg_restore -n <schema-errado>` **sai 0 e não
  restaura nada** — sempre validar contagem contra o manifesto. `--clean` **só** em restore total,
  com o backend parado: em restore parcial derrubaria outros tenants.
- **Provisionamento — hoje não existe nada que crie uma segunda loja.** Registrado para não ler este
  fluxo como se estivesse pronto: os **dois** seeds gravam `store_settings` como **singleton**
  (`backend/src/infra/db/seed.ts:51-67` e `backend/src/infra/db/seed-prod.ts:35-50`, ambos com
  `id: "singleton"`) e **não há `CREATE SCHEMA` em nenhuma migration** (grep em
  `backend/migrations/` — nem no baseline `0001_init.sql`, nem no `archive/`). Ou seja: o banco tem
  um schema e um dono, e o caminho descrito abaixo é **válido e continua sendo o alvo**, mas
  **não implementado**.
  Quando entrar: script dedicado dentro do container (`docker compose run --rm`), **não** endpoint
  HTTP (auth nova, superfície CSRF/DoS, "quem criou a loja X?" fica na auditoria). Idempotente por
  slug. Fluxo: pré-checagem → `CREATE SCHEMA` + `GRANT` + migrations + `store_settings` + gerente
  (PIN no log, **uma vez**) → confirmar via `/store-info` → disparar TLS on-demand → dump.

- **Como a Fase 1 se liga (e por que ela não se liga sozinha).** O registry existe e é lido, mas
  **não há escrita nele** — o único jeito de popular `public.tenant` hoje é um `INSERT` manual,
  e o roteamento por `Host` nasce **desligado**. Para ligar uma loja própria já resolvida:

  ```sql
  INSERT INTO public.tenant (slug, schema_name, display_name, custom_domain)
  VALUES ('umami', 'tenant_umami', 'Umami Sushi Arte', 'umamisushiarte.com.br');
  ```

  ```bash
  TENANT_ROUTING=true            # sem isso o Host é ignorado e todo mundo cai no default
  PLATFORM_ROOT_DOMAIN=seudominio.com.br   # separa o apex de um subdomínio (TLD de 2 labels)
  ```

  ⚠️ **Ligar antes da Fase 3 não cria uma loja servível**: o schema `tenant_umami` não existe, e
  `/public/tenants/resolve` responde `503 tenant_schema_unavailable` para ela (enquanto o
  cardápio, o carrinho e o pedido continuariam vindo do schema default). Serve para
  exercitar a resolução, não para atender cliente. Depois de mudar o registry, a mudança só
  aparece no app em até `TENANT_REGISTRY_CACHE_TTL_SECONDS` (60 s).
- **Papéis — medido, e é o número que decide a recusa de RLS (§2).** `SELECT rolname, rolsuper,
  rolbypassrls FROM pg_roles` em produção devolve **`pdv | t | t`**: o app conecta como **superuser**,
  que **sempre** bypassa RLS, mesmo com `FORCE ROW LEVEL SECURITY` em cada tabela. Ou seja,
  "isolamento por schema" hoje é isolamento **só nominal** — e o inverso também vale: RLS, se
  adotada agora, daria a mesma sensação sem barreira nenhuma.
  Recomendação: `pdv_dba` (DDL, dono dos schemas) e `pdv_app` (só DML), com `DATABASE_URL` apontando
  para `pdv_app`. ⚠️ **Bloqueio:** Postgres gerenciado pode não dar `CREATE` no banco → nesse caso o
  desenho não cabe (ver pergunta Q1).
- **Ciclo de vida:** `suspended` = barra com 403 e **pula os workers**, mas **mantém TLS** (para o
  dono ver a página de suspensão em vez de erro de certificado) e **mantém o backup**. Eliminação =
  `DROP SCHEMA … CASCADE` (atômico e verificável) + `rm -rf uploads/<schema>` + linha em
  `tenant_erasure_log`. ⚠️ **O `rm -rf uploads/<schema>` só é exato porque o layout é por tenant
  (§4.7)**: com o diretório flat de hoje, ele apagaria a foto de **todas** as lojas — é o outro lado
  do R4. ⚠️ **A eliminação só é efetiva depois que o backup mais antigo expira** —
  isso precisa estar no contrato de privacidade.

---

## 9. Riscos

| # | Risco | Sev. | Mitigação |
|---|---|---|---|
| R1 | **Rooms do realtime cruzam lojas** (§5.4) | 🔴 | Fase 4: gateway particionado. `tenant-isolation.test.ts` com 2 sockets. |
| R2 | ~~`unaccent` quebra do tenant 2 em diante~~ (§5.1) | ✅ **resolvido** | **FECHADO em `bf75736` (PR #64)**: o baseline `0001_init.sql:27` já instala `unaccent WITH SCHEMA public`, e a cadeia que tinha o bug foi arquivada (fora do glob do runner). Só a receita do registry continua valendo: registry **antes** de migration de tenant. |
| R3 | **Logo de uma loja sobrescreve o da outra** (§5.2) | ✅ mitigado | Layout por tenant no disco (§4.7), não nome de arquivo: nada colide porque cada `<schema>/<kind>/` é exclusivo. **Mitigação em `d30ec49` (PR #73)** — ⚠️ mas hoje ela é **inerte**: a seam `backend/src/infra/storage/tenant.ts:16-20` devolve `public`, e **não há duas lojas ainda**. Fecha de verdade quando a Fase 2 ligar a seam no ALS (§4.8). Teste de upload cruzado. |
| R4 | **Leitura de upload entre lojas** — `/uploads/*` público e sem fronteira de tenant; a foto de um cliente/usuário de A abre em B. Dado pessoal (LGPD) (§5.3) | ✅ mitigado | Layout por tenant + rota `GET /uploads/:kind/:filename` + saída do `@fastify/static` em **`d30ec49` (PR #73)**; o schema não vai na URL, então a URL de A dá 404 em B por construção. ⚠️ **A fronteira ainda é latente**: falta a Fase 2 ligar a seam no ALS (§4.8) — enquanto o schema resolver sempre `public`, não há duas lojas para cruzar e o isolamento real não foi provado. `tenant-isolation.test.ts`: mesmo `filename` em 2 tenants → 200 só no dono. |
| R5 | **Acesso ao banco sem contexto de tenant** | 🔴 | `requireTenant()` **lança**; `TENANT_STRICT` no ar depois de 1 semana; `grep` no CI. |
| R6 | `pdv:server` vaza **imagem** entre lojas no web — `assetUrl()` e `fetchTag()` passam a apontar para outra origem, **sem** trocar a API (§5.5) | 🟠 | Gate por `isDesktop()` — no web `pdv:server` não tem função (a origem **é** o servidor) — mais a origem única por subdomínio. |
| R7 | `/health` falha → switch aborta (§5.6) | 🟠 **aberto** | `/health` no registry; `/health/tenants` pós-switch. **A Fase 1 deixou `/health` como `SELECT 1`** — não toca no registry, que é o comportamento seguro do §5.6 — e `/health/tenants` segue na Fase 5. |
| R8 | Dev aplica migration no banco de produção (§5.7) | 🟠 | Volumes próprios por stack + confirmação no `reset.sh`. **Antes de qualquer código.** |
| R9 | Estouro de `max_connections` acima de ~20 lojas | 🟠 | `TENANT_POOL_MAX_TOTAL` → 503 explícito; `CONNECTION LIMIT` na role; plano B pronto (§4.3). ⚠️ Antes disso: a probe do `/health` do gateway Go (`healthMaxInFlight=2`, `healthStaleAfter=3s`) foi calibrada para **um** pool de 25 e vira gargalo antes (§5.11). |
| R10 | Cutover perde dado | 🟠 | `EXCEPT` de verificação, `RENAME` (não `DROP`), backup antes e depois, uma release de espera. |
| R11 | `nextval()` não qualificado + `public` no path = vazão silenciosa | 🟡 | Canário no boot (`current_schema()` == schema do tenant **e** `to_regclass('"order"')` não-nulo); `/health/tenants` reporta. Some quando o `public` for esvaziado (passo 11 do cutover). |
| R12 | Rollback de migration em N schemas | 🟡 | Expand/contract em 2-3 releases; o **backup pré-deploy do CI já é o mecanismo de rollback** (`pg_restore -n tenant_x`). |
| R13 | Webhook do WhatsApp chega no apex, sem Host | 🟡 | Fan-out de 1 query indexada por tenant (`phone_number_id`), cache 60s. Sem escrita cruzada no registry. **Fase 5 — a Fase 1 não tocou no webhook** (o registry ainda não tem a coluna `phone_number_id`). |
| R14 | Limite de taxa do Let's Encrypt estourado | 🟡 | On-demand TLS via registry (§5.8). |
| R15 | Relatório de gerente passa de `statement_timeout=30s` | 🟡 | P2: override por endpoint. |
| R16 | `audit_log`/`stock_movement` **nunca são podados** (crescem sem limite;Maintenance só limpa 4 tabelas) | 🟡 | `retention_days` no registry + manutenção por tenant. Origem nº1 de "o banco ficou lento". |

---

## 10. Perguntas abertas (precisam de decisão do dono)

1. **Postgres gerenciado dá `CREATE` no banco?** Sem isso, `pdv_dba` separado não existe e o app
   continua como dono dos schemas (DML+DDL). Decisão **antes** de codar a Fase 3. (Hoje: role
   `pdv` é SUPERUSER e o deploy usa Postgres em container — provavelmente sim, mas confirmar.)
2. **Credenciais do iFood são por loja?** Hoje `IFOOD_CLIENT_ID/SECRET` são **globais em env**
   (`env.ts:89-90`), mas `ifood_state` é por loja. Se cada loja tiver o seu iFood, elas precisam
   sair do env para a tabela. Bloqueio de produto.
3. **Impressora:** o daemon local (`PRINTER_DAEMON_URL` global) é 1 por host. Se duas lojas
   compartilharem servidor, o daemon Go precisa de fila por loja. Se cada loja roda no seu
   mini-PC (o caso do AGENTS.md), nada muda.
4. **Um gerente pode operar duas lojas?** Se sim, ele precisa de um seletor de loja que **troca de
   subdomínio** (o JWT `t` impede crossover). É decisão de UX + segurança.
5. ** downtime tolerável no cutover?** O passo 4 (escrita bloqueada) é de segundos para 1 loja. Se
   exigir downtime zero, o caminho é logical replication + delta final — caro para 1 loja.
6. **Alvo de N tenants em 12 meses** dimensiona §4.3. Se a previsão for > 20, decide o plano B
   (pool compartilhado + `SET LOCAL`) **antes** da Fase 2, não depois.
7. **Painel de administração da plataforma** (provisionar/pausar loja) entra neste projeto ou é
   manual (script) por enquanto? O plano assume **manual**.

---

## 11. Referências

- `docs/agent-backend.md` — convenções, transações, estoque, migrations
- `docs/agent-deploy.md` — healthcheck é o portão, expand/contract
- `docs/agent-testing.md` — 19 suítes backend, `pdv_test`
- `docs/agent-frontend.md` / `agent-frontend-map.md`
- `deploy/README.md` — runbook de deploy (33 KB)
- **Histórico removido:** `git show 7c259cd^:backend/src/http/middlewares/tenant.middleware.ts`,
  `git show 7c259cd^:backend/src/infra/db/provision-tenant.ts`
- **Plano anterior (RLS, rejeitado):** `feat/multitenant-plan/docs/15-multitenant.md` §2
- **Diagnóstico do vazamento row-level:** `feat/multitenant-isolamento/docs/15-multi-tenant-gap.md`
- **Gateway Go (plugado no `deploy/`, corte pendente):** `ws-gateway/` + `ws-gateway/GO-GATEWAY-PLAN.md`
- **Guard de banco de teste:** `dc17a5a` — `global-setup.ts` aborta se outro processo usa `pdv_test`
  (evita flaky e trava no `DROP SCHEMA public CASCADE` com um dev apontado para o mesmo banco)