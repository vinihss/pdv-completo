# Convenções Backend

Guia detalhado para agentes que trabalham no backend (`backend/`).

## Arquitetura em camadas

```
src/
├── domain/        # erros (AppError), text, pix-key, variations
├── application/   # use cases (regra de negócio)
├── infra/         # db (client, migrate, seed), realtime (outbox, ws), audit
├── http/          # server.ts, middlewares/, routes/
└── config/        # env.ts
```

**Regra de ouro**: `http → application → infra → domain`. Nunca ao contrário.

## ESM + NodeNext

- Imports sempre com extensão `.js` (ex.: `from "../infra/db/client.js"`)
- O backend é ESM puro ( `"type": "module"` no package.json)

## PostgreSQL

- **Único banco suportado** (SQLite removido)
- `DATABASE_URL` obrigatório, formato `postgres://` ou `postgresql://`
- Pool: `pg.Pool` (`DATABASE_POOL_MAX`, padrão 10)
- Extensões: `unaccent` (busca sem acentos), `pgcrypto`

## Transações assíncronas

O `node-postgres` é I/O, então todo acesso dentro de `db.transaction` é `await tx...`.

**Não existem** os terminais síncronos do `better-sqlite3` (`.run()`, `.get()`, `.all()`, `.sync()`).

```js
// Query de 1 linha: destructuring
const [row] = await tx.select().from(orders).where(eq(orders.id, id));

// Agregação: rows[0]
const rows = await tx.select({ count: count() }).from(orders);
const total = rows[0].count;
```

Ver nota completa em `src/application/order/order.usecases.ts:15-28`.

## Migrations

Diretório `backend/migrations/` com 9 arquivos:

| Arquivo | Conteúdo |
|---|---|
| `0001_init.sql` | **todo** o schema (tabelas, índices, extensões) |
| `0002_whatsapp_connections.sql` | token por WABA + tabelas de inbound/outbound |
| `0003_printer.sql` | flags `printer_enabled` / `printer_auto_print` |
| `0003_profile_fields.sql` | `user.phone/email/photo_path`, `customer.email/active`, extensão `unaccent` |
| `0004_alerts.sql` | tabela `alert` (sino da casca) |
| `0005_customer_address_cep.sql` | `customer_address.cep` (8 dígitos crus, ViaCEP no cliente) |
| `0006_delivery_eta_and_notes.sql` | `order.notes`, ETA na `store_settings`, `customer_address.state` |
| `0007_whatsapp_integration_enabled.sql` | toggle do painel de WhatsApp |
| `0008_customer_profile_fields.sql` | `customer.photo_path/cpf/notes` + `uq_customer_cpf` |

**Colisão `0003_*`**: são dois arquivos com o mesmo prefixo. É de propósito — o runner chaveia por filename em `_migrations.name`. **Não renomear**.

**Regras**:
- Sempre usar número zero-padded lexicograficamente **maior** (próximo: `0009_*`)
- O prefixo não precisa ser único desde `0003` (o controle é pelo nome completo), mas **mantenha o prefixo igual ao número da ordem** para o `ls` não mentir
- Escrever migration idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE ... IF NOT EXISTS`)
- O boot **aborta** se a migration falhar (`runMigrations()` com `await` no `server.ts`)
- **Não reintroduza** `runMigrations()` sem `await`

### Registry do multi-tenant — `migrations/registry/` (Fase 1 do `docs/15`)

`backend/migrations/registry/` é um **diretório** e tem **runner próprio**
(`src/infra/db/registry-migrate.ts`, `npm run db:migrate:registry`, controle em
`public._registry_migrations`). É o índice dos schemas de tenant (`public.tenant`,
§3.2 do doc 15), então ele **não pode** estar no glob do runner de tenant: na Fase 3
aquele runner roda o mesmo arquivo dentro de cada schema de loja, e cada uma
criaria a sua própria lista de lojas. O `migrate.ts` filtra `*.sql` de um nível e
tem um `statSync().isFile()` explícito por isso.

- `server.ts#main` chama `runRegistryMigrations()` **antes** de `runMigrations()`,
  no mesmo `try` (falha em qualquer uma aborta o boot).
- Advisory lock distinto do runner de tenant e `SET LOCAL search_path = public` em
  cada transação: uma conexão já apontada para um schema de tenant não desvia o DDL.
- **Toda referência é qualificada com `public.`** e o registry **não** entra no
  `infra/db/schema.ts` (que é o DDL replicado em cada loja — o `drizzle-kit`
  criaria `tenant` dentro de cada schema).
- Regras de resolução em `src/domain/tenant.ts` (puras), acesso em
  `src/infra/tenant/registry.ts` (cache 60 s, resultado negativo também cacheado),
  decisão em `src/application/tenant/resolve-tenant.usecase.ts` (`resolveTenant`, o
  mesmo que a Fase 2 vai pôr no `onRequest`) e rota em
  `src/http/routes/tenant.routes.ts` (`GET /public/tenants/resolve`, sem auth, com
  `publicLookupRateLimit`). **O `schema_name` nunca sai na resposta.**
- **`TENANT_ROUTING` é default DESLIGADO** (Fase 1 = comportamento idêntico ao de
  hoje): ligado, todo endereço fora do registry dá 404. `PLATFORM_ROOT_DOMAIN`
  (= `${ROOT_DOMAIN}` do Caddy) é o que separa o apex de um subdomínio num TLD de
  duas labels. Kill-switch: `TENANT_ROUTING=false` → todo host vira tenant default.

## Build da imagem Docker

O `Dockerfile` faz `npm ci` + `npm prune --omit=dev` no estágio `build` (com toolchain) e copia o `node_modules` compilado para a imagem final.

**Não reintroduza** `npm ci --omit=dev` no estágio final: o `drizzle-orm` declara `better-sqlite3` como peer dependency *opcional*, então o npm o instala mesmo com `--omit=dev` e o install script dispara o node-gyp, que estoura sem toolchain.

## Impressão térmica

- Flags: `printer_enabled` / `printer_auto_print` em `store_settings` (default off)
- Backend envia JSON estruturado para `PRINTER_DAEMON_URL` (default `http://127.0.0.1:8080`)
- Daemon em Go (`printer/daemon/`) renderiza ESC/POS e envia TCP para a impressora
- Rotas em `print.routes.ts`: `POST /orders/:id/print` (manual), `GET /printers/status|health`
- Auto-print é pós-commit **fire-and-forget**: cozinha no `addItemsUsecase`, entregador no `dispatchDeliveryUsecase`
- Erros: comanda inexistente → 404; daemon fora do ar → 503 (`service_unavailable`)

## Central de alertas

- Tabela `alert` (migration `0004`) gravada por `createAlertTx` **dentro da transação** de `openOrderUsecase`
- Fan-out de `alert.created` por `enqueueEvent` (um insert de outbox por room da audiência)
- Público: `ORDER_ALERT_AUDIENCE` = `manager`/`cashier`/`kitchen` (garçom **não** entra)
- Rooms: `alerts` (sem público) e `alerts:<papel>` (o `canJoinRoom` autoriza só o próprio papel)
- `read_at` é **global por loja** (não por usuário)
- Rotas em `alert.routes.ts` **sem `requireRole`** — quem não tem audiência não recebe linha
- Texto em função pura (`describeOrderAlert`)
- Purga de 7 dias no job de maintenance

## Contagem e agregação

- `count()` do Drizzle (nunca `sql<number>\`count(*)\`` — no Postgres o tipo bigint sai como string)
- Se precisar de `count(*)` cru, caste `::int`
- `sum(real)` devolve `number`

## Audit log + outbox

- **Sempre** registrar `logAction` e/ou `enqueueEvent` no **mesmo `db.transaction`** da escrita de domínio
- Se o audit/outbox falhar fora da transação, o gerente nunca saberia da comanda que existe

## Erros

- Usar `AppError` com código do catálogo em `src/domain/errors.ts`
- Handler global (`src/http/server.ts`) converte para `{ error: { code, message, details } }`
- **Nunca** deixar vazar erro cru (500 interno) onde cabe um erro de domínio

## Pagamento fracionado

- Fonte da verdade: `order_payment` (1 linha por forma)
- `order.payment_method` é só denormalizado de exibição
- Fechamento exige ≥1 linha, todas `confirmed` e soma == total
- Erros: `payment_not_registered` / `payment_not_confirmed` / `invalid_payment_total`
- Endpoints: `PUT /orders/:id/payments`, `PATCH/DELETE /orders/:id/payments/:paymentId`
- `PATCH /orders/:id/payment` legado é adaptador de intenção única (self-service/delivery)
- **Linha `confirmed` não pode ser apagada** por `PUT /orders/:id/payments` (nem pelo
  legado): a gaveta não tem saldo próprio e deriva o esperado de `order_payment`
  `cash AND confirmed` na janela da sessão, então apagar a linha faz o dinheiro sumir
  da conferência sem sangra nem estorno. A guarda vale pra todos os métodos (o
  relatório de vendas também soma `order_payment`) e roda **antes** da conferência
  `soma == total` — a resposta honesta é `invalid_transition`, não "soma não confere".
  Caminhos: confirmada que continua na lista com mesmo método e mesmo valor é
  **preservada** (id/`confirmed_at`/`confirmed_by` intactos, só `received`/`change`
  mudam → o PUT repete sem efeito colateral); confirmada que some da lista é
  **recusada**; não confirmadas seguem reescrevíveis. O estorno é explícito
  (`cancelOrderUsecase` gera a sangria, ou sangria no caixa) — nunca implícito.
  `order.usecases.ts` → `planPaymentLines` (lê/valida) + `upsertPaymentLines` (escreve)

## Idempotência

- Endpoints marcados: `POST /orders`, `POST /orders/:id/items`, `PATCH /orders/:id/close`, fluxo de caixa
- Usar `withIdempotency` com `correlationId`
- `failed`/expirado reprocessa na mesma linha; `completed` válido devolve cache
- Corrida de insert nunca gera 500 (check-then-insert detecta colisão e devolve resposta da vencedora)
- Chaves expiradas são purgadas pelo job de maintenance

## Lock otimista

- Toda mutação de `order_item` via `PATCH /orders/:id/items/:itemId` exige `expectedVersion`
- Em conflito, responder `concurrency_conflict`

## Cardápio Unami (seed, não migration)

- `backend/seed-data/menu-unami.sql` carrega o cardápio do restaurante Unami (11 categorias, 63 produtos)
- É **dado, não schema** — só `INSERT` com ID determinístico (`cat-unami-*` / `p-unami-NNN`)
- `ON CONFLICT (id) DO UPDATE` restrito aos campos de catálogo (name/description/price/categoria/cozinha)
- Reaplicar **não** sobrescreve `active`, `featured`, `cost_price`, `track_stock`, `unit` nem `variations`
- **Não roda automaticamente no boot** — aplicado por `backend/src/infra/db/load-menu.ts` (`node dist/infra/db/load-menu.js`), chamado pelo `deploy/install.sh` após o seed-prod

## Estoque (ledger)

- Saldo de um produto = soma dos `quantity_delta` de `stock_movement` (`sale`/`refund`/`purchase`/`adjustment`)
- Débito acontece em `addItemsUsecase` **dentro da transação** (mesma `db.transaction` do insert do item)
- Check de saldo antes, `order_item.cost_price` snapshot do custo
- `rollback` de lote é automático por `throw`
- Refund em `deleteItem`/`cancelOrder` re-credita os `sale` do ledger (por `order_item_id`/`order_id`)
- Movimentos manuais (`POST /stock/:productId/movements`) são idempotentes e viram `stock_movement_manual` no audit
- API e regras em `src/application/stock/stock.usecases.ts`

## Storage de arquivos (fotos: produto, logo, cliente, equipe)

`src/infra/storage/` é a **única** parte do backend que conhece o layout em disco. Antes dela
existiam 4 cópias da mesma lógica (uma por coluna), cada uma com seu `uploadsDir()`/`removeFile()`.

```
<UPLOADS_DIR>/<schema>/<kind>/<filename>      kind ∈ product | logo | customer | user
uploads/public/logo/logo.png
uploads/public/product/0f9c….webp
```

- **O banco não muda**: `products.image_path`, `store_settings.logo_path`, `user.photo_path` e
  `customer.photo_path` continuam guardando **só o basename**. Sem migration.
- **A API devolve `/uploads/<kind>/<filename>`** (um segmento a mais). O frontend trata o valor
  como URL opaca (`assetUrl(x)`) — **nenhum consumidor faz parse do caminho**.
- **Porta `FileStorage`** (`put`/`get`/`remove`/`exists`) + adapter `LocalDiskStorage`, com
  singleton `getStorage()`. Nada na interface é específico de `fs`: S3/R2 entra como troca de adapter.
- **Seam do tenant**: `resolveTenantSchema()` (`storage/tenant.ts`) — hoje só
  `DEFAULT_TENANT_SCHEMA ?? "public"`. A Fase 2 do doc 15 (§6) troca o **corpo** dessa função pela
  leitura do ALS; **nenhum outro arquivo muda**.
- **Serving**: `GET /uploads/:kind/:filename` em `src/http/routes/uploads.routes.ts` (substitui o
  `@fastify/static`, removido do `package.json`). Valida `kind` contra a whitelist, valida `filename`
  (`isSafeFilename`: sem `..`, sem barra, sem caminho absoluto) e responde `404` no resto. O schema
  **não** vai na URL → a URL da loja A dá 404 na loja B por construção. `Cache-Control`:
  `immutable` para os nomes UUID, `no-cache` para o logo (é sobrescrito no lugar). `ETag` +
  `Last-Modified` respondidos, `304` em `if-none-match`, `nosniff` sempre.
  O **prefixo `/uploads/` não muda** — `deploy/Caddyfile` e o volume `pdv_backend_uploads` seguem iguais.

### Migração do layout antigo (flat → por tenant)

```bash
npm run uploads:migrate-layout -- --dry-run   # só o plano
npm run uploads:migrate-layout                # move (idempotente: pode rodar 2×)
npm run uploads:migrate-layout -- --copy      # copia e mantém o flat
npm run uploads:migrate-layout -- --revert    # volta pro flat (idempotente)
UPLOADS_DIR=/app/uploads npm run uploads:migrate-layout   # em produção
```

Lê as **4 colunas** para decidir o `kind` de cada arquivo (um `<uuid>.png` solto não é
classificável por nome), move só o que reconhece e imprime o resumo por kind. **Órfão (arquivo sem
referência) nunca é apagado** — é reportado; referência sem arquivo também. Em caso de nome
classificado por dois kinds, o script aborta sem mexer em nada.

## Sem rowid

Ordem de inserção de `stock_movement`, `outbox_event` e `purchase_item` vem da sequência `seq BIGSERIAL` (a média móvel é um replay do ledger, então a ordem precisa ser estável). **Não trocar por `created_at`**.

## Validação

- Usar `zod` para validação de payloads
- Erros de validação retornam 422 com detalhes campo a campo

## Detalhe de cliente (0008)

- **Valores crus, não formatados**: `cpf` (11 dígitos), `customer_address.cep` (8), `user.phone`. A entrada aceita com ou sem máscara (`normalizeCpf` em `domain/cpf.ts`, `normalizePhone`, `normalizeCep`); a máscara é apresentação do frontend. Gravar formatado quebraria índice e comparação.
- **CPF**: dígitos verificadores conferidos no servidor (`domain/cpf.ts#isValidCpf`, função pura, mesma do frontend) e **único entre clientes** (`uq_customer_cpf`, índice parcial). Ausente/vazio é `null` e não erro — cliente sem documento continua cadastrável. Colisão → `400 validation_failed` com `{ field: "cpf" }`, mesmo formato do `assertEmailAvailable`.
- **Foto**: coluna `photo_path` guarda **só o basename** (`<id>.<ext>`), nome gerado pelo app; `photoUrl(photoPath, kind)` monta o `/uploads/<kind>/<filename>` na resposta. Regra idêntica em `user`, `product`, `customer` e `store_settings` (o `kind` é explícito: `user`/`customer`/`product`/`logo`) — mudou um, mudou os quatro. O caminho em disco e a remoção do arquivo antigo são do **storage** (§Storage de arquivos), não do use case.
- **Regra de venda do histórico e do gráfico do cliente** = a de `report-overview.usecases.ts`: só comanda `closed`, total por `unit_price × quantity` no snapshot (item `cancelled` fora) **mais a taxa de entrega**. `order_payment` não entra (iFood grava em `order.ifood_payments`) — os dois números precisam bater com o relatório, senão o gerente não sabe qual dos dois está errado.
- **Gráfico por dia**: reusar `bucketKeyFor`/`bucketLabel`/`fillBuckets`/`dayStart`/`dayEnd`. Dia sem venda vem **zerado** (gráfico com buraco é pior que gráfico nenhum), dia é o **local da loja** (`tz`), e o `label` pt-BR sai pronto do backend.
- **Sem cache** no gráfico do cliente: é de uma pessoa e muda a cada pagamento.
