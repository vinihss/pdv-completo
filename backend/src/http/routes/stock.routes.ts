/**
 * Rotas de estoque (inventário): saldo pelo ledger, histórico de movimentos,
 * movimento manual e valorização.
 *
 * Endpoints:
 *   GET    /stock                     — listar estoque (manager)
 *   GET    /stock/movements           — listar movimentos (manager)
 *   POST   /stock/:productId/movements — movimento manual (manager)
 *   GET    /inventory/value           — valorização do estoque (manager)
 *
 * Use cases: `backend/src/application/stock/stock.usecases.ts`
 *            (`inventory/value` vem de `application/purchase/purchase.usecases.ts`)
 * Testes: `backend/test/` (stock)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
  listStockUsecase,
  getStockMovementsUsecase,
  registerStockMovementUsecase,
  inventoryValuationUsecase,
} from "../../infra/composition/domains/stock.js";
import { withIdempotency } from "../middlewares/idempotency.middleware.js";

// Movimento manual de estoque — manager. purchase: entrada (+qty);
// adjustment: contagem/ajuste (Δ sinalizado, ex. -2 sobra de perda).
const stockMovementCreateSchema = z.object({
  type: z.enum(["purchase", "adjustment"]),
  quantity: z.number(),
  note: z.string().optional().nullable(),
  correlationId: z.string().min(1),
});

export async function stockRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ---------- Stock (inventário) ----------
  // Listagem: apenas produtos com trackStock; ?low_only=true filtra só os
  // abaixo do threshold. O saldo vem do ledger (soma dos deltas).
  app.get("/stock", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { low_only?: string; q?: string; limit?: string; offset?: string };
    return listStockUsecase({
      lowOnly: q.low_only === "true",
      search: q.q,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  // Histórico de movimentos — ?product_id filtra por produto.
  app.get("/stock/movements", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { product_id?: string; limit?: string; offset?: string };
    return getStockMovementsUsecase({
      productId: q.product_id,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
  // Movimento manual (compra / ajuste) — idempotente, registra audit.
  app.post("/stock/:productId/movements", { preHandler: requireRole("manager") }, async (req) => {
    const body = stockMovementCreateSchema.parse(req.body);
    return withIdempotency(`POST /stock/${(req.params as { productId: string }).productId}/movements`, body.correlationId, body, async () => {
      const movement = await registerStockMovementUsecase({
        productId: (req.params as { productId: string }).productId,
        type: body.type,
        quantity: body.quantity,
        note: body.note ?? undefined,
        userId: req.authUser!.sub,
      });
      return { status: 200, body: movement };
    }).then((r) => r.body);
  });

  // ---------- Valorização do estoque (baseline 0001) ----------
  app.get("/inventory/value", { preHandler: requireRole("manager") }, async (req) => {
    const q = req.query as { q?: string; low_only?: string; limit?: string; offset?: string };
    return inventoryValuationUsecase({
      search: q.q,
      lowOnly: q.low_only === "true",
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });
}
