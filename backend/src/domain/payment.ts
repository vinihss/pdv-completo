// Domínio de pagamento no GATEWAY (Pagar.me V5) — ver migration 0008 e
// integrations/pagarme/.
//
// ## `payment` e `order_payment` são coisas diferentes
//
// A "Payment" daqui é a COBRANÇA no gateway (1 linha por tentativa). A
// `order_payment` do schema é a LINHA REGISTRADA PELA PESSOA no balcão, e é a
// fonte de verdade do caixa e dos relatórios. As duas coexistem: o Pagar.me
// saber que o Pix foi pago não põe dinheiro na gaveta. Ver o bloco de comentário
// em infra/db/schema.ts antes de mexer.
//
// ## Status em minúsculas
//
// A spec original escrevia SCREAMING_CASE (PENDING, PAID, REFUNDED) e criava
// também uma máquina de estados para o Order (PENDING_PAYMENT, CONFIRMED,
// PREPARING...). Nenhuma das duas entrou como veio:
//
//   - status minúsculo, porque todo enum deste repo é minúsculo (`open`,
//     `ordered`, `awaiting_courier`, `received`);
//   - o pedido NÃO ganhou máquina de estados nova, porque `order.status` é
//     `open|closed|cancelled` e é carregado por cozinha, relatórios, caixa e
//     pelos critérios de aceite de docs/03. A independência entre "o pedido está
//     em que fase" e "o dinheiro foi ou não" (spec §19) fica na separação
//     entre a entidade `payment` e a comanda — é por aqui que ela se resolve.
//
// ## Dinheiro em reais
//
// O schema do repo guarda REAL (reais), não centavos: NUMERIC devolveria string
// do node-postgres e quebraria round2/moneyEq (ver domain/money.ts). A
// conversão para centavos acontece SÓ na borda do Pagar.me, no mapper. Por isso
// `amount` aqui é real e o cents aparece em GatewayChargeRequest/Response só
// quando o nome diz `Cents`.
//
// Sem import de infra/http: este arquivo é regra pura e testável sem banco.

import { Errors } from "./errors.js";

// Só o que o GATEWAY faz. O enum `payment_method` do repo (cash/card/pix/other)
// é o vocabulário do balcão, na `order_payment`, e não se mistura com este:
// 'pix' é a única palavra em comum, e mesmo aí são eixos diferentes.
export type PaymentMethod = "pix" | "credit_card";

export type PaymentStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "canceled"
  | "partially_refunded"
  | "refunded";

export type PaymentEventStatus = "received" | "processing" | "processed" | "ignored" | "failed";

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "pending",
  "processing",
  "paid",
  "failed",
  "canceled",
  "partially_refunded",
  "refunded",
] as const;

export const PAYMENT_METHODS: readonly PaymentMethod[] = ["pix", "credit_card"] as const;

/**
 * Transições permitidas (spec §18, com `partially_refunded` acrescentado).
 *
 * `pending → paid` e `processing → paid` existem porque o webhook chega sem
 * passar por `processing`: o Pagar.me pode mandar `order.paid` direto para uma
 * cobrança que nunca foi lida como "em processamento" localmente, e recusar o
 * evento por estado seria perder dinheiro.
 *
 * `partially_refunded → partially_refunded` é o estorno parcelado repetido
 * (R$ 10 + R$ 10 + R$ 5): a soma é que decide a saída para `refunded`, não o
 * número de pedidos de estorno.
 *
 * `failed`, `canceled` e `refunded` são terminais. Um pagamento recusado pelo
 * gateway não "volta" — a tentativa seguinte é OUTRA linha (outro `attempt`).
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["processing", "paid", "failed", "canceled"],
  processing: ["paid", "failed", "canceled"],
  paid: ["partially_refunded", "refunded", "canceled"],
  partially_refunded: ["partially_refunded", "refunded"],
  failed: [],
  canceled: [],
  refunded: [],
};

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[status].length === 0;
}

/**
 * Guarda de transição. Lança `invalid_transition` (400) — o mesmo código que o
 * app já usa para conflito de estado de comanda/entrega.
 */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (canTransition(from, to)) return;
  throw Errors.invalidTransition(
    isTerminal(from)
      ? `Pagamento em ${PAYMENT_STATUS_LABEL[from]} não aceita mais mudanças (pediu ${PAYMENT_STATUS_LABEL[to]}).`
      : `Pagamento não pode ir de ${PAYMENT_STATUS_LABEL[from]} para ${PAYMENT_STATUS_LABEL[to]}.`
  );
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: "pendente",
  processing: "processando",
  paid: "pago",
  failed: "falhou",
  canceled: "cancelado",
  partially_refunded: "estornado parcialmente",
  refunded: "estornado",
};

/** Quanto ainda dá para estornar: o que foi pago menos o que já voltou. */
export function refundableAmount(amount: number, refundedAmount: number): number {
  return Math.max(0, Math.round((amount - refundedAmount) * 100) / 100);
}

/** O estorno cobriu tudo que foi pago? (define paid → refunded) */
export function isFullyRefunded(amount: number, refundedAmount: number): boolean {
  return refundedAmount > 0 && refundedAmount >= amount - 0.001;
}

// ============================================================
// Contrato do gateway (spec §7)
// ============================================================

/** Item no formato do gateway. `unitAmount` em REAIS; o mapper converte. */
export interface GatewayItem {
  code: string;
  description: string;
  quantity: number;
  unitAmount: number;
}

export interface GatewayCustomer {
  name: string;
  email?: string;
  document?: string;
  code?: string;
}

export interface GatewayChargeRequest {
  orderId: string;
  /** Referência da loja no pedido do gateway (≤52 chars na doc oficial). */
  code: string;
  items: GatewayItem[];
  customer: GatewayCustomer;
  method: PaymentMethod;
  /** Total em reais. */
  amount: number;
  /**
   * Token/cartão SEM PAN. A doc oficial do Pagar.me é explícita: use
   * `card_id` ou `card_token` e nunca envie `card` com número/CVV, porque
   * trafegar dado aberto de cartão pelo servidor é o que exige PCI. Aqui só
   * existe token — não há campo para PAN por construção.
   */
  cardToken?: string;
  cardId?: string;
  installments?: number;
  /** Validade do Pix em segundos (o gateway define o default). */
  expiresInSeconds?: number;
}

export interface GatewayPixData {
  qrCode?: string;
  qrCodeBase64?: string;
  qrCodeUrl?: string;
  txid?: string;
  expiresAt?: string;
}

export interface GatewayCharge {
  providerOrderId: string;
  providerChargeId?: string;
  providerPaymentId?: string;
  /** Já traduzido para o vocabulário local (ver mapper.mapStatus). */
  status: PaymentStatus;
  /** Reais. */
  amount: number;
  paidAmount?: number;
  refundedAmount?: number;
  pix?: GatewayPixData;
  /** Só os 4 últimos e a bandeira — o resto do cartão nunca chega aqui. */
  cardLast4?: string;
  cardBrand?: string;
}

/**
 * O domínio conhece SÓ esta interface. `PagarmeGateway` implementa; o caso de
 * teste implementa com um dublê (docs/agent-testing.md). Regra do §1 da spec: o
 * domínio não pode importar classe do Pagar.me — e também não importa nenhuma,
 * porque o mapper é a única coisa que fala o dialeto do gateway.
 */
export interface PaymentGateway {
  create(request: GatewayChargeRequest): Promise<GatewayCharge>;
  /** `null` quando o gateway não conhece esse id (404). */
  find(providerOrderId: string): Promise<GatewayCharge | null>;
  /**
   * Cancelamento no gateway. NÃO muda o estado local: o cancelamento só é
   * confirmado por webhook (ou reconciliação). Ver spec §20 — uma resposta 2xx
   * aqui não é prova de que o dinheiro não foi movementado.
   */
  cancel(providerOrderId: string): Promise<void>;
  /** `amount` em reais; ausente = integral. Também só o webhook confirma. */
  refund(providerOrderId: string, amount?: number): Promise<{ providerRefundId?: string }>;
}

/**
 * Erro da fronteira do gateway, com a classificação da spec §26. É
 * deliberadamente uma classe à parte do `AppError`: `AppError` carrega o
 * `code`/`status` do contrato HTTP do PDV (que o error handler do Fastify já
 * entende), e este carrega o `kind` do provedor. A tradução kind → AppError
 * acontece na camada de aplicação, uma vez só.
 */
export type PaymentGatewayErrorKind =
  | "validation"
  | "auth"
  | "conflict"
  | "rate_limit"
  | "unavailable"
  | "unknown";

export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    public readonly kind: PaymentGatewayErrorKind,
    public readonly status: number,
    /** Só o gateway pode repetir a operação sozinho. */
    public readonly retryable: boolean = false,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PaymentGatewayError";
  }
}