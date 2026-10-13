/**
 * Port de relatórios gerenciais (Onda 3D) — `GET /reports/sales`,
 * `/reports/overview` e `/reports/deliveries`.
 *
 * O adapter replica os MESMOS JOINs/filtros das queries originais (janela de
 * 30 dias default, bordas do dia LOCAL já resolvidas pelo use case via
 * `dayStart`/`dayEnd`); a agregação em JS (totais por comanda, buckets por
 * período) continua nos use cases.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/report.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { DeliveryStatus, Id, OrderItemStatus } from "../../ports/repositories/shared.js";

/**
 * ADIÇÃO (Onda 3D — relatórios gerenciais): comanda fechada com mesa e cliente
 * resolvidos (LEFT JOINs com `restaurant_table` e `customer`) — a base de
 * `GET /reports/sales`.
 */
export interface ReportClosedOrderRow {
  id: Id;
  closedAt: string | null;
  paymentMethod: string | null;
  tableId: Id | null;
  tableNumber: string | null;
  customerId: Id | null;
  customerName: string | null;
  tabLabel: string | null;
  deliveryFee: number | null;
}

/** ADIÇÃO (Onda 3D): linha de `order_item` do relatório de vendas — os totais por comanda/produto são agregados em JS (mesma conta de `computeOrderTotal`). */
export interface ReportItemRow {
  orderId: Id;
  productId: Id;
  unitPrice: number;
  costPrice: number;
  quantity: number;
  status: OrderItemStatus;
}

/** ADIÇÃO (Onda 3D): estorno `settled` por comanda (faturamento líquido do Bloco 4). */
export interface ReportRefundRow {
  orderId: Id;
  amount: number;
}

/** ADIÇÃO (Onda 3D): linha de `order_payment` do relatório de vendas (fracionamento por forma). */
export interface ReportPaymentRow {
  orderId: Id;
  method: string | null;
  amount: number;
  change: number | null;
}

/** ADIÇÃO (Onda 3D): comanda fechada no intervalo — o mínimo que a visão geral e o relatório de entregas consomem. */
export interface ReportOrderSummaryRow {
  id: Id;
  closedAt: string | null;
  deliveryFee: number | null;
}

/** ADIÇÃO (Onda 3D): soma de `unit_price × quantity` por comanda (sem cancelados), numa query agrupada. */
export interface ReportOrderItemsTotalRow {
  orderId: Id;
  total: number;
}

/** ADIÇÃO (Onda 3D): entrega com comanda e entregador resolvidos (innerJoin `delivery`×`order` + leftJoin `user`) — `GET /reports/deliveries`. */
export interface ReportDeliveryRow {
  orderId: Id;
  status: DeliveryStatus;
  courierId: Id | null;
  courierName: string | null;
  deliveryFee: number | null;
  estimatedMinutes: number | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

export interface ReportRepository {
  /** Comandas fechadas com mesa/cliente resolvidos; sem `dateFrom`/`dateTo` vale a janela default de 30 dias (mesma régua do original). */
  listClosedOrders(input: { dateFrom?: string; dateTo?: string }): Promise<ReportClosedOrderRow[]>;
  /** Comandas que contêm o produto (`SELECT DISTINCT order_id` de `order_item`) — filtro `productId` do relatório de vendas. */
  listOrderIdsByProduct(productId: Id): Promise<Id[]>;
  /** Itens das comandas (snapshot de preço/custo + quantidade + status) — `orderIds` vazio devolve `[]`. */
  listOrderItems(orderIds: Id[]): Promise<ReportItemRow[]>;
  /** Estornos `settled` das comandas — `orderIds` vazio devolve `[]`. */
  listSettledRefunds(orderIds: Id[]): Promise<ReportRefundRow[]>;
  /** Nomes dos produtos (hidratação do `byProduct`) — `productIds` vazio devolve `[]`. */
  listProductNames(productIds: Id[]): Promise<Array<{ id: Id; name: string }>>;
  /** Linhas de `order_payment` das comandas (fracionamento por forma) — `orderIds` vazio devolve `[]`. */
  listOrderPayments(orderIds: Id[]): Promise<ReportPaymentRow[]>;
  /** Comandas fechadas com `closedAt` em `[from, to]` — bordas do dia LOCAL já resolvidas pelo use case (visão geral e entregas). */
  listClosedOrdersBetween(from: string, to: string): Promise<ReportOrderSummaryRow[]>;
  /** Soma de `unit_price × quantity` por comanda, excluindo `cancelled`, numa query agrupada — `orderIds` vazio devolve `[]`. */
  listItemsTotalByOrder(orderIds: Id[]): Promise<ReportOrderItemsTotalRow[]>;
  /** Entregas de comandas fechadas no intervalo, com entregador resolvido — `from`/`to` já são bordas UTC do dia local. */
  listDeliveriesBetween(from: string, to: string): Promise<ReportDeliveryRow[]>;
}
