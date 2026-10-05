import type { GatewayCharge, GatewayChargeRequest, PaymentGateway } from "../../domain/payment.js";
import { PaymentGatewayError } from "../../domain/payment.js";
import { PagarmeApiError, pagarmeFetch } from "./client.js";
import { isPagarmeEnabled, pagarmeConfig } from "./config.js";
import { buildCreateOrderBody, mapOrderToCharge } from "./mapper.js";

// A implementação da interface `PaymentGateway` para o Pagar.me V5.
//
// Ponto central: ESTA CLASSE NÃO MUDA ESTADO LOCAL. Ela só fala com o gateway.
// Quem muda `payment.status` é o webhook (ou a reconciliação), porque uma
// resposta 2xx de criação/cancelamento/estorno não é prova de que o dinheiro
// movementou — a spec §12 e §20 são explícitas nisso, e é a diferença entre um
// "pago" que o sistema inventou e um "pago" que o gateway confirmou.

function toGatewayError(err: unknown, op: string): PaymentGatewayError {
  if (err instanceof PagarmeApiError) {
    return new PaymentGatewayError(`${op}: ${err.message}`, err.kind, err.status, err.retryable, err.body);
  }
  if (err instanceof PaymentGatewayError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PaymentGatewayError(`${op}: ${message}`, "unknown", 0, false);
}

/** Cobre o caso de alguém chamar o gateway sem credencial: erro de configuração, não de URL. */
function requireConfigured(): void {
  if (!isPagarmeEnabled()) {
    throw new PaymentGatewayError(
      "Pagar.me não configurado (PAGARME_ENABLED/ PAGARME_SECRET_KEY)",
      "auth",
      0,
      false,
    );
  }
}

export class PagarmeGateway implements PaymentGateway {
  /**
   * `POST /orders`. Devolve o que o gateway respondeu — inclusive, e isso é o
   * ponto, um pagamento que ainda está `pending`: receber a cobrança NÃO é
   * receber o dinheiro. Quem confirma é o webhook (`order.paid`) e, se ele se
   * perder, a reconciliação.
   *
   * O corpo devolvido pode não trazer o QR (a doc oficial consultada não mostra
   * onde ele vem — ver mapper.extractPix). Nesse caso `charge.pix` é undefined
   * e a linha local fica sem QR, preenchida no próximo ciclo. Não é erro: a
   * cobrança existe e o dinheiro pode entrar pelo QR que o cliente já recebeu.
   *
   * NÃO há retry aqui, apesar de o erro 5xx vir marcado como retryable: repetir
   * um POST de criação sem chave de idempotência do gateway é a cobrança
   * duplicada que a spec §26 proíbe. Quem pode reexecutar é o worker, e apenas
   * quando a linha local ainda não tem `provider_order_id`.
   */
  async create(request: GatewayChargeRequest): Promise<GatewayCharge> {
    requireConfigured();
    try {
      const json = await pagarmeFetch<Record<string, unknown>>("/orders", {
        method: "POST",
        body: buildCreateOrderBody(request),
        correlationId: request.orderId,
      });
      if (!json) throw new PaymentGatewayError("criação devolveu corpo vazio", "unknown", 0, false);
      return mapOrderToCharge(json);
    } catch (err) {
      throw toGatewayError(err, "criação de cobrança no Pagar.me");
    }
  }

  /**
   * `GET /orders/{id}` — a fonte de verdade quando o webhook se perde (spec §22).
   * `null` quando o gateway não conhece o id, que é a resposta de "essa
   * cobrança não é nossa/não existe mais", não um erro.
   */
  async find(providerOrderId: string): Promise<GatewayCharge | null> {
    requireConfigured();
    try {
      const json = await pagarmeFetch<Record<string, unknown>>(pagarmeConfig.orderUrl(providerOrderId));
      if (!json) return null;
      return mapOrderToCharge(json);
    } catch (err) {
      throw toGatewayError(err, `consulta da cobrança ${providerOrderId}`);
    }
  }

  /**
   * Pede o cancelamento. NÃO marca a cobrança local como cancelada: a spec §20
   * manda esperar a confirmação, porque o cancelamento pode ser assíncrono e um
   * "cancelado" local antes da hora é um pedido que some da fila de cobrança
   * com o cliente ainda podendo pagar.
   *
   * O evento que confirma é `order.canceled` / `charge.payment_failed`.
   */
  async cancel(providerOrderId: string): Promise<void> {
    requireConfigured();
    try {
      // TODO(pagarme): caminho não confirmado na doc oficial (ver config.ts). O
      // efeito de errar o path é "cancelamento não aconteceu" — o que a
      // reconciliação detecta — e nunca "cancelado sem o PDV saber".
      await pagarmeFetch(pagarmeConfig.cancelUrl(providerOrderId), {
        method: "POST",
        body: {},
        correlationId: providerOrderId,
      });
    } catch (err) {
      throw toGatewayError(err, `cancelamento da cobrança ${providerOrderId}`);
    }
  }

  /**
   * Estorno, parcial (`amount`) ou integral (sem `amount`). Assim como
   * `cancel`, só PEDE: o `payment.status` vai para `partially_refunded`/
   * `refunded` quando o evento `charge.refunded` chegar ou a reconciliação
   * reler o gateway.
   *
   * A checagem de saldo estornável é da camada de aplicação, não daqui — o
   * gateway descobre o que é pedido, quem decide o que é legítimo é o PDV
   * (e `payment.refunded_amount`, atualizado na mesma transação).
   */
  async refund(providerOrderId: string, amount?: number): Promise<{ providerRefundId?: string }> {
    requireConfigured();
    try {
      // TODO(pagarme): caminho e corpo não confirmados na doc oficial (ver
      // config.ts). Mesmo raciocínio do cancel: errar aqui custa um estorno que
      // não aconteceu, não um estorno fantasma.
      const json = await pagarmeFetch<Record<string, unknown>>(pagarmeConfig.refundUrl(providerOrderId), {
        method: "POST",
        body: amount != null ? { amount: Math.round(amount * 100) } : {},
        correlationId: providerOrderId,
      });
      const id = json?.["id"];
      return { providerRefundId: typeof id === "string" ? id : undefined };
    } catch (err) {
      throw toGatewayError(err, `estorno da cobrança ${providerOrderId}`);
    }
  }
}