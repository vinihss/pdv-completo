/**
 * Port de estoque — o LEDGER (`stock_movement`): saldo é sempre soma, nunca
 * coluna cacheada.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/stock.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, StockMovementKind } from "../../ports/repositories/shared.js";

/** Linha de `stock_movement` (ledger). */
export interface StockMovementRecord {
  id: Id;
  productId: Id;
  type: StockMovementKind;
  quantityDelta: number;
  unitCost: number | null;
  purchaseItemId: Id | null;
  orderId: Id | null;
  orderItemId: Id | null;
  note: string | null;
  createdBy: Id;
  createdAt: string;
}

/** Custo médio móvel vigente — replay do ledger (mesmíssimo shape de `MovingAverage`). */
export interface MovingAverageRecord {
  avg: number;
  qty: number;
}

/** Produto rastreado na tela de Estoque (linha de `GET /stock`). */
export interface TrackedStockProductRecord {
  productId: Id;
  name: string;
  categoryId: Id | null;
  categoryName: string | null;
  unit: string;
  /** Custo manual do cadastro (a média móvel vigente é calculada pelo use case). */
  costPrice: number;
  lowStockThreshold: number;
}

/** Movimento do ledger com produto/usuário resolvidos (linha de `GET /stock/movements`). */
export interface StockMovementViewRecord {
  id: Id;
  productId: Id;
  productName: string | null;
  type: StockMovementKind;
  quantityDelta: number;
  unitCost: number | null;
  orderId: Id | null;
  note: string | null;
  userName: string | null;
  createdAt: string;
}

export interface StockRepository {
  /** Saldo do ledger = soma de `quantity_delta` (nunca coluna cacheada). */
  balance(productId: Id): Promise<number>;
  /**
   * Grava um movimento no ledger. Devolve o saldo PÓS-movimento (mesmo papel
   * do retorno de `applyStockMovementTx`).
   *
   * ADIÇÃO (Onda 2): `orderId`/`purchaseItemId` — colunas reais do ledger que
   * `addItems`/`deleteItem`/`cancelOrder` (refund por comanda/item) e a
   * compat `applyStockMovementTx` gravam; sem elas o estorno ficaria órfão.
   * O evento `stock.movement` NÃO é emitido aqui — é `session.outbox` no use
   * case (mesma transação), como nos demais eventos.
   */
  recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: StockMovementKind;
    unitCost?: number;
    purchaseItemId?: Id | null;
    orderId?: Id | null;
    orderItemId?: Id | null;
    note?: string | null;
    actorId?: Id;
  }): Promise<number>;
  reserveForOrder(orderId: Id): Promise<void>;
  releaseForOrder(orderId: Id): Promise<void>;

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Saldos de vários produtos em uma query (listagem de estoque/produtos). */
  balances(productIds: Id[]): Promise<Map<Id, number>>;
  /** Custo médio móvel vigente de 1 produto (replay do ledger). `fallbackCost` = custo manual do cadastro. */
  movingAverage(productId: Id, fallbackCost: number): Promise<MovingAverageRecord>;
  /** Custo médio de vários produtos em uma query agrupada (listagem/valorização). */
  averageCosts(productIds: Id[]): Promise<Map<Id, MovingAverageRecord>>;
  /** Linhas de `GET /stock`: produtos rastreando estoque + nome de categoria. */
  listTrackedProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }>;
  /**
   * ADIÇÃO (Onda financeiro — valorização): produtos rastreando estoque para
   * `GET /inventory/value`. Mesma forma do `listTrackedProducts`, mas com a
   * busca `lower(name) LIKE lower(%term%)` do `inventoryValuationUsecase`
   * original (sem `unaccent`) — a valorização preserva a régua exata.
   */
  listValuationProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }>;
  /** Linhas de `GET /stock/movements` (produto/usuário resolvidos). */
  listMovements(query: { productId?: Id; limit: number; offset: number }): Promise<{
    rows: StockMovementViewRecord[];
    total: number;
  }>;
  /** Movimentos `sale` vinculados a um item (estorno em `deleteItem` lê o ledger, não flags). */
  listSalesMovementsForItem(orderItemId: Id): Promise<Array<Pick<StockMovementRecord, "quantityDelta">>>;
  /** Movimentos `sale` de uma comanda (estorno integral em `cancelOrder`). */
  listSalesMovementsForOrder(orderId: Id): Promise<
    Array<Pick<StockMovementRecord, "productId" | "orderItemId" | "quantityDelta">>
  >;
}
