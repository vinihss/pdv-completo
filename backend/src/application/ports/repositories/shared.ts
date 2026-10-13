/**
 * Tipos primitivos e unions compartilhados dos ports de repositório.
 *
 * Os unions espelham os enums do schema (sem importá-lo — a camada application
 * não vê Drizzle). São usados por mais de um domínio (ex.: `PaymentMethodKind`
 * em order/refund, `OrderStatus` em order/customer/report), então moram aqui e
 * não junto de um dono só.
 */

// ---------- tipos primitivos ----------

export type Id = string;

/** JSON genérico (payloads de audit/outbox/metadata). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface PageQuery {
  limit: number;
  offset: number;
}

export interface Page<T> {
  data: T[];
  total: number;
}

// ---------- unions de status (espelham os enums do schema, sem importá-lo) ----------

export type OrderStatus = "open" | "closed" | "cancelled";
export type DeliveryStatus =
  | "awaiting_courier"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "cancelled";
export type StockMovementKind = "sale" | "refund" | "purchase" | "adjustment";
export type PaymentMethodKind = "cash" | "card" | "pix" | "other";
export type UserRole = "waiter" | "kitchen" | "manager" | "courier" | "system" | "cashier";
export type CashMovementKind = "sangria" | "suprimento";

/** ADIÇÃO (Onda 3C — store-settings): tipo de chave Pix (espelha o enum `pix_key_type`). */
export type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

// ---------- canais/estados de item do hub de pedidos ----------

// `whatsapp` seguia no enum do banco só por compatibilidade: o canal deixou
// de existir no código, mas pedidos antigos de delivery feitos por ele
// continuam válidos como histórico (relatórios, reimpressão, retomada).
// Entra no union porque a retomada do self-service (`getActiveSelfServiceOrder
// ByPhone`) lê `channel IN ('whatsapp', 'web')` para não esconder pedido antigo.
export type OrderChannel = "balcao" | "web" | "whatsapp";
export type OrderItemStatus = "ordered" | "ready" | "delivered" | "cancelled";
