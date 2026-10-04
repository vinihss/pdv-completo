/**
 * Webhook do Pagar.me (spec §9.6, §14-§16).
 *
 *     POST /webhooks/pagarme
 *
 * Sem autenticação — quem chama é o gateway, que se prova pela ASSINATURA
 * (HMAC-SHA1 do corpo cru com a secret key), não por token de sessão. Por isso
 * o corpo bruto importa: é sobre ele que a assinatura é calculada.
 *
 * ## O endpoint faz três coisas, e só três
 *
 *   1. valida a assinatura;
 *   2. grava o evento em `payment_event` (dedupe por UNIQUE (provider, event_id));
 *   3. responde 200.
 *
 * O PROCESSAMENTO é do worker (`integrations/pagarme/worker.ts`), depois do 200.
 * A spec §15 é explícita ("o endpoint deve responder rapidamente; não executar
 * operações pesadas antes de responder") e o motivo é concreto: o Pagar.me
 * reenvia o mesmo evento enquanto não recebe 200, e o boot do ciclo inteiro
 * na requisição transformaria um pico de tráfego em reenvio em massa. Gravar
 * antes do 200 é o que garante que nenhum evento se perca entre "recebi" e
 * "processei".
 *
 * ## Um evento duplicado é sucesso, não erro
 *
 * Duas respostas possíveis, ambas 200:
 *   - evento novo    → `isNew: true`, o worker vai processar;
 *   - reenvio        → `isNew: false`, devolve sem nada fazer.
 *
 * Devolver 4xx para um reenvio faria o Pagar.me reenviar indefinidamente um
 * evento que já foi tratado. A idempotência é do índice único (spec §16), não
 * de um if no código.
 *
 * ## Assinatura ausente = recusa
 *
 * Sem `PAGARME_SECRET_KEY` não há como validar, e responder 200 sem verificar
 * deixaria qualquer um marcar cobrança como paga chamando este endpoint. A
 * recusa é explícita (503), como no webhook do WhatsApp depois de corrigida a
 * validação que era pulada em silêncio.
 */
import type { FastifyInstance } from "fastify";
import { recordWebhookEventUsecase } from "../../application/payment/payment.usecases.js";
import { pagarmeConfig } from "../../integrations/pagarme/config.js";
import { verifyWebhookSignature } from "../../integrations/pagarme/webhook-signature.js";
import type { PagarmeWebhookPayload } from "../../integrations/pagarme/types.js";

export async function pagarmeWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/pagarme", async (req, reply) => {
    const secretKey = pagarmeConfig.secretKey;

    if (!secretKey) {
      req.log.error("webhook do pagarme sem PAGARME_SECRET_KEY — recusando");
      return reply.code(503).send({ error: { code: "pagarme_not_configured" } });
    }

    // `req.rawBody` é o corpo CRU preservado pelo content type parser de
    // http/server.ts. A assinatura é sobre ele — re-serializar o objeto
    // parseado muda espaçamento/chave e a HMAC não bateria.
    const rawBody = (req as { rawBody?: string }).rawBody ?? "";
    const signature = req.headers["x-hub-signature"] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature, secretKey)) {
      // 401 e não 200: quem não se provou não muda estado. E também não pode
      // descobrir se o endpoint existe.
      return reply.code(401).send({ error: { code: "invalid_signature" } });
    }

    let payload: PagarmeWebhookPayload;
    try {
      payload = (typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : req.body) as PagarmeWebhookPayload;
    } catch {
      return reply.code(400).send({ error: { code: "validation_failed", message: "corpo não é JSON." } });
    }

    try {
      const { isNew } = await recordWebhookEventUsecase(payload, String(req.id ?? ""));
      req.log.info(
        { eventId: payload.id, eventType: payload.type, isNew },
        isNew ? "evento do pagarme gravado" : "evento do pagarme repetido — ignorado"
      );
      // 200 nos dois casos. O processamento é do worker.
      return reply.code(200).send({ received: true });
    } catch (err) {
      // Aqui só falha coisa de infraestrutura (banco fora) ou evento sem id.
      // Devolver 5xx faz o Pagar.me reenviar, que é o comportamento correto
      // para "não consegui persistir" — diferente de "persisti e não achei
      // correspondente", que é 200 com `ignored`.
      req.log.error({ err, eventId: payload.id }, "falha ao gravar evento do pagarme");
      return reply.code(503).send({ error: { code: "service_unavailable" } });
    }
  });
}