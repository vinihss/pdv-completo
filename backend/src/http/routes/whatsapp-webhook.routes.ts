import type { FastifyInstance } from "fastify";
import { config } from "../../config/env.js";
import { extractIncomingMessage, verifyWebhookSignature } from "../../integrations/whatsapp/webhook-payload.js";
import { sendTextMessage } from "../../integrations/whatsapp/whatsapp.client.js";
import { handleIncomingWhatsAppMessage } from "../../application/self-service/whatsapp-bot.usecases.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  // Handshake de verificação exigido pela Meta na primeira configuração do
  // webhook — GET com hub.mode/hub.verify_token/hub.challenge.
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.whatsappVerifyToken) {
      return reply.code(200).send(q["hub.challenge"]); // valor cru, sem JSON — a Meta exige exatamente isso
    }
    return reply.code(403).send("verification failed");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    if (config.whatsappAppSecret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const valid = verifyWebhookSignature(req.rawBody ?? "", signature, config.whatsappAppSecret);
      if (!valid) return reply.code(401).send({ error: { code: "invalid_signature" } });
    }

    const incoming = extractIncomingMessage(req.body as any);
    if (incoming) {
      handleIncomingWhatsAppMessage(incoming.phone, incoming.text)
        .then(({ replyText }) => sendTextMessage(incoming.phone, replyText))
        .catch((err) => req.log.error(err, "erro processando mensagem do whatsapp"));
    }

    // Meta espera 200 rápido — reenvia por até 7 dias se não receber isso,
    // então não vale a pena atrasar a resposta esperando o envio da réplica.
    return reply.code(200).send({ received: true });
  });
}
