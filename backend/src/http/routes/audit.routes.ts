/**
 * Rotas do log de auditoria (ferramenta do gerente).
 *
 * Endpoints:
 *   GET    /audit-log — listar logs de auditoria (manager)
 *
 * Use cases: `backend/src/application/audit-log.usecases.ts`
 */
import type { FastifyInstance } from "fastify";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { listAuditLogUsecase } from "../../infra/composition/default-usecases.js";

export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Audit log ----------
  // Especificado como ferramenta do gerente — garçom não consulta o log global
  // (o histórico da própria comanda dele é outra concernência, ver spec §4.4.1).
  app.get("/audit-log", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { order_id?: string; limit?: string; offset?: string };
    return listAuditLogUsecase({
      orderId: q.order_id,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
}
