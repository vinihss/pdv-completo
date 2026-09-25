# Estoque Profissional — Spec de Implementação

Documento do módulo de estoque profissional (fornecedores, compras
multi-item, custo médio móvel e valorização). Complementa `07-estoque.md` —
que segue sendo a fonte do ledger básico — e define o comportamento que os
critérios de aceite em `03-acceptance-criteria.md` verificam.

## Conceito

O módulo adiciona **valoração** ao ledger básico: a compra deixa de ser um
movimento avulso e vira um **documento** (`purchase`) com fornecedor, nota e
linhas (`purchase_item`), e o custo do produto passa a ser calculado pelo
**método da média móvel ponderada** — nunca mais editado manualmente quando o
módulo está ligado.

```
custo médio móvel = (saldo anterior × custo anterior + qtde comprada × custo da compra)
                    ─────────────────────────────────────────────────────────────────────
                                        (saldo anterior + qtde comprada)
```

- O cálculo é **replay do ledger**: a média é recomputada pela ordem
  cronológica dos movimentos (`adjustment` de estoque inicial, `purchase` das
  linhas de compra), usando `unit_cost` de `stock_movement` — a mesma fonte da
  verdade do saldo também valora.
- `product.cost_price` é **denormalizado de exibição**, espelhado pela última
  valoração (create com estoque inicial, recebimento de compra).
- `order_item.cost_price` continua **snapshot no lançamento** — agora da média
  móvel quando o módulo de compras está ligado, do custo manual quando não.
- `stock_movement.unit_cost` guarda o custo unitário do movimento (estoque
  inicial e compras); `purchase_item_id` liga o movimento à linha do documento.

## Flags de ativação (rollout seguro)

Mesmo padrão do módulo básico — **padrões desligados** para não mudar
comportamento de instalações existentes:

1. `store_settings.purchase_enabled` (default `false`) — liga o módulo:
   aba Compras do gerente, fornecedores, documentos de compra e custo médio
   móvel. Depende de `inventory_enabled` (o módulo básico precisa estar ligado
   para o gate completo: `inventory_enabled && purchase_enabled`).
2. `product.track_stock` (default `false`) — por produto: só produtos com a
   flag são debitados e **valorados**. Compra de produto sem `track_stock` é
   rejeitada (`422 validation_failed`).

## Regras de corretude

1. **Documento único, uma transação.** `createPurchaseUsecase` grava o
   documento, as linhas, os movimentos `purchase` (um por linha, com
   `unit_cost` e `purchase_item_id`) e espelha `product.cost_price` na mesma
   `db.transaction`, com `logAction("purchase_received")` e evento
   `purchase.received` (room `inventory`) na mesma transação.
2. **Idempotência.** `POST /purchases` usa `withIdempotency` (`correlationId`
   no corpo) — replay devolve o mesmo documento sem duplicar movimento.
3. **Média móvel com baseline.** O estoque inicial do cadastro (movimento
   `adjustment` com `unit_cost = cost_price`) é o primeiro evento de
   valoração; a média depois acumula compras por cima. Ex.: 20 un × R$ 8 +
   5 un × R$ 10 → média (160+50)/25 = **R$ 8,40**.
4. **Custo snapshot na venda.** `addItemsUsecase` grava `order_item.cost_price`
   com `computeMovingAverageTx` quando `inventory_enabled &&
   purchase_enabled && track_stock`; senão, usa o custo manual (comportamento
   anterior, preservado).
5. **Valorização = média × saldo.** `GET /inventory/value` devolve, por
   produto rastreado, `quantity`, `averageCost` e `value` (média × saldo), além
   de `totalValue`. O custo médio **não é** preço de venda — margem no
   relatório continua vindo dos snapshots de venda.

## Endpoints

| Método | Rota | Papel | Corpo / Query |
|---|---|---|---|
| GET | `/suppliers` | manager | `active`? (default só ativos) → `{ data }` |
| POST | `/suppliers` | manager | `{ name, phone?, taxId? }` |
| PATCH | `/suppliers/:id` | manager | `{ name?, phone?, taxId?, active? }` |
| POST | `/purchases` | manager | `{ correlationId, items: [{ productId, quantity, unitCost, batchNo?, expiryDate? }], supplierId?, invoiceNumber?, issuedOn?, note? }` — idempotente; resposta inclui `averages` (média pós-compra por produto) |
| GET | `/purchases` | manager | `limit`, `offset` → `{ data, total }` |
| GET | `/purchases/:id` | manager | documento + linhas + `averages` |
| GET | `/inventory/value` | manager | `{ totalValue, data: [{ productId, name, quantity, averageCost, value }] }` |

Realtime: `purchase.received` (novo) e `stock.movement` vão para o room
`inventory` — o app do gerente assina o room e atualiza Estoque/Compras ao
vivo.

## Impacto no resto do sistema

- **Cadastro de produto** ganha `unit` (unidade de medida — "Un", "kg", "L",
  "cx"...) exibida na aba Estoque e na tela de compra; o estoque inicial grava
  `unit_cost` do custo informado (primeiro evento de valoração).
- **Configurações** ganham o toggle "Compras / fornecedores"
  (`purchase_enabled`), visível sempre; a aba Compras só aparece com o toggle
  ligado.
- **Relatório de vendas** inalterado (margem por snapshot); a valorização
  aparece na aba Estoque (cartão "Valorização do estoque") e no endpoint
  dedicado.

## Pendências (próximas fases)

- **Inventário/contagem** (`stock_count`): sessão de contagem com divergência
  gerando `adjustment` automático.
- **Lote/validade por movimento**: `purchase_item` já guarda `batch_no`/
  `expiry_date` (rastreio de entrada), mas o ledger não lotea por saída —
  sem FIFO/FEFO (decisão consciente: rastreio simples primeiro).
- **Multi-depósito**: `stock_movement` é por produto, sem depósito/locação.
- **Ficha técnica/ingredientes**: composição por produto (decomposição de
  receita em compras).
- **Relatórios operacionais**: compras por fornecedor/período, curva ABC,
  perdas por ajuste.

## Testes

`backend/test/purchase.test.ts` (vitest) cobre: fornecedor (criar, listar,
atualizar, desativar), rejeição de compra sem itens e de produto sem
`track_stock`, documento multi-item com ledger de valoração + audit + evento
realtime, replay idempotente, valorização do estoque (`totalValue`/`value`/
`averageCost`) e snapshot de custo na venda usando a média móvel (não o custo
manual). Roda com `npm run test` no `backend/`.

Frontend: aba Compras em `src/features/purchase/` (PurchaseTab,
NewPurchaseModal, SupplierModal), campo Unidade no cadastro de produto, toggle
nas configurações e cartão de valorização na aba Estoque; lint/build/test com
`npm run lint`/`build`/`test` no `frontend/`.
