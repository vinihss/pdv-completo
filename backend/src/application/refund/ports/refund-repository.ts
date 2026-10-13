/**
 * Port de estornos do balcão (`order_refund`).
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/refund.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, PaymentMethodKind } from "../../ports/repositories/shared.js";

/**
 * ADIÇÃO (Onda financeiro — estornos do balcão, Bloco 4). Estorno rastreável:
 * a venda estornada vira linha negativa no relatório, nunca desaparece. A régua
 * de valores/status é do use case; o adapter lê/grava `order_refund` e agrega.
 */
export interface RefundRecord {
  id: Id;
  orderId: Id;
  orderPaymentId: Id;
  amount: number;
  method: PaymentMethodKind;
  reason: string;
  status: string;
  requestedBy: Id;
  requestedAt: string;
  settledAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface RefundRepository {
  /**
   * Soma dos estornos ATIVOS (`requested`+`settled`) de uma linha de pagamento —
   * teto do `refundOrderPaymentUsecase` (o round2 é do use case).
   */
  sumActiveByPayment(paymentId: Id): Promise<number>;
  create(input: {
    id: Id;
    orderId: Id;
    orderPaymentId: Id;
    amount: number;
    method: PaymentMethodKind;
    reason: string;
    status: string;
    requestedBy: Id;
    requestedAt: string;
    settledAt: string | null;
    notes: string | null;
  }): Promise<RefundRecord>;
  /** Estornos do pedido, em ordem de criação (`createdAt ASC`). */
  listByOrder(orderId: Id): Promise<RefundRecord[]>;
}
