/**
 * Rotas de relatórios gerenciais.
 *
 * Endpoints:
 *   GET    /reports/sales      — relatório de vendas (manager)
 *   GET    /reports/overview   — visão geral: vendas por período (manager)
 *   GET    /reports/deliveries — relatório de entregas (manager)
 *
 * Use cases: `backend/src/application/` (report, report-overview, report-deliveries)
 */
import type { FastifyInstance } from "fastify";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import { salesReportUsecase } from "../../infra/composition/domains/reports.js";
import { overviewReportUsecase } from "../../infra/composition/domains/reports.js";
import { deliveriesReportUsecase } from "../../infra/composition/domains/reports.js";

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Reports ----------
  app.get("/reports/sales", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as {
      dateFrom?: string;
      dateTo?: string;
      customerQuery?: string;
      productId?: string;
      limit?: string;
      offset?: string;
    };
    return salesReportUsecase({
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      customerQuery: q.customerQuery,
      productId: q.productId,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });

  // Visão geral: a mesma regra de venda de /reports/sales (comandas fechadas,
  // total pelos itens no snapshot + taxa), só que agrupada por período para o
  // gráfico. Ver `report-overview.usecases.ts` para por que os dois números
  // precisam bater.
  app.get("/reports/overview", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { from?: string; to?: string; groupBy?: string; tz?: string };
    return overviewReportUsecase({
      from: q.from,
      to: q.to,
      groupBy:
        q.groupBy === "hour" || q.groupBy === "week" || q.groupBy === "month" || q.groupBy === "day"
          ? (q.groupBy as "hour" | "day" | "week" | "month")
          : "day",
      tz: q.tz,
    });
  });

  // Relatório de entregas: volume, no-prazo e tempo médio, sobre as mesmas
  // comandas fechadas do relatório de vendas (ver report-deliveries.usecases.ts).
  app.get("/reports/deliveries", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { from?: string; to?: string; tz?: string };
    return deliveriesReportUsecase({ from: q.from, to: q.to, tz: q.tz });
  });
}
