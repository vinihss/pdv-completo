import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../infra/db/client.js";
import { stores, storeSettings, auditLog } from "../../infra/db/schema.js";
import { eq } from "drizzle-orm";
import { Errors } from "../../domain/errors.js";

/**
 * Payload mínimo do webhook do Pagar.me para validação.
 * O Pagar.me envia mais campos, mas só precisamos do essencial.
 */
const pagarmeWebhookSchema = z.object({
  id: z.string(), // id do evento no Pagar.me
  type: z.string(), // ex: order.paid, recipient.active, recipient.rejected
  data: z.any(), // payload real do evento
});

export async function pagarmeWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/pagarme", async (req, reply) => {
    // ---------- 1. Validar assinatura (simplificada) ----------
    // O Pagar.me usa HMAC SHA256 com a chave do merchant (não a API key).
    // Para este projeto, vamos fazer uma validação mínima: se a loja tem
    // configurado o webhook, avançamos; caso contrário, apenas logamos.
    // Em produção, substituir por validação real com PAGARME_WEBHOOK_SECRET.
    const webhookSecret = process.env.PAGARME_WEBHOOK_SECRET;
    if (webhookSecret) {
      const crypto = await import("node:crypto");
      const sigHeader = req.headers["x-hub-signature-256"];
      const payload = req.rawBody ?? "";
      let signatureStr: string | undefined = undefined;
      if (Array.isArray(sigHeader)) {
        signatureStr = sigHeader[0];
      } else if (typeof sigHeader === "string") {
        signatureStr = sigHeader;
      }
      if (!signatureStr) {
        req.log.warn({ storeId: req.storeId }, "Pagar.me webhook sem assinatura");
        return reply.code(401).send({ error: { code: "invalid_signature" } });
      }
      const expected = crypto
        .createHmac("sha256", webhookSecret)
        .update(payload)
        .digest("hex");
      const valid = crypto.timingSafeEqual(
        Buffer.from(signatureStr),
        Buffer.from(expected)
      );
      if (!valid) {
        req.log.warn(
          { storeId: req.storeId, signature: signatureStr },
          "Pagar.me webhook assinatura inválida"
        );
        return reply.code(401).send({ error: { code: "invalid_signature" } });
      }
    } else {
      // Sem secret configurado: apenas logamos (não bloqueamos)
      req.log.info(
        { storeId: req.storeId },
        "Pagar.me webhook recebido sem validação de assinatura (PAGARME_WEBHOOK_SECRET não definido)"
      );
    }

    // ---------- 2. Validar payload ----------
    const body = pagarmeWebhookSchema.parse(req.body);

    // ---------- 3. Idempotência básica ----------
    // O idempotency key do Pagar.me é event.id + data.reference_id (que é o storeId)
    const idempotencyKey = `pagarme:${body.id}:${req.storeId}`;
    // Em um projeto real, usaríamos um middleware de idempotência aqui.
    // Por simplificação neste exemplo, vamos confiar no processamento ser seguro.

    try {
      // ---------- 4. Tratar por tipo de evento ----------
      switch (body.type) {
        case "order.paid":
          await handleOrderPaid(req.storeId!, body.data);
          break;
        case "recipient.active":
          await handleRecipientActive(req.storeId!, body.data);
          break;
        case "recipient.rejected":
          await handleRecipientRejected(req.storeId!, body.data);
          break;
        default:
          // Outros eventos são ignorados mas ainda retornamos 200
          req.log.info(
            { storeId: req.storeId, eventType: body.type },
            "Pagar.me webhook recebido e ignorado (tipo não tratado)"
          );
      }

      return reply.code(200).send({ received: true });
    } catch (err) {
      req.log.error(
        { storeId: req.storeId, event: body.type, err },
        "Erro ao processar webhook do Pagar.me"
      );
      throw err; // deixa o handler global converter em JSON padronizado
    }
  });
}

/**
 * Lida com o evento `order.paid`:
 * - Atualiza o status da loja (ex: ativa se estava pendente)
 * - Registra no audit log (opcional)
 */
async function handleOrderPaid(storeId: string, data: any) {
  await db.transaction(async (tx) => {
    // Atualiza o status da loja para "active" se estiver pendente
    const store = await tx.query.stores.findFirst({
      where: eq(stores.id, storeId),
    });
    if (store && store.status !== "active") {
      await tx
        .update(stores)
        .set({ status: "active" })
        .where(eq(stores.id, storeId));
    }

    // Registra no audit log (opcional, mas útil para rastreabilidade)
    await tx.insert(auditLog).values({
      userId: "system", // webhook do sistema
      action: "pagarme_order_paid",
      orderId: null, // não temos order_id local aqui (seria via externalRef)
      details: JSON.stringify({
        pagarmeEventId: data.id,
        pagarmeOrderId: data.id, // assumindo que o id do evento é o id da ordem
        amount: data.amount,
        paymentMethod: data.payment_method,
        // O split vem do data.split_rules, mas não vamos armazenar aqui
        // pois o split já acontece no Pagar.me
      }),
    });
  });
}

/**
 * Lida com o evento `recipient.active`:
 * - Atualiza o status da loja para "active" no Pagar.me
 * - Registra no audit log
 */
async function handleRecipientActive(storeId: string, data: any) {
  await db.transaction(async (tx) => {
    await tx
      .update(stores)
      .set({ pagarme_status: "active" })
      .where(eq(stores.id, storeId));

    await tx.insert(auditLog).values({
      userId: "system",
      action: "pagarme_recipient_activated",
      orderId: null,
      details: JSON.stringify({
        pagarmeRecipientId: data.id,
        status: data.status,
      }),
    });
  });
}

/**
 * Lida com o evento `recipient.rejected`:
 * - Atualiza o status da loja para "rejected" no Pagar.me
 * - Registra no audit log
 */
async function handleRecipientRejected(storeId: string, data: any) {
  await db.transaction(async (tx) => {
    await tx
      .update(stores)
      .set({ pagarme_status: "rejected" })
      .where(eq(stores.id, storeId));

    await tx.insert(auditLog).values({
      userId: "system",
      action: "pagarme_recipient_rejected",
      orderId: null,
      details: JSON.stringify({
        pagarmeRecipientId: data.id,
        reason: data.reason,
      }),
    });
  });
}