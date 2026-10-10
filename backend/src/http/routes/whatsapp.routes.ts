import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  applyStatusUpdateUsecase,
  completeEmbeddedSignupUsecase,
  disconnectWhatsAppUsecase,
  getWhatsAppSignupConfigUsecase,
  getWhatsAppStatusUsecase,
  listRecentMessagesUsecase,
} from "../../application/whatsapp/whatsapp.usecases.js";
import { config } from "../../config/env.js";

/**
 * Painel do gerente do WhatsApp (Embedded Signup) — só gerente, mesmo
 * padrão de ifood.routes.ts. Ver docs/10-whatsapp-embedded-signup.md.
 */
const exchangeSchema = z.object({
  // Code de autorização do Embedded Signup: uso único, TTL de 30s. É
  // string e não number porque a Meta devolve uma string opaca.
  code: z.string().min(10).max(2048),
  // Do postMessage WA_EMBEDDED_SIGNUP. wabaId é o que o servidor pede
  // pro debug_token; os outros são o que o postMessage traz e podem vir
  // ausentes — o backend descobre phone_number_id sozinho nesse caso.
  wabaId: z.string().min(1).max(64).optional().nullable(),
  phoneNumberId: z.string().min(1).max(64).optional().nullable(),
  businessId: z.string().min(1).max(64).optional().nullable(),
  businessName: z.string().min(1).max(255).optional().nullable(),
});

export async function whatsappRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);
  app.addHook("preHandler", requireRole("manager"));

  // Estado da conexão. NUNCA inclui o access_token.
  app.get("/whatsapp/status", async () => getWhatsAppStatusUsecase());

  // O que o browser precisa pra montar o FB.login. Só valor público:
  // app id e o config id do Builder não são segredo (o segredo é o
  // app_secret, que nunca sai do backend).
  app.get("/whatsapp/config", async () => getWhatsAppSignupConfigUsecase());

  // Fecha o Embedded Signup: troca o code, valida escopos, registra o
  // número e assina os webhooks. Idempotente do lado do Embedded Signup
  // (reconectar a mesma WABA atualiza a linha), mas o CODE é de uso
  // único — retry precisa de um code novo.
  app.post("/whatsapp/embedded-signup/exchange", async (req) => {
    const body = exchangeSchema.parse(req.body);
    return completeEmbeddedSignupUsecase({
      code: body.code,
      wabaId: body.wabaId ?? null,
      phoneNumberId: body.phoneNumberId ?? null,
      businessId: body.businessId ?? null,
      businessName: body.businessName ?? null,
      userId: req.authUser!.sub,
    });
  });

  // Desconectar apaga o token — é o que impede chamadas futuras com ele.
  app.post("/whatsapp/disconnect", async (req) => disconnectWhatsAppUsecase(req.authUser!.sub));

  // Histórico de mensagens enviadas, com o status que a Meta reportou.
  app.get("/whatsapp/messages", async (req) => {
    const q = req.query as { limit?: string };
    const parsed = Number(q.limit ?? 50);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return listRecentMessagesUsecase(limit);
  });

  // --- Rotas do provider Baileys (socket / WhatsApp Web) ---

  /**
   * GET /whatsapp/socket/status
   * Retorna o estado da sessão de socket (nunca inclui credenciais).
   * Só funciona quando WHATSAPP_PROVIDER=baileys.
   */
  app.get("/whatsapp/socket/status", () => {
    if (config.whatsappProvider !== "baileys") {
      return { error: "whatsapp_socket_not_enabled" };
    }
    // TODO: Em produção, consultaríamos o banco (getActiveConnection).
    // Por enquanto, retornamos estrutura esperada pelo frontend.
    return {
      provider: "baileys",
      connected: false,
      phone: null,
      linkedAt: null,
      lastSeenAt: null,
      lastError: null,
    };
  });

  /**
   * POST /whatsapp/socket/connect
   * Cria/retoma o cliente Baileys. Aguarda credenciais (QR/código).
   * 409 whatsapp_socket_not_enabled quando o provider não for baileys.
   */
  app.post("/whatsapp/socket/connect", () => {
    if (config.whatsappProvider !== "baileys") {
      return { error: "whatsapp_socket_not_enabled" };
    }
    // TODO: Implementar criação real do socket Baileys com pareamento.
    // Por enquanto retorna QR code e código de pareamento mockados.
    const qrDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/5+hHgAHggJ/IBIBJibQAAAABJRU5ErkJggg==";
    const pairingCode = "123456";
    return { qrDataUrl, pairingCode };
  });

  /**
   * POST /whatsapp/socket/disconnect
   * Encerra a sessão do servidor e apaga as credenciais.
   * 409 whatsapp_socket_not_enabled quando o provider não for baileys.
   */
  app.post("/whatsapp/socket/disconnect", () => {
    if (config.whatsappProvider !== "baileys") {
      return { error: "whatsapp_socket_not_enabled" };
    }
    // TODO: Implementar desconexão real do socket Baileys e limpeza do banco.
    return { ok: true };
  });
}

// Reexportado para os testes poderem acionar o mesmo caminho que o webhook.
export { applyStatusUpdateUsecase };