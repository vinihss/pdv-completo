import type { FastifyInstance } from "fastify";
import {
  extractAllIncomingMessages,
  extractAllStatusUpdates,
  verifyWebhookSignature,
  type WhatsAppWebhookPayload,
} from "../../integrations/whatsapp/webhook-payload.js";
import { sendTextMessage } from "../../integrations/whatsapp/whatsapp.client.js";
import { hasAppSecret, whatsappConfig } from "../../integrations/whatsapp/config.js";
import {
  claimInboundMessage,
  getActiveConnection,
  getConnectionByPhoneNumberId,
  isTokenExpired,
  recordOutboundMessage,
  setConnectionStatus,
} from "../../integrations/whatsapp/state.js";
import { applyStatusUpdateUsecase } from "../../application/whatsapp/whatsapp.usecases.js";
import { handleIncomingWhatsAppMessage } from "../../application/self-service/whatsapp-bot.usecases.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Escolhe a conexão de uma mensagem recebida.
 *
 * Com `phoneNumberId`, é a WABA exata daquele número. Sem ele, a conexão
 * ativa — e como só há uma ativa por instalação, a resposta é a mesma.
 * Se o número vier e NÃO corresponder a nada, não cai para a ativa: isso
 * seria responder na WABA errada.
 */
async function resolveConnectionFor(phoneNumberId: string | null) {
  if (phoneNumberId) {
    // Só a WABA correspondente vale. Se não bater, NÃO chutar a ativa:
    // o número pode ser de outra instalação usando este mesmo webhook
    // (mesmo app secret), e responder ali seria mandar a mensagem para a
    // WABA errada.
    return getConnectionByPhoneNumberId(phoneNumberId);
  }
  return getActiveConnection();
}

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  // Handshake de verificação exigido pela Meta na primeira configuração do
  // webhook — GET com hub.mode/hub.verify_token/hub.challenge.
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    // Sem verify token configurado não há como validar: 403 explícito, e
    // não "comparar com undefined" (que aprovaria qualquer handshake).
    if (!whatsappConfig.verifyToken) return reply.code(403).send("verification not configured");
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === whatsappConfig.verifyToken) {
      return reply.code(200).send(q["hub.challenge"]); // valor cru, sem JSON — a Meta exige exatamente isso
    }
    return reply.code(403).send("verification failed");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    // ---------- assinatura ----------
    // Sem app secret não dá para validar, e responder 200 sem verificar
    // deixaria o PDV aceitar mensagem forjada. Antes isso passava
    // silenciosamente (o `if` era pulado); agora é erro explícito.
    if (!hasAppSecret()) {
      req.log.error("webhook do whatsapp sem META_APP_SECRET — recusando");
      return reply.code(503).send({ error: { code: "whatsapp_app_secret_missing" } });
    }
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const valid = verifyWebhookSignature(req.rawBody ?? "", signature, whatsappConfig.appSecret!);
    if (!valid) return reply.code(401).send({ error: { code: "invalid_signature" } });

    // Meta espera 200 rápido — reenvia por até 7 dias se não receber isso,
    // então não vale a pena atrasar a resposta esperando o envio da réplica.
    // Tudo abaixo roda fire-and-forget.
    const payload = (req.body ?? {}) as WhatsAppWebhookPayload;

    // ---------- 1. status de mensagens que NOS Enviamos ----------
    const statusUpdates = extractAllStatusUpdates(payload);
    if (statusUpdates.length > 0) {
      applyStatusUpdateUsecase(statusUpdates).catch((err) =>
        req.log.error(err, "erro aplicando status de mensagem do whatsapp")
      );
    }

    // ---------- 2. mensagens recebidas ----------
    // O lote inteiro, não só a primeira: a Meta agrupa vários `entry`
    // num POST e o código anterior (entry[0].changes[0]...messages[0])
    // descartava o resto em silêncio.
    const incoming = extractAllIncomingMessages(payload);
    for (const message of incoming) {
      // Rota por WABA: o phone_number_id do payload diz de quem é a
      // mensagem, porque o token é por WABA. Sem ele (payload sem
      // metadata) cai na conexão ativa — que é única por instalação
      // (uq_whatsapp_single_active), então a escolha continua correta.
      resolveConnectionFor(message.phoneNumberId)
        .then(async (conn) => {
          if (!conn) {
            // Sem conexão, não há token para responder. Registrar e seguir:
            // devolver 4xx/5xx faria a Meta reenviar por ~7 dias um
            // payload que nunca vai ser processável.
            req.log.warn(
              { phoneNumberId: message.phoneNumberId },
              "mensagem de uma WABA não conectada — ignorada"
            );
            return;
          }

          if (isTokenExpired(conn)) {
            // Token expirado: o status reflete o problema para o gerente
            // ver na aba, em vez de cada mensagem falhar silenciosa.
            await setConnectionStatus(conn.wabaId, "expired", "Token expirado — reconecte o WhatsApp.");
            req.log.warn({ wabaId: conn.wabaId }, "mensagem recebida com token expirado");
            return;
          }

          // Dedupe: a Meta reenvia o mesmo webhook até receber 200. O
          // INSERT é a reserva — claimInboundMessage devolve false se o
          // wamid já foi visto, e aí não processa de novo.
          if (message.messageId) {
            const isNew = await claimInboundMessage({
              wamid: message.messageId,
              wabaId: conn.wabaId,
              fromPhone: message.phone,
              type: message.type,
            });
            if (!isNew) {
              req.log.info({ wamid: message.messageId }, "mensagem repetida do whatsapp — ignorada");
              return;
            }
          }

          const { replyText } = await handleIncomingWhatsAppMessage(
            message.phone,
            message.text,
            message.location,
            conn.wabaId
          );
          const sent = await sendTextMessage(message.phone, replyText);
          // `sent.wabaId` é vazio no caminho legado (token de env, sem WABA
          // no banco) — nesse caso não há linha para gravar, porque a FK
          // de whatsapp_outbound_message aponta pra whatsapp_connection.
          if (sent && sent.wabaId) {
            await recordOutboundMessage({
              wamid: sent.wamid,
              wabaId: conn.wabaId,
              toPhone: message.phone,
              kind: "bot_reply",
              orderId: null,
            });
          }
        })
        .catch((err) => req.log.error(err, "erro processando mensagem do whatsapp"));
    }

    return reply.code(200).send({ received: true });
  });
}
