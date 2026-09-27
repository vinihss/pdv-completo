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
}

// Reexportado para os testes poderem acionar o mesmo caminho que o webhook.
export { applyStatusUpdateUsecase };
