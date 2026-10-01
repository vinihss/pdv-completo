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

Diretório `backend/migrations/` com 5 arquivos:

| Arquivo | Conteúdo |
|---|---|
| `0001_init.sql` | **todo** o schema (tabelas, índices, extensões) |
| `0002_whatsapp_connections.sql` | token por WABA + tabelas de inbound/outbound |
| `0003_printer.sql` | flags `printer_enabled` / `printer_auto_print` |
| `0003_profile_fields.sql` | `user.phone/email/photo_path`, `customer.email/active`, extensão `unaccent` |
| `0004_alerts.sql` | tabela `alert` (sino da casca) |

**Colisão `0003_*`**: são dois arquivos com o mesmo prefixo. É de propósito — o runner chaveia por filename em `_migrations.name`. **Não renomear**.

**Regras**:
- Sempre usar número zero-padded lexicograficamente **maior** (próximo: `0005_*`)
- Escrever migration idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE ... IF NOT EXISTS`)
- O boot **aborta** se a migration falhar (`runMigrations()` com `await` no `server.ts`)
- **Não reintroduza** `runMigrations()` sem `await`

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

## Sem rowid

Ordem de inserção de `stock_movement`, `outbox_event` e `purchase_item` vem da sequência `seq BIGSERIAL` (a média móvel é um replay do ledger, então a ordem precisa ser estável). **Não trocar por `created_at`**.

## Validação

- Usar `zod` para validação de payloads
- Erros de validação retornam 422 com detalhes campo a campo
