# Estoque — Spec de Implementação

Documento do módulo de controle de estoque (saldo por produto, débito no
lançamento, movimentos manuais e alerta de estoque baixo). Complementa
`01-backend-spec.md` e define o comportamento que os critérios de aceite em
`03-acceptance-criteria.md` verificam.

## Conceito

O estoque é um **ledger de movimentos**: o saldo de cada produto é a **soma
dos `quantity_delta`** de `stock_movement`, nunca um atributo denormalizado na
tabela `product` (nada de coluna "saldo atual" que possa divergir do histórico).

```
saldo do produto = Σ stock_movement.quantity_delta
                   (por product_id)
```

- `stock_movement` é a **fonte da verdade** e o **histórico auditável** (quem
  fez, quando, por quê) de uma vez só.
- O saldo é calculado por leitura (`stockBalance`/`stockBalances`), sem saldo
  materializado — volume do estabelecimento não justifica contador separado.
- **Custo**: `product.cost_price` é o custo unitário atual (edição manual);
  `order_item.cost_price` é o **snapshot** gravado no lançamento, mesma
  disciplina do `unit_price` — é ele que alimenta margem no relatório.

## Tipos de movimento

| Tipo | Sinal | Origem | Nota |
|---|---|---|---|
| `sale` | negativo | lançamento de item em comanda | débito automático no `addItems` |
| `refund` | positivo | item removido ou comanda cancelada | re-credita o que foi debitado (ledger) |
| `purchase` | positivo | entrada manual (gerente) | compra/reposição do fornecedor |
| `adjustment` | ± | ajuste manual (gerente) | contagem, perda, quebra |

`quantity_delta` é `REAL`, sempre `!= 0`. `stock_movement` guarda
`product_id`, `order_id`/`order_item_id` (só venda/estorno), `user_id`,
`note` e `created_at`. O **estorno é decidido pelo ledger**, não pelo flag
atual do produto: `deleteItem` re-credita os movimentos `sale` daquela
`order_item_id`, e `cancelOrder` os `sale` da `order_id` — mesmo que o
produto deixe de rastrear estoque depois, o estorno continua coerente.

## Flags de ativação (rollout seguro)

Como os perfis já usam configuração em `store_settings`, o estoque segue o
mesmo padrão — **padrões desligados** para não mudar comportamento de
instalações existentes:

1. `store_settings.inventory_enabled` (default `false`) — liga o módulo:
   aba Estoque do gerente, validação de saldo no lançamento e bloqueio de
   item com saldo zero.
2. `product.track_stock` (default `false`) — por produto: **só produtos com
   `track_stock = true`** são debitados/bloqueados, mesmo com o módulo ligado.
   O gerente cadastra o estoque inicial no momento em que ativa a flag
   (`initialStock` no `POST /products`), gerando um movimento `adjustment`.

Com o módulo desligado (`inventory_enabled = false`), venda nunca é bloqueada,
não importa o `track_stock` do produto — o débito é condicionado à flag.

## Regras de corretude

1. **Débito no lançamento, na mesma transação.** `addItemsUsecase` valida
   saldo (`Σ deltas`) antes de inserir cada item e grava o movimento `sale`
   com `order_item_id` na mesma `db.transaction` — ou o lote inteiro entra com
   estoque, ou nada entra. Estoque insuficiente → `409 insufficient_stock`
   (factory `Errors.insufficientStock`) com `details` `{ productId, name,
   available }` — o client pode mostrar qual produto falta e o saldo atual.
2. **Refund coerente.** `deleteItemUsecase` (item ainda não `delivered`) e
   `cancelOrderUsecase` re-creditam via `refund`, na mesma transação do
   delete/cancelamento.
3. **Movimentos manuais idempotentes.** `POST /stock/:productId/movements`
   usa `withIdempotency` (corpo exige `correlationId`) — replay não duplica.
   Validação de sinal no usecase: `purchase` exige `quantity > 0`;
   `adjustment` exige `quantity != 0`.
4. **Estoque baixo não bloqueia, avisa.** `stock.low` é emitido (outbox) quando
   o saldo cruza `product.low_stock_threshold` (> 0) — aparece como badge na
   aba Estoque e no cadastro de produtos. Saldo zero, com `track_stock`, **bloqueia**
   o lançamento na UI (item sem estoque) e no backend (`insufficient_stock`).
5. **Custo snapshot.** `order_item.cost_price` é gravado na criação do item a
   partir de `product.cost_price`; alterar o custo depois não muda comandas já
   lançadas (mesma regra do preço).

## Endpoints

| Método | Rota | Papel | Corpo / Query |
|---|---|---|---|
| GET | `/stock` | manager | `q`?, `low_only`?, `limit`, `offset` → `{ data, total }` com `name`, `categoryName`, `quantity`, `low`, `unitCost`, `lowStockThreshold`, `trackStock` |
| GET | `/stock/movements` | manager | `product_id`?, `limit`, `offset` → histórico do ledger |
| POST | `/stock/:productId/movements` | manager | `{ correlationId, type: 'purchase' \| 'adjustment', quantity, note? }` — idempotente |

Realtime: eventos `stock.movement` e `stock.low` vão para o room `inventory`
(já inicial do login de manager). O app do gerente assina o room e atualiza a
aba Estoque ao vivo além do badge de estoque baixo nas abas.

## Impacto no resto do sistema

- **Cadastro de produto** ganha `costPrice`, `lowStockThreshold`, `trackStock`
  e, só na criação, `initialStock` (gera movimento `adjustment` na mesma
  transação do create).
- **Relatório de vendas** ganha `summary.byProduct` com `quantity`, `revenue`
  (snapshot `unit_price`), `cost` (snapshot `order_item.cost_price`) e `profit`
  (`revenue − cost`) — margem calculada no client (profit/revenue).
- **Auditoria**: movimentos manuais viram `stock_movement_manual` no
  `audit_log`; venda/estorno ficam implícitas no próprio ledger.

## Testes

`backend/test/stock.test.ts` (vitest) cobre: consumo e saldo, bloqueio com
`insufficient_stock` e rollback do lote, estorno em delete/cancelamento,
compra com auditoria, ajuste negativo/zero, evento `stock.low`, produto sem
`track_stock` não é debitado, feature desligada não bloqueia, e histórico de
movimentos. Roda com `npm run test` no `backend/` (banco dedicado
`data/test.db`, limpo no global setup).

Frontend: `frontend/` roda vitest com `npm run test`; lint com `npm run lint`.
A feature fica em `src/features/inventory/` (StockTab, MovementsList,
MovementModal), com recarga via room `inventory`.