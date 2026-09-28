import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { listAlertsUsecase, markAlertsReadUsecase } from "../../application/alert/alert.usecases.js";

// Central de alertas (migration 0004). Sem `requireRole`: os 5 perfis têm o sino
// no header, e quem não pode ver um alerta não o recebe — o recorte é por
// `audience_roles` dentro do usecase, não por papel na rota. Um
// `requireRole("manager")` aqui faria o sino sumir do garçom e do entregador,
// que continuam prontos para qualquer alerta futuro que os coloque na audiência;
// e abrir para todos não expõe nada, porque a lista é filtrada no usecase.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const markReadSchema = z.object({ orderId: z.string().min(1).optional() });

export async function alertRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // `unread_only` é para o futuro "mostrar só o que falta"; o sino pede a
  // lista inteira (quer mostrar as lidas também, com a diferença de estilo).
  app.get("/alerts", async (req) => {
    const q = req.query as { limit?: string; unread_only?: string };
    const parsed = z.coerce.number().int().min(1).max(MAX_LIMIT).optional().parse(q.limit);
    return listAlertsUsecase({
      role: req.authUser!.role,
      limit: parsed ?? DEFAULT_LIMIT,
      unreadOnly: q.unread_only === "true" || q.unread_only === "1",
    });
  });

  // Com `orderId` é a regra "a tela da comanda foi vista, desmarca"; sem ele, o
  // "marcar todas como lidas" do sino.
  app.post("/alerts/mark-read", async (req) => {
    const body = markReadSchema.parse(req.body ?? {});
    return markAlertsReadUsecase({ role: req.authUser!.role, orderId: body.orderId });
  });
}
