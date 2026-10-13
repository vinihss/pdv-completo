/**
 * Port de pedidos — comandas, itens e linhas de pagamento.
 *
 * Contrato CONGELADO: os use cases (hub `application/order/`, self-service,
 * compat `order-compat`) falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/order.repository.ts`) traduz para Drizzle/schema.
 */
import type {
  Id,
  OrderChannel,
  OrderItemStatus,
  OrderStatus,
  Page,
  PageQuery,
  PaymentMethodKind,
} from "./shared.js";
import type { CustomerOpenOrderRecord, CustomerOrderHistoryRecord } from "./customer.js";

export interface OrderRecord {
  id: Id;
  status: OrderStatus;
  /** Soma dos itens (snapshot `unit_price`, excluindo `cancelled`) + taxa de entrega — computado pelo adapter, igual a `computeOrderTotal`. */
  total: number;
  tableId: Id | null;
}

/** Linha completa de `order` (todas as colunas), fiel ao schema. */
export interface OrderRow {
  id: Id;
  tableId: Id | null;
  customerId: Id | null;
  tabLabel: string | null;
  waiterId: Id;
  status: OrderStatus;
  openedAt: string;
  closedAt: string | null;
  paymentMethod: string | null;
  paymentConfirmedAt: string | null;
  paymentConfirmedBy: Id | null;
  channel: OrderChannel;
  externalRef: string | null;
  deliveryFee: number | null;
  cancelReason: string | null;
  notes: string | null;
}

/** Linha completa de `order_item` (`selectedVariations` = string JSON, como no banco). */
export interface OrderItemRow {
  id: Id;
  orderId: Id;
  productId: Id;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  selectedVariations: string;
  notes: string | null;
  status: OrderItemStatus;
  version: number;
  createdBy: Id;
  createdAt: string;
  updatedAt: string;
}

/** Item + referências do produto (nome/foto/grupo de produção) — o que a tela da cozinha consome. */
export interface OrderItemWithProduct extends OrderItemRow {
  productName: string;
  productImagePath: string | null;
  productKitchenGroupId: Id | null;
}

/** Linha de `order_payment` (pagamento fracionado — 1 linha por forma). */
export interface OrderPaymentLineRow {
  id: Id;
  orderId: Id;
  method: PaymentMethodKind;
  amount: number;
  /** Só cash: quanto o cliente entregou. */
  received: number | null;
  /** Só cash: received - amount (troco). */
  change: number | null;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: Id | null;
  createdBy: Id;
  createdAt: string;
}

export interface OrderRepository {
  findById(id: Id): Promise<OrderRecord | null>;
  findOpenForTable(tableId: Id): Promise<OrderRecord | null>;
  listOpen(query: PageQuery): Promise<Page<OrderRecord>>;
  create(input: { tableId?: Id | null; customerId?: Id | null; channel: string }): Promise<OrderRecord>;
  transition(id: Id, status: OrderStatus, expectedVersion?: number): Promise<OrderRecord>;
  delete(id: Id): Promise<void>;

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Linha completa de `order` (todas as colunas) — o `OrderRecord` acima traz só o resumo. */
  findRow(id: Id): Promise<OrderRow | null>;
  /** Listagem de comandas (`GET /orders`): mais recentes primeiro + total (count). */
  listRows(query: { status?: OrderStatus; limit: number; offset: number }): Promise<Page<OrderRow>>;
  /**
   * INSERT da comanda (`POST /orders`): todos os campos do input do use case.
   * Identificação (mesa/cliente/tabLabel) e claim da mesa são do use case —
   * aqui vale o CHECK `chk_order_identification_required`.
   */
  open(input: {
    waiterId: Id;
    tableId?: Id | null;
    customerId?: Id | null;
    tabLabel?: string | null;
    channel?: OrderChannel;
    deliveryFee?: number | null;
    externalRef?: string | null;
    notes?: string | null;
  }): Promise<OrderRow>;
  /** Fechamento (`PATCH /orders/:id/close`): status + closedAt. Invariantas de pagamento ficam no use case. */
  markClosed(id: Id): Promise<OrderRow>;
  /** Cancelamento (`PATCH /orders/:id/cancel`): status + closedAt + cancelReason. */
  markCancelled(id: Id, reason: string): Promise<OrderRow>;
  /** Status das comandas em lote (alertas mostram "encerrada" sem N+1). */
  listStatuses(ids: Id[]): Promise<Array<{ id: Id; status: string }>>;

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /** Comandas em lote por ids (hidratação das listagens de entrega, uma query só). */
  listRowsByIds(ids: Id[]): Promise<OrderRow[]>;
  /**
   * Comanda em aberto mais recente de um cliente num conjunto de canais —
   * retomada do self-service (`getActiveSelfServiceOrderByPhone`). `channels`
   * inclui o legado `whatsapp` para não esconder pedido antigo.
   */
  findLatestOpenByCustomer(customerId: Id, channels: OrderChannel[]): Promise<OrderRow | null>;
  /**
   * Marca como `delivered` todos os itens pendentes (não `delivered`/`cancelled`)
   * da comanda — efeito de `closeOrderAfterDelivery`. A comanda de entrega não
   * tem garçom servindo mesa, então nenhum item chega a "delivered" sozinho.
   */
  markItemsDelivered(orderId: Id): Promise<void>;

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------
  /**
   * Comandas ABERTAS do cliente, mais antigas primeiro, com `tableNumber`
   * resolvida por LEFT JOIN — bloco "comanda em aberto" do detalhe do cliente.
   */
  listOpenByCustomer(customerId: Id): Promise<CustomerOpenOrderRecord[]>;
  /**
   * Histórico paginado do cliente: `closedAt DESC NULLS LAST, openedAt DESC`
   * + contagem do conjunto filtrado, com `tableNumber` por LEFT JOIN. `from`/`to`
   * já chegam RESOLVIDOS (bordas do dia local da loja) — o use case valida e
   * converte `YYYY-MM-DD` com o `tz` antes de chamar.
   */
  listHistoryByCustomer(
    customerId: Id,
    query: { limit: number; offset: number; from?: string; to?: string },
  ): Promise<Page<CustomerOrderHistoryRecord>>;
  /**
   * Comandas FECHADAS do cliente com `closedAt` em `[from, to]` (bordas já
   * resolvidas) — só `id`/`closedAt`/`deliveryFee`, que é o que a série de
   * consumo agrega em JS (mesma régua da visão geral).
   */
  listClosedByCustomerBetween(
    customerId: Id,
    from: string,
    to: string,
  ): Promise<Array<{ id: Id; closedAt: string | null; deliveryFee: number | null }>>;
  /**
   * Total e contagem de itens por comanda, numa query agrupada. Mesmo cálculo
   * de `computeOrderTotal` (soma `unit_price × quantity` do snapshot, excluindo
   * `cancelled`); `itemCount` soma `quantity`, não linhas.
   */
  aggregateItemsByOrders(orderIds: Id[]): Promise<Map<Id, { total: number; itemCount: number }>>;

  // -- itens --
  /** Itens da comanda (linhas cruas — sem join de produto). */
  listItemRows(orderId: Id): Promise<OrderItemRow[]>;
  /** Itens + refs do produto (nome/foto/grupo) — o que `serializeItem` consome. */
  listItemsWithProduct(orderId: Id): Promise<OrderItemWithProduct[]>;
  /** Itens + refs em lote por comandas (listagem — uma query só). */
  listItemsWithProductForOrders(ids: Id[]): Promise<OrderItemWithProduct[]>;
  findItem(itemId: Id): Promise<OrderItemRow | null>;
  insertItem(input: {
    orderId: Id;
    productId: Id;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    /** String JSON pronta (snapshot das variações escolhidas). */
    selectedVariations: string;
    notes?: string | null;
    createdBy: Id;
    status: OrderItemStatus;
  }): Promise<OrderItemRow>;
  /**
   * Mutação de item com LOCK OTIMISTA (coluna `version`). Devolve `null` quando
   * a versão não casa mais — o use case relê a linha e responde
   * `concurrency_conflict` com a versão corrente.
   */
  transitionItemStatus(itemId: Id, status: "ready" | "delivered", expectedVersion: number): Promise<OrderItemRow | null>;
  deleteItem(itemId: Id): Promise<void>;
  /** Cancela os itens pendentes da comanda (não `delivered`, não já `cancelled`). */
  cancelActiveItems(orderId: Id): Promise<void>;

  // -- linhas de pagamento (`order_payment` — pagamento fracionado) --
  listPaymentLines(orderId: Id): Promise<OrderPaymentLineRow[]>;
  /** Lote por comandas (listagem — uma query só). */
  listPaymentLinesForOrders(ids: Id[]): Promise<OrderPaymentLineRow[]>;
  findPaymentLine(id: Id): Promise<OrderPaymentLineRow | null>;
  insertPaymentLine(input: {
    orderId: Id;
    method: PaymentMethodKind;
    amount: number;
    received: number | null;
    change: number | null;
    confirmed: boolean;
    confirmedAt: string | null;
    confirmedBy: Id | null;
    createdBy: Id;
  }): Promise<OrderPaymentLineRow>;
  /** Atualiza `received`/`change` de uma linha preservada no PUT (única mudança permitida). */
  updatePaymentLineReceived(id: Id, input: { received: number | null; change: number | null }): Promise<OrderPaymentLineRow>;
  /** Confirma a linha (PATCH /orders/:id/payments/:paymentId). */
  confirmPaymentLine(id: Id, input: { confirmedAt: string; confirmedBy: Id }): Promise<OrderPaymentLineRow>;
  deletePaymentLine(id: Id): Promise<void>;
  /** Delete em lote (PUT que descartou linhas não confirmadas). */
  deletePaymentLines(ids: Id[]): Promise<void>;
  /**
   * Denormalizado de exibição em `order`: método único → ele; mais de um →
   * null; e/ou o carimbo de "comanda quitada" (todos os pagamentos confirmados).
   */
  updatePaymentSummary(
    id: Id,
    patch: { paymentMethod?: string | null; paymentConfirmedAt: string | null; paymentConfirmedBy: Id | null },
  ): Promise<void>;
}
