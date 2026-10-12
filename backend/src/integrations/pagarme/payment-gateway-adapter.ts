import { Errors } from "../../domain/errors.js";
import type { GatewayChargeRequest, PaymentGateway as DomainPaymentGateway } from "../../domain/payment.js";
import type {
  PaymentChargeRequest,
  PaymentChargeResult,
  PaymentGateway,
} from "../../application/ports/effects.js";
import type { Json } from "../../application/ports/repositories.js";
import { PagarmeGateway } from "./gateway.js";

/**
 * Adapter do port `PaymentGateway` de `application/ports/effects.ts` — FASE 0.
 *
 * O port é uma VISÃO SIMPLIFICADA do contrato do domínio
 * (`domain/payment.ts#PaymentGateway`, implementado por `PagarmeGateway`):
 * o use case migrado fala `createCharge`/`refund` com campos prontos, e este
 * adapter faz a tradução para o `GatewayChargeRequest` que o Pagar.me V5
 * exige. As regras de máquina de estados NÃO mudam de lugar: este adapter não
 * grava nada local — quem confirma status é o webhook/reconciliação (spec §20),
 * e quem persiste a linha local é o use case.
 *
 * ## Traduções (todas documentadas porque não são 1:1)
 *
 * - `code`: a referência da loja no gateway é o `orderId` truncado em 52
 *   chars — o mesmo que `createPaymentUsecase` usa hoje.
 * - `items`: o port não carrega a lista de itens, mas o V5 exige `items[]` e a
 *   soma dos itens É o total do pedido (ver `buildCreateOrderBody`). O adapter
 *   sintetiza UM item com `unitAmount = amount`, então a soma continua igual ao
 *   total cobrado.
 * - `customer.name`: único campo obrigatório do customer; sem nome, cai no
 *   mesmo fallback `"Cliente"` do use case atual.
 * - `cardToken`/`cardId`/`installments`: o port não tem campo de cartão; a
 *   passagem é por `metadata.cardToken`/`metadata.cardId`/`metadata.installments`
 *   (escape hatch documentado). `credit_card` sem nenhum dos dois é recusado
 *   aqui com a MESMA validação do use case (`cardToken` obrigatório — PCI: só
 *   token/cartão-salvo, nunca PAN).
 * - `raw`: o mapper (`mapOrderToCharge`) descarta o corpo bruto do provedor,
 *   então fica `undefined` — não há de onde preenchê-lo sem mudar o mapper.
 *
 * `refund` é 1:1 (`amount` ausente = integral, idem port e domínio).
 */
function metadataField(metadata: PaymentChargeRequest["metadata"], key: string): Json | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, Json>)[key];
}

function metadataString(metadata: PaymentChargeRequest["metadata"], key: string): string | undefined {
  const value = metadataField(metadata, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataNumber(metadata: PaymentChargeRequest["metadata"], key: string): number | undefined {
  const value = metadataField(metadata, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class PaymentGatewayAdapter implements PaymentGateway {
  /** `PagarmeGateway` por default (stateless); injetável para dublê de teste. */
  constructor(private readonly gateway: DomainPaymentGateway = new PagarmeGateway()) {}

  async createCharge(request: PaymentChargeRequest): Promise<PaymentChargeResult> {
    const cardToken = metadataString(request.metadata, "cardToken");
    const cardId = metadataString(request.metadata, "cardId");
    const installments = metadataNumber(request.metadata, "installments");

    if (request.method === "credit_card" && !cardToken && !cardId) {
      throw Errors.validationFailed({ field: "cardToken", reason: "cartão precisa ser tokenizado" });
    }

    const code = request.orderId.slice(0, 52);
    const charge = await this.gateway.create({
      orderId: request.orderId,
      code,
      items: [
        { code, description: `Pedido ${request.orderId}`, quantity: 1, unitAmount: request.amount },
      ],
      customer: {
        name: request.customerName ?? "Cliente",
        email: request.customerEmail ?? undefined,
        document: request.customerDocument ?? undefined,
      },
      method: request.method,
      amount: request.amount,
      cardToken,
      cardId,
      installments,
    });

    return {
      providerOrderId: charge.providerOrderId,
      providerChargeId: charge.providerChargeId ?? null,
      providerPaymentId: charge.providerPaymentId ?? null,
      status: charge.status,
      qrCode: charge.pix?.qrCode ?? null,
      qrCodeBase64: charge.pix?.qrCodeBase64 ?? null,
      qrCodeUrl: charge.pix?.qrCodeUrl ?? null,
      pixTxid: charge.pix?.txid ?? null,
      pixExpiresAt: charge.pix?.expiresAt ?? null,
      // `raw` fica ausente de propósito: ver nota no topo.
    };
  }

  /** `amount` ausente = estorno integral — mesma semântica do domínio. */
  async refund(input: { providerOrderId: string; amount?: number }): Promise<{ providerRefundId?: string }> {
    return this.gateway.refund(input.providerOrderId, input.amount);
  }
}
