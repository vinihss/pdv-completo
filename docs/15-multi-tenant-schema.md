# 15 — Multi-tenant: um schema PostgreSQL por loja (subdomínio → tenant)

> **Status:** plano (nada implementado).
> **Data:** 2026-10-04 · **Branch:** `feat/schema`
> **Substitui:** `feat/multitenant-plan/docs/15-multitenant.md` (shared schema + `tenant_id` + RLS),
> que **rejeitava** schema-por-tenant. Ver §2 — a objeção não se sustenta.
> **Histórico:** já existiu multi-tenant (row-level, `store_id` em ~22 tabelas) e foi removido em
> `7c259cd` + `0012_remove_multi_tenant.sql`. Recomeçamos do zero, com outro modelo de isolamento.

---

## 1. A decisão, em uma frase

> **Um schema PostgreSQL por loja (`tenant_<slug>`), identificado pelo subdomínio no
> `Host`, com o `db` do Drizzle resolvido por um `AsyncLocalStorage` e um `pg.Pool` dedicado por
> schema, cujo `search_path` é fixado no *startup packet* — de modo que os 42 arquivos que já
> importam o `db` não mudam uma linha.**

A barreira de isolamento é **estrutural** (o pool só conversa com um schema), não convenção
("lembre-se de filtrar por loja"). Isso é uma resposta direta ao histórico do projeto: o modelo
row-level anterior vazou dados entre lojas precisamente porque o filtro era opcional —
ver `feat/multitenant-isolamento/docs/15-multi-tenant-gap.md`: *"qualquer usuário logado em
`ana-terra` lê produtos, comandas, clientes, usuários, caixa e entregas da Loja Padrão"*.

O que **não** muda: o frontend web (URLs já são relativas), o Caddy (o wildcard `*.labolabe.tech`
com TLS on-demand já existe), o `backup.sh` (já faz `pg_dump` do banco inteiro), e a forma das
migrations (SQL puro, numeradas, idempotentes).

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
                    │                                                                        │
                    │  host = (x-forwarded-host ?? host).split(":")[0]   ← trustProxy     │
                    │  slug = 1ª label, se parts.length ≥ 3                             │
                    │  slug ∈ {www, app} | localhost | apex  → DEFAULT_TENANT_SCHEMA     │
                    │  slug fora de ^[a-z0-9][a-z0-9-]*$  → 404 (NUNCA default)         │
                    │                                                                        │
                    │  tenant = await resolveTenantBySlug(slug)   ← cache 5s              │
                    │     SELECT slug, schema_name, status FROM public.tenant           │
                    │     status ≠ 'active' → tenant_inactive (403)                     │
                    │     não existe       → tenant_not_resolved (404)                   │
                    │                                                                        │
                    │  req.tenant = { slug, schema_name }                                │
                    │  tenantContext.enterWith(req.tenant)      ← ALS entra AQUI         │
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

```sql
-- backend/migrations/registry/0001_tenant_registry.sql
-- ⚠️ NÃO entra em backend/migrations/ — se entrasse, rodaria dentro de cada schema de tenant.
CREATE TABLE IF NOT EXISTS public.tenant (
  slug         TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  schema_name  TEXT NOT NULL UNIQUE CHECK (schema_name ~ '^tenant_[a-z0-9_]+$'),
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at   TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- A extensão PRECISA morar em public. Ver §5.1 — sem isso o tenant 2 quebra.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
```

Por que `public`: é garantidamente o último elo de qualquer `search_path` do projeto, inclusive o
das conexões de tenant. `information_schema` é read-only por design. Um schema dedicado
exigiria qualificar à mão ou tirar `public` do caminho.

O `CHECK` no `schema_name` não é decoração: **o nome do schema vem do registry, nunca do request**.
Sem a barreira, um slug mal resolvido cai silenciosamente em `public` — que é exatamente o modo de
falha que `pg` não acusa.

### 3.3 Realtime — particionar o gateway, não prefixar a room

O `WsGateway` (`infra/realtime/ws-gateway.ts`) é um **singleton de processo** e as rooms são strings
globais: `kitchen-display`, `cash-drawer`, `deliveries`, `inventory`, `alerts:<role>`. Com N lojas
no mesmo processo, **o gerente de A ouviria a gaveta de caixa de B** — vazamento de dado financeiro
entre lojas. É o risco mais grave do desenho (R2 em §5).

Decisão: `Connection` ganha `tenant`; o gateway passa a indexar por tenant
(`Map<tenant, Set<Connection>>`); `broadcastToRoom(tenant, room, event)` só alcança conexões do
mesmo tenant; `canJoinRoom` valida contra o tenant da conexão.

**O nome da room no wire continua `cash-drawer`.** O cliente não muda uma linha — `useRealtime`,
`usePublicRealtime`, `waiter:<id>`, `alerts:<role>`, `order:<uuid>` seguem idênticos. Não vamos
prefixar a string no wire: isso custaria 8 arquivos de frontend + risco de divergência entre o que
o cliente pede e o que `canJoinRoom` autoriza, sem ganhar nada.

`GET /realtime/public` (vitrine, sem token) resolve o tenant pelo `Host` e é particionado igual.

> ⚠️ **Duas implementações enquanto coexistem.** Desde `3e5e8cd` o repo tem um segundo gateway,
> Go (`ws-gateway/`), destinado a **substituir** a responsabilidade de realtime do Node
> (`backend/src/infra/realtime/`), mas **ainda não ligado no deploy** — o `Caddyfile` continua
> mandando `/realtime*` para o backend Node. Ele compartilha o mesmo Postgres + outbox, com a
> mesma `RoomManager` global e rooms por string, **sem partição por tenant**. Ou seja: o R2 existe
> nos **dois** gateways. O particionamento acima vale para **ambos** até o Go virar o caminho vivo
> de `/realtime*` — quando isso acontecer, o código Node equivalente pode ser removido. O outbox do
> Go segue a mesma regra do §4.5: iterar os schemas de tenant com advisory lock por tenant.
> O JWT pode carregar `t: <schema>` (§4.5) e o Go lê o mesmo segredo, então a validação espelha o
> Node sem contrato novo.

---

## 4. Decisões e o que foi descartado

### 4.1 Como o `db` escopado chega aos 42 arquivos

| Opção | Custo medido | Veredito |
|---|---|---|
| Passar `db`/`Tx` como parâmetro | 42 arquivos + **209 call-sites de use case** em `http/routes` + 67 `db.transaction`. E a onda não para: `withIdempotency(endpoint, …)` recebe um `handler` que fecha sobre o `db` do módulo; `getStoreSettingsUsecase()` (sem argumento, chamada de `/store-info`, do menu público e do self-service) arrastaria 10 arquivos. **12-18 dias** mecânicos, ganho de segurança zero. | ❌ |
| Só ALS + proxy sobre o pool único | Resolve o contexto, **não** o isolamento: `pool.connect()` devolve qualquer conexão e um `SET search_path` no checkout vaza. | ❌ |
| Só `req.db` injetado | Só é alcançável se algo o passar ao use case → é a 1ª opção de novo, com uma camada extra. | ❌ |
| **ALS (transporte) + pool dedicado por tenant (barreira)** | **0 arquivos alterados** nos 42. O ALS é só o transporte; o pool dedicado é a barreira. | ✅ |

O ALS é honesto aqui porque, no schema-por-tenant, o tenant é **inerentemente ambiental**
(`search_path`) — o ALS representa o conceito, não um atalho. E o acesso sem contexto **lança**
(flag `TENANT_STRICT`), em vez de cair num default silencioso.

### 4.2 Como o `search_path` é aplicado — a reconciliação

Dois pareceres divergiram, ambos tecnicamente defensáveis. A decisão:

> **Pool dedicado por tenant com `options` no startup packet.**

| Opção | Veredito |
|---|---|
| `Pool` dedicado, `options: '-c search_path=tenant_x,public,pg_temp'` | ✅ **Recomendada.** Fixado no *startup packet*: impossível "esquecer de reaplicar", e o pool só fala com aquele schema. `pg_temp` por último elimina o sombreamento (§5.2). Transação herda o `search_path` de graça. |
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

---

## 5. Achados que bloqueiam a produção (bugs reais, não hipóteses)

Cada um foi verificado no código ou reproduzido num Postgres descartável.

### 5.1 🔴 `unaccent` quebra a partir do 2º tenant

`0003_profile_fields.sql:11` faz `CREATE EXTENSION IF NOT EXISTS unaccent;` **sem `WITH SCHEMA`**.
O Postgres instala no **primeiro schema do `search_path`** — ou seja, dentro do schema do
**tenant 1**. Resultado medido: um tenant novo recebe
`ERROR: function unaccent(unknown) does not exist`, e `unaccent()` é chamada sem qualifier em
`customer.usecases.ts:72,74`, `product.usecases.ts:30`, `stock/stock.usecases.ts:182` —
**toda busca por nome quebra do tenant 2 em diante**.

Correção: o runner do registry instala `unaccent WITH SCHEMA public` **antes** de qualquer
migration de tenant. Verificado: extensão já instalada em `public` → `CREATE EXTENSION IF NOT
EXISTS` no schema do tenant vira no-op (`NOTICE: … skipping`), não tenta instalar cópia.

### 5.2 🔴 `logo.<ext>` colide entre lojas

`store-settings.usecases.ts:190` grava `logo.${ext}` num **diretório único** (`config.uploadsDir`)
servido por `fastifyStatic`. **Loja B faz upload → sobrescreve `logo.png` → loja A exibe o logo da
loja B** em todas as telas e na vitrine pública. Determinístico, não colisão teórica.

Fixação mínima: `logo-<schema>.<ext>` (zero mudança de rota, zero mudança de frontend).
Alternativa limpa: `/uploads/<slug>/logo.png` — mas exige que `/uploads/` deixe de ser isento da
resolução de tenant (hoje `publicPaths` o exclui, senão o logo de A fica legível em B).

### 5.3 🔴 `WsGateway` singleton com rooms globais

Vazamento de dado financeiro entre lojas (§3.3). O mais grave dos três.

### 5.4 🟠 `pdv:server` no web é uma fuga entre tenants

O modal "Servidor" do login (`LoginPage.jsx:219-232`) é editável **no navegador** e salva a URL em
`localStorage["pdv:server"]`, que passa a valer para `assetUrl()` e `fetchTag()`. Em
`slug-a.labolabe.tech` o usuário cola `https://slug-b.labolabe.tech` e passa a falar com a loja B.
Fechar por `isDesktop()`.

### 5.5 🟠 `/health` não pode resolver schema de tenant

`/health` é o **portão do `switch.sh`** e é martelado a 5 req/s pelo `probe-availability.sh`. Se
resolver o schema do tenant e ele não estiver provisionado → 503 → deploy abortado.
`/health` fica **O(1) no registry**; a verificação por tenant vai para `/health/tenants`, que roda
**depois** do switch e só avisa.

### 5.6 🟠 Os 3 composes dividem os mesmos volumes

`docker-compose.yml`, `.local.yml` e `.dev.yml` declaram todos `pdv_postgres_data`,
`pdv_backend_uploads`, `pdv_caddy_data`. Consequência **já presente**: subir o stack de dev aplica
`runMigrations()` **nos schemas de tenant da produção**. Com multi-tenant isso vira incidente de
dados. `deploy/reset.sh:45` apaga **todo** volume `pdv_*`, incluindo o de produção.
→ Antes de qualquer código: dar nome próprio ao stack de dev e exigir confirmação por nome no
`reset.sh`.

### 5.7 🟡 `/internal/caddy-on-demand-tls` emite certificado para qualquer subdomínio

`server.ts:121-125` valida só `^[a-z0-9-]+\.labolabe\.tech$`. Um scanner de subdomínios pode
estourar o **limite de taxa do Let's Encrypt** (5 duplicados/semana) e travar o on-demand de um
tenant real. Trocar o regex por consulta ao registry (permitindo `suspended`, recusando
desconhecido).

### 5.8 🟡 `CORS_ORIGIN` enumerado não escala

`deploy/.env.example:18` lista subdomínios um a um. Cada loja nova = editar `.env` + reiniciar as
duas instâncias. Recomendação: função `origin` no `@fastify/cors` validando o host contra o
registry (cache 60s). ~30 linhas em `server.ts`.

### 5.9 ℹ️ Não-bugs (verificados, para não gastar tempo)

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
7. **Uploads**: extrair o tarball sobre o volume `pdv_backend_uploads` (path flat, igual ao atual).
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
| **1** | **Registry** | `public.tenant`, `registry-migrate.ts`, `tenants.ts` (cache), `Errors.tenant*`, `resolveTenant` registrado. `DEFAULT_TENANT_SCHEMA=public` → **comportamento idêntico ao de hoje**. | nenhum | 1 d |
| **2** | **`db` escopado** | `tenant-context.ts` (ALS), `tenant-db.ts` (Map+LRU), `client.ts` passa a exportar o `Proxy`. `TENANT_STRICT` desligado, ligado após 1 semana em staging. | baixo | 2 d |
| **3** | **Migrations por schema** | `runMigrations({ schema })`, boot iterando tenants, `provisionTenantSchema()`, `unaccent` em `public`. | médio | 1,5 d |
| **4** | **Workers, locks, realtime, cache** | Loops por tenant com stagger, `lockName(base, schema)`, gateway particionado, `tenantKey()`. | médio | 2 d |
| **5** | **Rotas sem subdomínio** | Fan-out do webhook do WhatsApp por `phone_number_id`, `/health/tenants`, on-demand TLS via registry, `logo-<schema>`, `printer_daemon_url` por tenant, CORS por registry. | médio | 2 d |
| **6** | **JWT + desligamento do single-tenant** | `t` no payload, `tenant_mismatch`, `TENANT_ROUTING=false` como kill-switch. | médio | 1 d |
| **7** | **Cutover do dado de produção** | §6.2. **Único ponto de não-retorno.** | **alto** | 1 d + janela |
| **8** | **Suítes de isolamento** | `tenant-isolation.test.ts` + `tenant-routing.test.ts` (começam na Fase 1). | nenhum | 2 d |

**Rollback.** Fases 1-6: `git revert` do merge → nova tag → deploy. O dado não volta porque
nenhum schema de produção foi tocado. **Kill-switch** para emergência sem deploy:
`TENANT_ROUTING=false` faz o `resolveTenant` devolver sempre o default, ignorando o Host.

### 6.1 O que muda no boot

```
registry-migrate()                    → garante public.tenant + unaccent em public
for tenant de registry.active:
    runMigrations({ schema })         → _migrations DENTRO do schema
workers (1 timer cada, iterando tenants com stagger)
```

⚠️ **Ordem obrigatória**: registry antes de migration de tenant. Sem isso, o `unaccent` (§5.1)
mora no schema do primeiro tenant.

⚠️ **O boot vai ficar mais lento** (N × migrations). O healthcheck do compose dá ~65 s de
tolerância (`retries 20 × 3s + start 5s`) e estoura **antes** do `PDV_HEALTH_TIMEOUT=120`.
→ Preferir **tirar as migrations do boot** para um passo explícito do CI antes do `switch.sh`
(o boot passa a só *verificar* e falhar rápido se algo estiver pendente). É a mudança de maior
retorno aqui.

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

## 7. Frontend: 3 arquivos

O frontend já fala **só com a própria origem** (`appConfig.js`: `apiBase()` → `/api`;
`wsEndpoint()` → `window.location.host`). O histórico prova: os 7 commits do multi-tenant anterior
**não tocaram nenhuma linha de `frontend/`**.

| Arquivo | Mudança | Motivo |
|---|---|---|
| `frontend/vite.config.js` | `changeOrigin: false` em `/api`, `/uploads`, `/realtime` | hoje o proxy reescreve o `Host` para `127.0.0.1:3000` e **o dev nunca vê o subdomínio** |
| `frontend/src/pages/login/LoginPage.jsx` | branch no `catch` por `e.code` + gate do modal "Servidor" por `isDesktop()` | hoje um subdomínio inexistente mostra *"Não foi possível conectar ao servidor"* (§5.4, §5.5 do frontend) |
| `frontend/src/app/router.jsx` | `assetUrl(storeSettings.logoUrl)` | bug pré-existente; com tenancy passa a significar "logo não carrega" |

**Não muda:** qualquer URL de API/WS, rooms do realtime (§3.3), contrato de `/auth/users` e
`/store-info`, FSD, rotas do React Router, PWA/service worker (CacheStorage é **por origem** —
vazamento entre lojas é impossível com subdomínio), `app.json` dos apps desktop/standalone (já têm
`api_base`; o subdomínio é só o valor), as 6 chaves de `localStorage`/`sessionStorage` (todas por
origem), e o bundle (1 build, N subdomínios).

**Nenhum endpoint de controle novo é necessário** para o app: `/store-info` já devolve o nome/logo/
cor da loja, e a tela de login já renderiza logo + `merchantName` (`LoginPage.jsx:174-182`).
Listar lojas seria superfície de enumeração ("quais clientes eu tenho no meu domínio?") — que é o
que um 404 bem aplicado evita. O painel de provisionamento da plataforma é tooling separada
(P2).

---

## 8. Operação

- **Backup:** `deploy/backup.sh` **já cobre** (§5.9). Melhorias de P1: manifesto por dump (lista
  exata de tenants incluídos + versão de migration de cada um), **detecção de tenant omitido**
  (exit 1), **retenção** (hoje nunca apaga — `/opt/backups` cresce sem limite), verificação com
  `pg_restore -l`, e um tar de uploads por tenant. **Não** criar N dumps: 1 arquivo com
  `pg_restore -n tenant_x` já faz restore cirúrgico.
- **Restore de 1 tenant:** ⚠️ `pg_restore -n tenant_x` a partir do dump completo **não cria o
  schema** — `CREATE SCHEMA` antes, sempre. E `pg_restore -n <schema-errado>` **sai 0 e não
  restaura nada** — sempre validar contagem contra o manifesto. `--clean` **só** em restore total,
  com o backend parado: em restore parcial derrubaria outros tenants.
- **Provisionamento:** script dedicado dentro do container (`docker compose run --rm`), **não**
  endpoint HTTP (auth nova, superfície CSRF/DoS, "quem criou a loja X?" fica na auditoria).
  Idempotente por slug. Fluxo: pré-checagem → `CREATE SCHEMA` + `GRANT` + migrations + `store_settings`
  + gerente (PIN no log, **uma vez**) → confirmar via `/store-info` → disparar TLS on-demand → dump.
- **Papéis:** o app hoje conecta como **SUPERUSER** (`rolsuper=t`), o que torna "isolamento por
  schema" isolamento só nominal. Recomendação: `pdv_dba` (DDL, dono dos schemas) e `pdv_app` (só
  DML), com `DATABASE_URL` apontando para `pdv_app`. ⚠️ **Bloqueio:** Postgres gerenciado pode não
  dar `CREATE` no banco → nesse caso o desenho não cabe (ver pergunta Q1).
- **Ciclo de vida:** `suspended` = barra com 403 e **pula os workers**, mas **mantém TLS** (para o
  dono ver a página de suspensão em vez de erro de certificado) e **mantém o backup**. Eliminação =
  `DROP SCHEMA … CASCADE` (atômico e verificável) + `rm -rf uploads/<slug>` + linha em
  `tenant_erasure_log`. ⚠️ **A eliminação só é efetiva depois que o backup mais antigo expira** —
  isso precisa estar no contrato de privacidade.

---

## 9. Riscos

| # | Risco | Sev. | Mitigação |
|---|---|---|---|
| R1 | **Rooms do realtime cruzam lojas** (§5.3) | 🔴 | Fase 4: gateway particionado. `tenant-isolation.test.ts` com 2 sockets. |
| R2 | **`unaccent` quebra do tenant 2 em diante** (§5.1) | 🔴 | Registry antes de migration; teste que provisiona 2 tenants e busca por nome em ambos. |
| R3 | **Logo de uma loja sobrescreve o da outra** (§5.2) | 🔴 | `logo-<schema>.<ext>` + teste. |
| R4 | **Acesso ao banco sem contexto de tenant** | 🔴 | `requireTenant()` **lança**; `TENANT_STRICT` no ar depois de 1 semana; `grep` no CI. |
| R5 | `pdv:server` permite trocar de loja no web (§5.4) | 🟠 | Gate por `isDesktop()`. |
| R6 | `/health` falha → switch aborta (§5.5) | 🟠 | `/health` no registry; `/health/tenants` pós-switch. |
| R7 | Dev aplica migration no banco de produção (§5.6) | 🟠 | Volumes próprios por stack + confirmação no `reset.sh`. **Antes de qualquer código.** |
| R8 | Estouro de `max_connections` acima de ~20 lojas | 🟠 | `TENANT_POOL_MAX_TOTAL` → 503 explícito; `CONNECTION LIMIT` na role; plano B pronto (§4.3). |
| R9 | Cutover perde dado | 🟠 | `EXCEPT` de verificação, `RENAME` (não `DROP`), backup antes e depois, uma release de espera. |
| R10 | `nextval()` não qualificado + `public` no path = vazão silenciosa | 🟡 | Canário no boot (`current_schema()` == schema do tenant **e** `to_regclass('"order"')` não-nulo); `/health/tenants` reporta. Some quando o `public` for esvaziado (passo 11 do cutover). |
| R11 | Rollback de migration em N schemas | 🟡 | Expand/contract em 2-3 releases; o **backup pré-deploy do CI já é o mecanismo de rollback** (`pg_restore -n tenant_x`). |
| R12 | Webhook do WhatsApp chega no apex, sem Host | 🟡 | Fan-out de 1 query indexada por tenant (`phone_number_id`), cache 60s. Sem escrita cruzada no registry. |
| R13 | Limite de taxa do Let's Encrypt estourado | 🟡 | On-demand TLS via registry (§5.7). |
| R14 | Relatório de gerente passa de `statement_timeout=30s` | 🟡 | P2: override por endpoint. |
| R15 | `audit_log`/`stock_movement` **nunca são podados** (crescem sem limite;Maintenance só limpa 4 tabelas) | 🟡 | `retention_days` no registry + manutenção por tenant. Origem nº1 de "o banco ficou lento". |

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
- **Gateway Go (WIP, ainda não plugado no deploy):** `ws-gateway/` + `ws-gateway/GO-GATEWAY-PLAN.md`
- **Guard de banco de teste:** `dc17a5a` — `global-setup.ts` aborta se outro processo usa `pdv_test`
  (evita flaky e trava no `DROP SCHEMA public CASCADE` com um dev apontado para o mesmo banco)