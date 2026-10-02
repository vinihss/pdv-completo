import { config } from "../../config/env.js";

// Conexão com a Pagar.me Core API V5.
//
// Dois ambientes, mesma forma de código (spec §3):
//   sandbox  https://sdx-api.pagar.me/core/v5   sk_test_...
//   produção https://api.pagar.me/core/v5        sk_live_...
//
// Em desenvolvimento, PAGARME_MOCK=true aponta a base para o stub local (mesmo
// truque do IFOOD_MOCK), para o caminho HTTP ser exercitado sem rede externa e
// sem credencial real.

export const pagarmeConfig = {
  enabled: config.pagarmeEnabled,
  secretKey: config.pagarmeSecretKey,
  mock: process.env.PAGARME_MOCK === "true",
  mockPort: Number(process.env.PAGARME_MOCK_PORT ?? 3998),
  baseUrl: config.pagarmeBaseUrl,
  // Timeout de chamada. O backend segura uma conexão do pool por transação e o
  // gateway pode demorar na antifraude de cartão, mas não tanto que a requisição
  // do garçom fique pendurada: 15s é o ponto em que o cliente já desistiu.
  timeoutMs: Number(process.env.PAGARME_TIMEOUT_MS ?? 15_000),
  reconciliationIntervalMs: config.pagarmeReconciliationIntervalMs,

  // ---------- URLs ----------
  //
  // `POST /orders` e `GET /orders/{id}` estão confirmados na documentação
  // oficial (o OpenAPI de "criar pedido" declara o path `/orders` sob o server
  // `https://api.pagar.me/core/v5`, com auth HTTP Basic).
  orderUrl: (id?: string) => `${pagarmeConfig.baseUrl}/orders${id ? `/${id}` : ""}`,

  // TODO(pagarme): os dois caminhos abaixo NÃO foram confirmados na doc oficial
  // consultada — a referência de "criar pedido" cobre POST/GET /orders, mas não
  // traga a de cancelamento/estorno. Estão centralizados aqui para o ajuste ser
  // de uma linha quando o sandbox responder.
  //
  // Omitir essa validação é seguro por construção: o estado local SÓ muda por
  // webhook (evento `charge.refunded`/`order.canceled`) ou por reconciliação, e
  // `cancel`/`refund` apenas pedem a operação. Então um path errado aparece
  // como "estorno não happen" e o ciclo de reconciliação repregunta — não como
  // dinheiro estornado sem o PDV saber.
  cancelUrl: (orderId: string) => `${pagarmeConfig.baseUrl}/orders/${orderId}/cancel`,
  refundUrl: (orderId: string) => `${pagarmeConfig.baseUrl}/orders/${orderId}/refunds`,
};

/**
 * Integração só opera com o opt-in DUPLO: o toggle do gerente
 * (`store_settings.pagarme_enabled`, lido pela aplicação) E a credencial aqui.
 * A parte do toggle é lida na aplicação porque vem do banco; esta função cuida
 * só do que é de env.
 */
export function isPagarmeEnabled(): boolean {
  if (pagarmeConfig.mock) return true; // mock roda sem credencial real
  if (!pagarmeConfig.enabled) return false;
  return Boolean(pagarmeConfig.secretKey);
}

export function isPagarmeMock(): boolean {
  return pagarmeConfig.mock;
}